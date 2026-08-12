# PostgreSQL Internals

How Postgres actually stores rows, orders concurrent writers, and keeps a replica in sync underneath `psql` — storage layout, MVCC and vacuum, WAL and replication durability, connection pooling, and where the query planner's cost model can go wrong.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Storage Architecture

```mermaid
graph TD
    classDef proc fill:#2c3e50,stroke:#1a252f,color:#fff,rx:6
    classDef mem fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef wal fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef disk fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6
    classDef bg fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6

    CLIENT["Client connection"] --> PROC["Backend process<br/>one forked per connection<br/>~10MB RSS each"]:::proc

    subgraph SHMEM["Shared Memory — shared across every backend"]
        BP["Buffer Pool (shared_buffers)<br/>8KB pages, clock-sweep eviction<br/>cache of heap/index pages"]:::mem
        WAL_BUF["WAL Buffers (wal_buffers)<br/>staging area before fsync"]:::wal
        LOCK["Lock table<br/>row-level, table-level, advisory"]:::mem
    end

    PROC -->|"read / modify page"| BP
    PROC -->|"append WAL record<br/>before touching the page"| WAL_BUF
    PROC -.->|"acquire before touching<br/>a row / table"| LOCK

    subgraph BGPROC["Background processes"]
        BGWRITER["bgwriter<br/>trickles dirty pages out early<br/>so checkpoints have less to flush"]:::bg
        CHECKPOINTER["checkpointer<br/>runs every checkpoint_timeout<br/>or max_wal_size worth of WAL"]:::bg
        WALWRITER["wal writer<br/>flushes WAL buffers on a timer,<br/>independent of any one COMMIT"]:::bg
    end

    BP -.->|"dirty pages"| BGWRITER --> HEAP
    BP -->|"flush all dirty pages"| CHECKPOINTER --> HEAP
    WAL_BUF --> WALWRITER --> WAL_FILES

    subgraph DISK["Disk"]
        HEAP["Heap files<br/>base/16384/12345<br/>8KB pages, unordered rows"]:::disk
        IDX["Index files<br/>B-tree, GiST, GIN, BRIN"]:::disk
        WAL_FILES["WAL segment files<br/>pg_wal/*.wal<br/>16MB each, sequential writes"]:::wal
        TOAST["TOAST files<br/>columns > 2KB stored separately"]:::disk
    end

    CHECKPOINTER -.->|"WAL before this point<br/>can now be recycled"| WAL_FILES
    HEAP -.-> IDX
    HEAP -.-> TOAST
```

The key thing this diagram makes explicit: a backend never writes straight to the heap file on disk. It modifies the page in the shared buffer pool and appends a WAL record — both in memory — and returns to the client once the WAL record is durable. Getting the actual heap page onto disk is a separate, asynchronous job handled by `bgwriter` (proactively, to keep checkpoints cheap) and the `checkpointer` (on its own schedule), decoupled from any single transaction's commit.

<div class="quiz-card">
  <p class="quiz-q">A backend process modifies a page in the buffer pool during an UPDATE. Does that change need to reach the heap file on disk before COMMIT can return to the client?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The durability boundary is the WAL record, not the heap page. As long as the WAL record for that change is flushed to pg_wal/, COMMIT can return — the modified buffer-pool page itself gets written to the heap file later, asynchronously, by bgwriter or the checkpointer. Crash recovery replays the WAL to reconstruct any page that hadn't made it to disk yet.</div>
</div>

---

## WAL — Write-Ahead Log in Detail

Every modification (INSERT, UPDATE, DELETE) writes a WAL record before the data page is changed.

```mermaid
sequenceDiagram
    participant TX as Transaction
    participant BP as Buffer Pool
    participant WALBUF as WAL Buffer
    participant WALDISK as WAL files (pg_wal/)
    participant CKPT as Checkpointer
    participant DF as Data files (heap)

    TX->>BP: UPDATE row → modify page in buffer pool (in memory only)
    TX->>WALBUF: Write WAL record {LSN, relation, block, old tuple, new tuple}
    Note over WALBUF,WALDISK: synchronous_commit = on
    WALBUF->>WALDISK: fsync WAL to disk before COMMIT is allowed to return
    WALDISK-->>TX: fsync confirmed
    TX-->>TX: COMMIT returns to client

    rect rgb(40, 60, 45)
    Note over BP,DF: Asynchronous — runs on its own schedule, not per-COMMIT
    loop every checkpoint_timeout (default 5min) or max_wal_size worth of WAL
        CKPT->>BP: request all dirty pages
        BP->>DF: flush dirty pages to heap files
        CKPT->>WALDISK: mark WAL segments before this point as recyclable
    end
    end
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Modify the page in memory.</strong> The backend changes the page inside the shared buffer pool. Nothing has touched disk yet.
    </div>
    <div class="stepper-panel">
      <strong>2. Write and fsync the WAL record.</strong> The WAL record for that change is appended to the WAL buffer and, with <code>synchronous_commit = on</code>, fsynced to <code>pg_wal/</code> before COMMIT is allowed to return. This — not the heap page — is the actual durability point.
    </div>
    <div class="stepper-panel">
      <strong>3. COMMIT returns.</strong> The client sees success once the WAL record is durable on disk, even though the modified heap page may still exist only in memory.
    </div>
    <div class="stepper-panel">
      <strong>4. Checkpoint catches up later.</strong> On its own schedule (<code>checkpoint_timeout</code> or <code>max_wal_size</code>), the checkpointer flushes dirty pages to the heap files. Only after that can the WAL segments covering those changes be recycled — this side is fully decoupled from any one transaction.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**LSN (Log Sequence Number):** 64-bit monotonically increasing number. Every WAL record has an LSN. Replicas track which LSN they've replayed — this is the replication lag.

```sql
-- Check current WAL position
SELECT pg_current_wal_lsn();

-- Check replication lag
SELECT
    client_addr,
    sent_lsn - replay_lsn AS lag_bytes,
    EXTRACT(EPOCH FROM (now() - replay_lag)) AS lag_seconds
FROM pg_stat_replication;
```

<div class="quiz-card">
  <p class="quiz-q">A backend commits with synchronous_commit = on, and the server crashes 3 minutes later — before the next checkpoint runs. Is the committed row lost?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The WAL record for that change was already fsynced to disk before COMMIT returned, regardless of whether the modified heap page itself had been flushed by the checkpointer yet. On restart, PostgreSQL replays WAL records after the last checkpoint to reconstruct any page that wasn't flushed in time — the checkpoint is a durability floor, not the only path to durability.</div>
</div>

---

## MVCC — How PostgreSQL Handles Concurrent Reads/Writes

PostgreSQL never overwrites a row in place. Every UPDATE creates a new row version.

```mermaid
graph TD
    classDef dead fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6
    classDef live fill:#27ae60,stroke:#1e8449,color:#fff,rx:6
    classDef reader fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef writer fill:#e74c3c,stroke:#c0392b,color:#fff,rx:6

    subgraph HEAP["Table heap page — same logical row, two physical tuple versions"]
        V1["Tuple version 1<br/>xmin=100 xmax=200<br/>name='Alice'<br/>visible when xmin&lt;=snap&lt;xmax"]:::dead
        V2["Tuple version 2<br/>xmin=200 xmax=NULL<br/>name='Bob'<br/>visible when snap&gt;=200"]:::live
    end

    TX200["Transaction 200 (writer)<br/>UPDATE ... SET name='Bob'<br/>sets xmax=200 on V1, inserts V2"]:::writer
    TX200 -.->|"marks old version dead<br/>(not deleted yet)"| V1
    TX200 -.->|"inserts new version"| V2

    TX150["Transaction 150 (reader)<br/>snapshot xid = 150"]:::reader
    TX250["Transaction 250 (reader)<br/>snapshot xid = 250"]:::reader

    V1 -->|"100&lt;=150&lt;200 → visible"| TX150
    V2 -->|"200&lt;=250 → visible"| TX250

    V1 -.->|"eventually reclaimed by"| VACUUM["VACUUM<br/>marks dead tuple space reusable<br/>once no snapshot can see it"]:::dead
```

**xmin/xmax system columns:**
- `xmin`: transaction ID that created this tuple version
- `xmax`: transaction ID that deleted/updated this tuple (NULL = still live)
- A tuple is visible if `xmin <= my_snapshot_xid < xmax`

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Snapshot taken.</strong> When a transaction starts (or per-statement, depending on isolation level), Postgres records a snapshot xid — that number is what "visible" gets measured against for everything this transaction reads.
    </div>
    <div class="stepper-panel">
      <strong>2. Check xmin.</strong> A tuple is only a candidate if its creating transaction (xmin) is <code>&lt;= my_snapshot_xid</code> — otherwise, as far as this reader is concerned, the row didn't exist yet.
    </div>
    <div class="stepper-panel">
      <strong>3. Check xmax.</strong> If xmax is NULL, the tuple is still live and passes. If xmax is set, the tuple is invisible only once the snapshot xid is also <code>&gt;= xmax</code> — a reader with an older snapshot number can still legitimately see a row that's since been updated.
    </div>
    <div class="stepper-panel">
      <strong>4. Exactly one version resolves.</strong> For any given snapshot xid, exactly one tuple version satisfies both checks. That's why two concurrent readers can look at the same logical row and correctly see two different values at the same instant — visibility is arithmetic on transaction IDs, not a lock.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Dead tuples:** Old versions accumulate. `VACUUM` marks them as free space. `VACUUM FULL` rewrites the table (locks table, reclaims disk).

```sql
-- Check table bloat
SELECT
    relname,
    n_dead_tup,
    n_live_tup,
    round(n_dead_tup::numeric/NULLIF(n_live_tup+n_dead_tup,0)*100, 2) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;

-- Force vacuum
VACUUM ANALYZE my_table;
VACUUM VERBOSE my_table;  -- shows what it freed
```

<div class="quiz-card">
  <p class="quiz-q">Using the visibility rule above — could a transaction with snapshot xid 150 ever see tuple version 2, which has xmin=200?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The rule requires xmin &lt;= my_snapshot_xid, and 200 is not &lt;= 150. V2 can never be visible to a snapshot taken at 150, regardless of wall-clock timing — visibility is purely a function of transaction ID ordering, not when either transaction actually happened to run.</div>
</div>

---

## Replication — Sync vs Async in Detail

```mermaid
sequenceDiagram
    participant APP as Application
    participant PRI as Primary (postgres-0)
    participant WAL_SEND as WAL Sender process
    participant WAL_RECV as WAL Receiver (replica)
    participant REP as Replica (postgres-1)

    APP->>PRI: BEGIN, UPDATE orders SET status='paid', COMMIT
    PRI->>PRI: Write WAL record to WAL buffer
    PRI->>PRI: Flush WAL to disk (always, for durability)

    rect rgb(40, 55, 75)
    Note over PRI,REP: ASYNC replication (default — synchronous_standby_names unset)
    PRI-->>APP: COMMIT returns immediately
    PRI->>WAL_SEND: Stream WAL to replica (best effort)
    WAL_SEND->>WAL_RECV: WAL data
    WAL_RECV->>REP: Apply WAL records
    Note over REP: Replica may be 0ms to minutes behind
    end

    rect rgb(65, 50, 30)
    Note over PRI,REP: SYNC replication (synchronous_standby_names set)
    PRI->>WAL_SEND: Wait for replica ACK before returning to app
    WAL_SEND->>WAL_RECV: WAL data
    WAL_RECV->>WAL_RECV: Write to replica's WAL (flush to disk)
    WAL_RECV-->>WAL_SEND: ACK (flushed)
    WAL_SEND-->>PRI: Replica confirmed
    PRI-->>APP: COMMIT returns
    Note over REP: Data guaranteed on at least 2 disks before client sees commit
    end
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="async" class="active state-warn">Async replication (default)</button>
    <button data-toggle-opt="sync" class="state-ok">Sync replication</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="async">
    COMMIT returns to the app as soon as the WAL is flushed on the primary — it never waits for a replica. Lowest latency, but if the primary dies before a replica caught up to that LSN, whatever it hadn't replicated yet is gone for good.
  </div>
  <div class="toggle-panel" data-toggle-panel="sync">
    COMMIT blocks until at least one standby named in <code>synchronous_standby_names</code> acknowledges the WAL, per whatever <code>synchronous_commit</code> level is configured. Guarantees the committed data exists on a second disk before the client ever sees success — at the cost of one extra network round-trip per commit.
  </div>
</div>

**Synchronous commit levels (granular control):**

```sql
-- Per-transaction override
SET synchronous_commit = 'remote_write';  -- stronger than off, weaker than on

-- Levels:
-- off          → WAL not even flushed locally (fastest, risk data loss on crash)
-- local        → WAL flushed locally only (default)
-- remote_write → replica received WAL in its OS buffer (not fsynced yet)
-- remote_apply → replica has replayed WAL and applied changes
-- on           → replica WAL flushed to disk (same as remote_apply for most uses)
```

| Level | Data loss on primary crash | Write latency |
|-------|--------------------------|---------------|
| `off` | Up to wal_writer_delay (200ms) | Fastest |
| `local` | No local loss, yes if replica needed | Normal |
| `remote_write` | No — replica has it in memory | +0.5× RTT |
| `on` / `remote_apply` | Zero — replica has it on disk | +1× RTT |

<div class="quiz-card">
  <p class="quiz-q">Does synchronous_commit = 'remote_write' guarantee the replica has the committed data durably on disk?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. remote_write only means the replica's OS received the WAL data into its buffer — not that it fsynced it. If the replica's OS crashes (not just Postgres) before that buffer is flushed, the data can still be lost even though the primary already returned success. Only remote_apply (or on) waits for the replica to actually flush to disk before the primary returns commit.</div>
</div>

---

## Indexes

```mermaid
graph TD
    classDef btree fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef gin fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef brin fill:#16a085,stroke:#117a65,color:#fff,rx:6

    subgraph BTG["B-tree (default)"]
        B["Root node"]:::btree --> L["Leaf nodes<br/>sorted keys + heap pointers<br/>O(log n) lookup, range scans"]:::btree
    end
    subgraph GING["GIN — Generalized Inverted Index"]
        G["Inverted index<br/>key → set of heap locations<br/>Used for: full-text search, jsonb, arrays"]:::gin
    end
    subgraph BRING["BRIN — Block Range Index"]
        BR["Min/max per block range<br/>Tiny index, good for sequential data<br/>timestamps, auto-increment IDs"]:::brin
    end
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="btree" class="active">B-tree</button>
    <button data-tab="gin">GIN</button>
    <button data-tab="brin">BRIN</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="btree">
      <strong>Default, general-purpose.</strong> A sorted tree of keys pointing at heap rows. Handles equality and range predicates (<code>&lt;</code>, <code>&gt;</code>, <code>BETWEEN</code>) in O(log n), and can satisfy an <code>ORDER BY</code> without a separate sort. Cost: a full copy of the indexed column(s), and every write also updates the tree.
    </div>
    <div class="tab-panel" data-tab-panel="gin">
      <strong>Inverted index, for "this row contains this value."</strong> Maps each individual key — a word, a jsonb key/value pair, an array element — to the set of rows containing it. Built for full-text search, jsonb containment, and array membership: queries a B-tree can't answer efficiently because the interesting value is buried inside a composite column, not the column itself.
    </div>
    <div class="tab-panel" data-tab-panel="brin">
      <strong>Block Range Index — tiny, for naturally sorted data.</strong> Stores only a min/max per block range instead of an entry per row. Only effective when the column correlates with physical insertion order — timestamps and auto-incrementing IDs on an append-only table — because that correlation is what lets whole block ranges be skipped based on two numbers.
    </div>
  </div>
</div>

```sql
-- B-tree (default): equality + range on most types
CREATE INDEX idx_users_email ON users(email);

-- Partial index: only index rows matching a condition (smaller, faster)
CREATE INDEX idx_active_users ON users(email) WHERE deleted_at IS NULL;

-- Composite: multi-column (order matters — most selective first)
CREATE INDEX idx_orders_user_status ON orders(user_id, status);

-- GIN: full-text search
CREATE INDEX idx_posts_fts ON posts USING gin(to_tsvector('english', body));

-- BRIN: large append-only tables (logs, time-series)
CREATE INDEX idx_events_created ON events USING brin(created_at);

-- Check index usage
SELECT indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE idx_scan = 0;  -- unused indexes
```

<div class="quiz-card">
  <p class="quiz-q">You need to query "find all posts containing the word kubernetes." B-tree, GIN, or BRIN — and why?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>GIN. It's built specifically for full-text search (plus jsonb and arrays) because it inverts the index to map each token to the rows containing it — exactly what "contains this word" needs. A B-tree only helps with equality/range on the column as a whole, and BRIN is for naturally sorted large tables, not text search.</div>
</div>

---

## EXPLAIN ANALYZE

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT u.name, COUNT(o.id)
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.id;

-- Key things to look for:
-- Seq Scan on large table → missing index
-- Nested Loop with many rows → should be Hash Join
-- Buffers: hit=X read=Y → X from cache, Y from disk
-- actual rows >> estimated rows → stale statistics (run ANALYZE)
-- cost=X..Y: X=startup cost, Y=total cost (in arbitrary units)
```

<div class="quiz-card">
  <p class="quiz-q">EXPLAIN ANALYZE shows actual rows far higher than the estimated rows for a plan step. What should you check first, and why?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Run ANALYZE on the table. A large gap between estimated and actual rows almost always means stale statistics — the planner's row estimates were computed against an older, smaller, or differently-shaped table. Stale estimates are exactly what causes it to pick a bad plan (like a nested loop sized for a handful of rows that's now getting fed hundreds of thousands).</div>
</div>

---

## Connection Pooling

PostgreSQL creates one OS process per connection (~10MB RAM each). At 1000 connections = 10GB just for processes.

```mermaid
graph LR
    classDef app fill:#34495e,stroke:#212f3c,color:#fff,rx:6
    classDef pooler fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef pgconn fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef pg fill:#2980b9,stroke:#1f618d,color:#fff,rx:6

    subgraph APPTIER["Application tier"]
        APP_PODS["200 app pods<br/>×10 conn each = 2000 client connections"]:::app
    end

    subgraph POOLTIER["PgBouncer"]
        QUEUE["Waiting-client queue<br/>used only if every server<br/>connection is currently busy"]:::pooler
        POOL["Server connection pool<br/>default_pool_size = 50"]:::pgconn
    end

    subgraph PGTIER["PostgreSQL"]
        PG["postgres backends<br/>max_connections = 100"]:::pg
    end

    APP_PODS -->|"2000 client connections"| QUEUE
    QUEUE -->|"assigned per pool_mode's<br/>release point"| POOL
    POOL -->|"only 50 real OS connections"| PG
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Client connects to PgBouncer, not Postgres.</strong> The app pod opens a TCP connection to PgBouncer exactly like it would to Postgres directly — PgBouncer speaks the Postgres wire protocol, so the app can't tell the difference.
    </div>
    <div class="stepper-panel">
      <strong>2. PgBouncer assigns — or queues for — a real server connection.</strong> If a free connection to the actual PostgreSQL backend already exists in the pool, PgBouncer hands it over immediately. If all default_pool_size connections are checked out, the client waits in a queue instead of PgBouncer opening a 51st.
    </div>
    <div class="stepper-panel">
      <strong>3. Client and server are paired for the query/transaction.</strong> Queries are forwarded over that real connection as if the client were talking to Postgres directly.
    </div>
    <div class="stepper-panel">
      <strong>4. The connection returns to the pool.</strong> Exactly when depends on pool_mode: in transaction mode (the default here), the real connection is released back the moment the transaction commits or rolls back — not when the client disconnects — which is what lets 2000 client connections share only 50 real ones.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="session" class="state-warn">session</button>
    <button data-toggle-opt="transaction" class="active state-ok">transaction</button>
    <button data-toggle-opt="statement" class="state-bad">statement</button>
  </div>
  <div class="toggle-panel" data-toggle-panel="session">
    A server connection is held for the client's entire session — released only on disconnect. Safest option: session-level features like <code>SET</code>, prepared statements, and advisory locks all work exactly like a direct connection. But pooling buys nothing if clients hold idle connections open — you still need roughly one server connection per concurrent client.
  </div>
  <div class="toggle-panel active" data-toggle-panel="transaction">
    A server connection is released back to the pool as soon as the current transaction commits or rolls back — the mode used in the config below. This is what lets 2000 client connections fit into 50 real ones. Cost: session state (bare <code>SET</code>, <code>LISTEN</code>, prepared statements) doesn't reliably survive across transactions, since the next one might land on a completely different server connection.
  </div>
  <div class="toggle-panel" data-toggle-panel="statement">
    A server connection is released back to the pool after every single statement, even inside what the client thinks is one transaction. Maximizes reuse, but multi-statement transactions aren't supported at all — this mode is only viable for autocommit-style, single-statement workloads.
  </div>
</div>

```ini
# pgbouncer.ini
[pgbouncer]
pool_mode = transaction      # connection returned after each transaction (most efficient)
max_client_conn = 10000      # app pods can open many client connections
default_pool_size = 50       # actual PostgreSQL connections
reserve_pool_size = 10       # emergency pool
server_idle_timeout = 300    # close idle server connections after 5min
```

<div class="quiz-card">
  <p class="quiz-q">Why does transaction-mode pooling let 200 app pods × 10 connections each (2000 client connections) run against default_pool_size = 50 real Postgres connections?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because in transaction mode, a real server connection is returned to the pool the instant a transaction ends — not when the client disconnects. At any given moment, only transactions actually in flight are holding a real connection; with short, bursty transactions, 50 real connections can serve far more than 50 "open" client connections, most of which are idle between transactions.</div>
</div>

---

## Key Configuration Parameters

```ini
# postgresql.conf
shared_buffers = 4GB              # 25% of RAM for buffer pool
effective_cache_size = 12GB       # planner hint: how much OS cache is available
work_mem = 64MB                   # per-sort, per-hash operation (watch out: can multiply)
maintenance_work_mem = 512MB      # for VACUUM, CREATE INDEX, pg_restore
wal_level = replica               # needed for streaming replication
max_wal_senders = 10              # max replication connections
checkpoint_completion_target = 0.9 # spread checkpoint I/O
random_page_cost = 1.1            # SSD: set to 1.1 (same as seq scan)
effective_io_concurrency = 200    # SSD: number of concurrent I/O requests
```

---

## Query Planner — How PostgreSQL Chooses Execution Plans

```mermaid
graph TD
    classDef input fill:#34495e,stroke:#212f3c,color:#fff,rx:6
    classDef frontend fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef planner fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef exec fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    SQL["SELECT u.name, count(o.id)<br/>FROM users u JOIN orders o ON o.user_id=u.id<br/>WHERE u.created_at > '2024-01-01'<br/>GROUP BY u.id"]:::input

    subgraph FRONTEND["SQL frontend — one deterministic path"]
        PARSE["Parser: SQL text → parse tree<br/>syntax only, no table lookups yet"]:::frontend
        ANALYZE2["Analyzer: resolve table/column names,<br/>check types against the catalog"]:::frontend
        REWRITE["Rewriter: expand views,<br/>apply rules"]:::frontend
    end

    subgraph OPT["Optimizer — the only step with real choices"]
        PLAN["Planner<br/>enumerate possible plans<br/>estimate cost of each from pg_statistic<br/>choose the cheapest"]:::planner
    end

    EXEC["Executor: run the chosen plan,<br/>pulling rows through each node"]:::exec

    SQL --> PARSE --> ANALYZE2 --> REWRITE --> PLAN --> EXEC
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Parse.</strong> Pure syntax — turns the SQL text into a parse tree with zero knowledge of whether users or orders actually exist yet.
    </div>
    <div class="stepper-panel">
      <strong>2. Analyze.</strong> Resolves every table and column name against the catalog and checks types. This is where a typo'd column or table name would error out.
    </div>
    <div class="stepper-panel">
      <strong>3. Rewrite.</strong> Expands any views referenced in the query and applies rewrite rules, so the planner downstream only ever sees plain tables.
    </div>
    <div class="stepper-panel">
      <strong>4. Plan / Optimize.</strong> The only stage that makes real choices: enumerates candidate plans — which index, which join algorithm, which join order — and picks the cheapest by the cost model (random_page_cost, seq_page_cost, cpu_tuple_cost, and row estimates from pg_statistic).
    </div>
    <div class="stepper-panel">
      <strong>5. Execute.</strong> Runs the winning plan node-by-node, pulling rows up through the tree exactly as EXPLAIN ANALYZE reports them.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Cost model:** The planner assigns a cost (in arbitrary units) to each plan based on:
- `seq_page_cost` (default 1.0) — cost to read a page sequentially
- `random_page_cost` (default 4.0, use 1.1 for SSDs) — cost of a random page read
- `cpu_tuple_cost` (0.01) — cost per row processed
- Row count estimates from `pg_statistic` (updated by ANALYZE)

**Why plans go wrong:**
- Stale statistics → wrong row estimates → wrong plan choice
- Run `ANALYZE table_name` after bulk loads
- `autovacuum` runs ANALYZE automatically but may lag

```sql
-- Force statistics update
ANALYZE users;

-- See planner's row estimates vs actual
EXPLAIN (ANALYZE, FORMAT TEXT) SELECT * FROM users WHERE email = 'alice@example.com';
-- rows=1 (estimate) vs rows=1 (actual) ← good
-- rows=1000 (estimate) vs rows=1 (actual) ← bad — stale stats, will choose wrong plan

-- Increase statistics target for skewed columns
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500; -- default 100
ANALYZE orders;
```

<div class="quiz-card">
  <p class="quiz-q">A table just had a 10x bulk load and ANALYZE hasn't run since. Which stage of the planner pipeline gets bad information first, and what's the downstream effect?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The Planner stage — its cost estimates come from pg_statistic, which ANALYZE keeps current. Stale statistics mean the row-count estimates it uses to cost each candidate plan are wrong, which can make it pick a plan (like a nested loop sized for the old, smaller row count) that's badly suited to the new data volume, even though the query itself is unchanged.</div>
</div>

---

## Join Types — When Planner Uses Each

```mermaid
graph TD
    classDef decision fill:#34495e,stroke:#212f3c,color:#fff,rx:6
    classDef nl fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef hash fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef merge fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6

    START["Planner costs every applicable<br/>join algorithm, picks the cheapest"]:::decision

    START -->|"inner side has a usable index,<br/>outer result is small"| NL["Nested Loop<br/>O(n×m)<br/>for every outer row, probe the inner index"]:::nl
    START -->|"both sides large,<br/>no usable index on join key"| HASH["Hash Join<br/>O(n+m)<br/>build a hash table from the smaller side<br/>in work_mem, probe with the larger side"]:::hash
    START -->|"both sides already sorted,<br/>or an index exists on the join key"| MERGE["Merge Join<br/>O(n log n + m log m)<br/>walk both sorted inputs in lockstep"]:::merge
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="nl" class="active">Nested Loop</button>
    <button data-tab="hash">Hash Join</button>
    <button data-tab="merge">Merge Join</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="nl">
      For every row on the outer side, probe the inner side once. Cheap only if the inner side has an index to probe (turning each probe into O(log n)) and the outer side is small — otherwise it degenerates into a full O(n×m) scan-within-a-scan, the classic "why is this simple join so slow" plan.
    </div>
    <div class="tab-panel" data-tab-panel="hash">
      Builds an in-memory hash table from the smaller input, sized by <code>work_mem</code>, then streams the larger input through it probing for matches. Good default when both sides are large and there's no index to exploit — but if the hash table doesn't fit in <code>work_mem</code>, it spills to disk and gets much slower.
    </div>
    <div class="tab-panel" data-tab-panel="merge">
      Requires both inputs sorted on the join key — either because an index already provides that order, or the planner adds an explicit sort. Walks both streams in lockstep, advancing whichever side is behind. Scales well and doesn't need anything to fit in memory the way a hash join does.
    </div>
  </div>
</div>

```sql
-- Force a specific join type for testing
SET enable_hashjoin = off;    -- disable hash joins
SET enable_nestloop = off;    -- disable nested loops
EXPLAIN SELECT ... JOIN ...;  -- see what planner picks without preferred type
SET enable_hashjoin = on;     -- always reset after testing!
```

<div class="quiz-card">
  <p class="quiz-q">A join between two large tables with no index on the join column shows up as a Hash Join in EXPLAIN. Why not Nested Loop?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Nested Loop only stays cheap when the inner side has an index to probe — without one, every outer row would require a full scan of the inner table, an O(n×m) disaster for two large tables. Hash Join instead builds one hash table from the smaller side and does a single pass over the larger side, O(n+m) — the planner picks it precisely because there's no index to make Nested Loop viable here.</div>
</div>

---

## VACUUM and Autovacuum

PostgreSQL never updates or deletes rows in place (MVCC). Dead tuples accumulate and must be reclaimed.

```mermaid
graph TD
    classDef dead fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6
    classDef live fill:#27ae60,stroke:#1e8449,color:#fff,rx:6
    classDef trigger fill:#f39c12,stroke:#ba6018,color:#fff,rx:6
    classDef vac fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef full fill:#e74c3c,stroke:#c0392b,color:#fff,rx:6

    UPDATE["UPDATE users SET name='Bob' WHERE id=1"] --> DEAD["Dead tuple left behind:<br/>xmin=50, xmax=200, name='Alice'<br/>still on page, invisible to new transactions"]:::dead

    DEAD --> THRESH{"n_dead_tup ÷ (n_live_tup+n_dead_tup)<br/>crosses autovacuum_vacuum_scale_factor?"}:::trigger
    THRESH -->|Yes| AUTOVAC["autovacuum worker<br/>launched automatically"]:::trigger
    THRESH -->|"No — or a manual VACUUM"| VACUUM

    AUTOVAC --> VACUUM["VACUUM<br/>scans heap, marks dead tuples reusable<br/>updates visibility map & free space map<br/>does NOT return space to OS (usually)"]:::vac
    VACUUM --> FSM["Free space map updated<br/>future INSERTs can reuse this space<br/>in the SAME table file"]:::live

    VACUUM -.->|"if bloat is severe and<br/>disk must be reclaimed"| VF["VACUUM FULL<br/>rewrites entire table to a new file<br/>reclaims disk space back to the OS<br/>ACCESS EXCLUSIVE lock — blocks everything"]:::full
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Dead tuples accumulate.</strong> Every UPDATE/DELETE leaves the old row version on the page — MVCC never overwrites in place, so someone has to reclaim that space later.
    </div>
    <div class="stepper-panel">
      <strong>2. Autovacuum is triggered (or VACUUM is run manually).</strong> Autovacuum wakes up for a table once its dead-tuple ratio crosses <code>autovacuum_vacuum_scale_factor</code> (default 20%, often tuned much lower on hot tables).
    </div>
    <div class="stepper-panel">
      <strong>3. Scan and mark.</strong> VACUUM scans the heap, identifies tuples no longer visible to any active snapshot, and marks that space reusable — it also updates the visibility map (so future index-only scans can skip the heap) and the free space map.
    </div>
    <div class="stepper-panel">
      <strong>4. Space stays in the table, not the OS.</strong> A plain VACUUM lets future INSERTs/UPDATEs reuse that freed space inside the same file — it does not shrink the file or return space to the filesystem.
    </div>
    <div class="stepper-panel">
      <strong>5. VACUUM FULL, only if disk actually needs reclaiming.</strong> Rewrites the entire table into a new, compact file and swaps it in — the only path that returns disk to the OS, but it takes an ACCESS EXCLUSIVE lock that blocks all reads and writes for its duration.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Table bloat** — pages fill with dead tuples → table grows → queries slow (more pages to scan).

```sql
-- Check bloat
SELECT relname,
       pg_size_pretty(pg_relation_size(oid)) AS table_size,
       n_dead_tup,
       n_live_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;

-- Manual vacuum with verbose output
VACUUM (ANALYZE, VERBOSE) users;

-- Autovacuum thresholds (per-table override)
ALTER TABLE orders SET (
    autovacuum_vacuum_scale_factor = 0.01,  -- vacuum when 1% dead (default 20%)
    autovacuum_analyze_scale_factor = 0.005 -- analyze when 0.5% changed
);
```

<div class="quiz-card">
  <p class="quiz-q">After running plain VACUUM (not VACUUM FULL) on a heavily-updated table, the table's file on disk is exactly the same size as before. Is VACUUM broken?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No, that's expected. Plain VACUUM marks dead tuple space as reusable for future writes inside the same file — it doesn't shrink the file or hand space back to the OS. Only VACUUM FULL rewrites the table into a smaller file and returns the freed disk space, at the cost of an ACCESS EXCLUSIVE lock for the duration.</div>
</div>

---

## Partitioning

For very large tables (100M+ rows), partitioning divides the table into smaller physical pieces.

```mermaid
graph TD
    classDef parent fill:#34495e,stroke:#212f3c,color:#fff,rx:6
    classDef scanned fill:#27ae60,stroke:#1e8449,color:#fff,rx:6
    classDef skipped fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6

    PARENT["orders (partitioned table)<br/>PARTITION BY RANGE (created_at)<br/>holds no rows of its own"]:::parent
    P2023["orders_2023<br/>Jan–Dec 2023"]:::skipped
    P2024Q1["orders_2024_q1<br/>Jan–Mar 2024"]:::scanned
    P2024Q2["orders_2024_q2<br/>Apr–Jun 2024"]:::skipped
    PARENT --> P2023 & P2024Q1 & P2024Q2

    QUERY["WHERE created_at = '2024-02-15'"] -.->|"planner prunes to<br/>the one matching partition"| P2024Q1
    QUERY -.->|"skipped entirely — never opened"| P2023
    QUERY -.->|"skipped entirely — never opened"| P2024Q2
```

```sql
-- Declarative partitioning (PostgreSQL 10+)
CREATE TABLE orders (
    id BIGINT NOT NULL,
    user_id BIGINT,
    amount NUMERIC,
    created_at TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (created_at);

-- Create partitions
CREATE TABLE orders_2024_q1
    PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2024-04-01');

CREATE TABLE orders_2024_q2
    PARTITION OF orders
    FOR VALUES FROM ('2024-04-01') TO ('2024-07-01');

-- Query partition pruning: WHERE created_at = '2024-02-15'
-- PostgreSQL scans ONLY orders_2024_q1 — skips all other partitions
EXPLAIN SELECT * FROM orders WHERE created_at = '2024-02-15';
-- → Seq Scan on orders_2024_q1 (not the others)

-- Drop old data: drop a partition instantly (no row-by-row DELETE)
DROP TABLE orders_2023;  -- instant, reclaims disk space immediately
```

<div class="quiz-card">
  <p class="quiz-q">A query filters WHERE created_at = '2024-02-15' against the partitioned orders table above. Which partitions does PostgreSQL actually scan?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Only orders_2024_q1. Partition pruning checks the query's WHERE clause against each partition's declared range and skips opening any partition the value can't possibly fall in — orders_2023 and orders_2024_q2 are never touched. That's the whole performance point of partitioning: the planner doesn't pay for scanning data it can already rule out.</div>
</div>

---

## Logical Replication

Streaming replication replicates everything. Logical replication lets you replicate specific tables to specific databases — useful for migrations, ETL, and multi-cloud.

```mermaid
graph LR
    classDef pub fill:#2980b9,stroke:#1f618d,color:#fff,rx:6
    classDef decode fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef sub fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    subgraph PUBSIDE["Publisher (source DB)"]
        PUB["CREATE PUBLICATION my_pub<br/>FOR TABLE users, orders"]:::pub
        WALDEC["WAL logical decoding<br/>reads WAL, decodes into<br/>row-level INSERT/UPDATE/DELETE events"]:::decode
        SLOT["Replication slot<br/>pins WAL so it can't be<br/>recycled before the subscriber reads it"]:::decode
    end

    subgraph SUBSIDE["Subscriber (destination DB)"]
        APPLY["Apply worker<br/>replays decoded events<br/>as normal SQL writes"]:::sub
        SUB["CREATE SUBSCRIPTION my_sub<br/>CONNECTION '...' PUBLICATION my_pub"]:::sub
    end

    PUB --> WALDEC --> SLOT -->|"decoded change stream"| APPLY --> SUB
```

```sql
-- On source database
CREATE PUBLICATION my_pub FOR TABLE users, orders;

-- On destination database (different server, different DB)
CREATE SUBSCRIPTION my_sub
  CONNECTION 'host=source-db user=replicator dbname=myapp'
  PUBLICATION my_pub;

-- Check replication lag
SELECT subname, received_lsn, latest_end_lsn,
       received_lsn - latest_end_lsn AS lag_bytes
FROM pg_stat_subscription;
```

**Use cases:** Zero-downtime major version upgrades (replicate to new version, cut over), selective table replication to data warehouse, real-time CDC without Debezium.

<div class="quiz-card">
  <p class="quiz-q">A logical replication subscriber stops connecting for a long time. Does the publisher's normal WAL retention (max_wal_size) recycle the WAL out from under it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — the replication slot pins the WAL, preventing PostgreSQL from recycling any segment the subscriber hasn't consumed yet, regardless of max_wal_size. The tradeoff is the opposite failure mode: an abandoned or badly lagging slot can make WAL accumulate indefinitely on the publisher's disk until the slot is dropped or the subscriber catches up.</div>
</div>

---

## Useful Diagnostic Queries

```sql
-- Long-running queries (> 5 minutes)
SELECT pid, now() - pg_stat_activity.query_start AS duration,
       query, state, wait_event_type, wait_event
FROM pg_stat_activity
WHERE query_start < now() - interval '5 minutes'
  AND state != 'idle'
ORDER BY duration DESC;

-- Locks and who is blocking whom
SELECT blocked.pid AS blocked_pid,
       blocked.query AS blocked_query,
       blocking.pid AS blocking_pid,
       blocking.query AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
  ON blocking.pid = ANY(pg_blocking_pids(blocked.pid));

-- Missing indexes (sequential scans on large tables)
SELECT relname, seq_scan, seq_tup_read,
       idx_scan, seq_tup_read / seq_scan AS avg_seq_tup
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 20;

-- Cache hit rate (should be > 99% for OLTP)
SELECT sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) AS cache_hit_ratio
FROM pg_statio_user_tables;

-- Table sizes including indexes and TOAST
SELECT relname,
       pg_size_pretty(pg_total_relation_size(oid)) AS total_size,
       pg_size_pretty(pg_relation_size(oid)) AS table_size,
       pg_size_pretty(pg_indexes_size(oid)) AS index_size
FROM pg_class
WHERE relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC
LIMIT 20;
```
