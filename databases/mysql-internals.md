# MySQL / InnoDB Internals

How MySQL's InnoDB engine actually writes, versions, and replicates rows underneath a client connection — the buffer pool, the redo/undo logs that make crashes and rollbacks safe, and the binlog+GTID pipeline that keeps replicas in sync.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## InnoDB Storage Engine Architecture

```mermaid
graph TD
    classDef client fill:#34495e,stroke:#212f3c,color:#fff,rx:6
    classDef mem fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef durable fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef disk fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6

    CLIENT2["Client query"]:::client --> PARSER["SQL Parser + Optimizer<br/>picks the execution plan"]:::client
    PARSER --> EXEC["Execution Engine<br/>row-by-row iterator over the plan"]:::client
    EXEC --> INNODB["InnoDB Storage Engine"]

    subgraph INNODB["InnoDB"]
        BP2["Buffer Pool (innodb_buffer_pool_size)<br/>data + index + undo pages<br/>LRU with young/old sublists"]:::mem
        CHANGE["Change Buffer<br/>buffers secondary-index changes<br/>when the index page isn't cached"]:::mem
        REDO["Redo Log (ib_logfile0, ib_logfile1)<br/>WAL for crash recovery<br/>circular buffer, fixed size"]:::durable
        UNDO["Undo Log (ibdata1 / undo tablespace)<br/>old row versions for MVCC<br/>+ rollback segments"]:::durable
    end

    EXEC -->|"row read/write"| BP2
    EXEC -->|"before-image write"| UNDO
    EXEC -->|"redo record on modify"| REDO
    CHANGE -.->|"merged in on page read<br/>or by the purge thread"| BP2
    BP2 -->|"checkpoint: flush dirty pages"| DATA2["Data files (.ibd)<br/>clustered B-tree on primary key<br/>all data in leaf nodes"]:::disk
    REDO -.->|"replayed on crash recovery<br/>if newer than last checkpoint"| DATA2
```

The buffer pool is where reads and writes actually happen — data and index pages live there entirely in memory, and a query only touches disk when a page isn't cached. Redo and undo solve two different problems that both start with that same modified page: redo makes the *change* durable before the dirty page is ever flushed to the `.ibd` file, while undo keeps the *previous* row version around for both rollback and any transaction still reading an older MVCC snapshot. The change buffer exists purely to avoid random-I/O stalls: if a secondary-index page a write needs to touch isn't in the buffer pool, InnoDB records the change there instead of paging the index block in immediately, merging it in later when the page is naturally read or the purge thread gets to it.

<div class="quiz-card">
  <p class="quiz-q">A dirty buffer-pool page hasn't been flushed to the .ibd file yet, but the transaction that modified it already got "commit confirmed" back. MySQL crashes right now. What makes that committed change survive, and how is that different from what lets InnoDB roll back a separate, still-uncommitted transaction?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The redo log — the change was already written (and fsynced, under innodb_flush_log_at_trx_commit=1) there before commit returned, so crash recovery replays it into the data file even though the buffer pool page itself never reached disk. Rolling back a different, uncommitted transaction is a completely separate mechanism: it uses the undo log's before-image of the row, not the redo log's forward-only change record.</div>
</div>

The diagram labels the eviction policy "LRU with young/old sublists" almost in passing, but that's not the same structure as the plain LRU cache walked through in `coding-practice/lru-cache.md` — the difference is deliberate, not incidental. A single doubly-linked-list LRU has a real bug for a database's most common workload: a one-off `SELECT * FROM huge_table` full scan reads millions of pages exactly once, and a plain LRU would shove every single one of those reads straight to the MRU end, evicting whatever was genuinely hot from repeated real queries in the process — one scan, entire working set gone. InnoDB's fix is to split the LRU list into two sublists instead of one flat list: an OLD sublist (`innodb_old_blocks_pct`, default 37% — roughly 3/8 of the pool) and a YOUNG sublist (the remaining ~5/8). A newly read page always lands at the *head of the OLD sublist*, never the young one, so a scan floods and churns the old sublist while never touching a page that's already proven itself with a second access. Only a repeat access promotes a page from OLD to YOUNG. (Real InnoDB also makes a page wait `innodb_old_blocks_time` milliseconds before that promotion counts, specifically to stop a tight scan loop from re-reading the same page twice in a row and promoting it by accident — the demo below skips that timer for simplicity and just promotes on the second distinct access.)

<div class="structure-viz" id="innodb-buffer-pool-viz">
  <svg class="viz-canvas" viewBox="0 0 600 150"></svg>
  <div class="viz-controls">
    <input class="viz-input" type="number" placeholder="page id" />
    <button class="viz-btn" data-viz-action="access">Access Page</button>
    <button class="viz-btn" data-viz-action="scan">Simulate Full Table Scan</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background:#1e3a8a"></span> young sublist — protected</span>
    <span><span class="viz-swatch" style="background:#78350f"></span> old sublist — vulnerable to a scan</span>
    <span><span class="viz-swatch" style="background:#14532d"></span> just inserted / just promoted</span>
  </div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root0 = document.getElementById('innodb-buffer-pool-viz');
  const svg = root0.querySelector('.viz-canvas');
  const input = root0.querySelector('.viz-input');
  const status = root0.querySelector('.viz-status');

  const CAPACITY = 8;
  const SLOT_W = 60, SLOT_H = 46, GAP = 10;

  // Core algorithm state -- one array, index 0 = young MRU end ... last index
  // = old LRU end (the eviction candidate). youngCount marks the boundary:
  // pages[0..youngCount-1] are YOUNG, pages[youngCount..] are OLD. youngCount
  // only changes on a promotion (old -> young, +1) or an eviction (-1, only
  // in the fallback case where the pool is entirely young) -- never
  // recomputed wholesale from a rounded fraction, because that would
  // silently un-protect an already-promoted page just for not being the
  // *most* recently touched one, which would defeat the entire point.
  let pages, youngCount, flashId, flashTimer, nextScanId;

  function reset() {
    pages = [];
    youngCount = 0;
    flashId = null;
    nextScanId = 900;
  }

  function oldCount() {
    return pages.length - youngCount;
  }

  function access(pageId) {
    const idx = pages.indexOf(pageId);
    if (idx === -1) return insertNew(pageId);
    const isOld = idx >= youngCount;
    pages.splice(idx, 1);
    pages.unshift(pageId);
    if (isOld) {
      youngCount += 1;
      return { event: 'promote', pageId, message: `Page ${pageId} accessed again — promoted from OLD to YOUNG sublist.` };
    }
    return { event: 'reaccess-young', pageId, message: `Page ${pageId} accessed again — already in the YOUNG sublist, moved to its MRU head.` };
  }

  function insertNew(pageId) {
    // Head of the OLD sublist = index youngCount, NOT index 0 -- the whole
    // point: a single scan can't shove pages straight to the young/MRU end.
    pages.splice(youngCount, 0, pageId);
    let evicted = null, evictedFrom = null;
    if (pages.length > CAPACITY) {
      if (oldCount() > 0) {
        evicted = pages.pop();
        evictedFrom = 'OLD';
      } else {
        // Fallback: pool is entirely young (degenerate case). Shouldn't
        // normally happen given a maintained old sublist.
        evicted = pages.pop();
        youngCount -= 1;
        evictedFrom = 'YOUNG';
      }
    }
    let message = `Page ${pageId} is new — inserted at the head of the OLD sublist (not young — a single scan won't evict hot pages).`;
    if (evicted !== null) message += ` Pool full — evicted page ${evicted} from the tail of the ${evictedFrom} sublist.`;
    return { event: 'insert', pageId, evicted, evictedFrom, message };
  }

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = 'viz-status' + (kind === 'ok' ? ' viz-status-ok' : kind === 'error' ? ' viz-status-error' : '');
  }

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function scheduleFlashClear() {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashId = null; draw(); }, 1600);
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const topY = 28, slotY = 46, labelY = 14;
    const boundaryX = GAP + youngCount * (SLOT_W + GAP) - GAP / 2;

    if (youngCount > 0) {
      const youngMidX = GAP + (youngCount * (SLOT_W + GAP)) / 2 - GAP / 2;
      const t = el('text', { x: youngMidX, y: labelY, class: 'viz-label-dim' });
      t.textContent = 'YOUNG sublist';
      svg.appendChild(t);
    }
    if (oldCount() > 0) {
      const oldWidth = CAPACITY * (SLOT_W + GAP) - youngCount * (SLOT_W + GAP);
      const oldMidX = GAP + youngCount * (SLOT_W + GAP) + oldWidth / 2 - GAP / 2;
      const t = el('text', { x: oldMidX, y: labelY, class: 'viz-label-dim' });
      t.textContent = 'OLD sublist';
      svg.appendChild(t);
    }

    if (youngCount > 0 && youngCount < CAPACITY) {
      svg.appendChild(el('line', {
        x1: boundaryX, y1: topY, x2: boundaryX, y2: slotY + SLOT_H + 14,
        class: 'viz-edge', 'stroke-dasharray': '4,3',
      }));
    }

    for (let i = 0; i < CAPACITY; i++) {
      const x = GAP + i * (SLOT_W + GAP);
      const occupied = i < pages.length;
      const pageId = pages[i];
      const isOld = i >= youngCount;
      let cls = isOld ? 'viz-node-highlight' : 'viz-node';
      if (occupied && pageId === flashId) cls = 'viz-node-new';
      svg.appendChild(el('rect', {
        x, y: slotY, width: SLOT_W, height: SLOT_H, rx: 6,
        class: occupied ? cls : 'viz-edge',
        'fill-opacity': occupied ? '1' : '0', 'stroke-dasharray': occupied ? '' : '4,3',
      }));
      if (occupied) {
        const t = el('text', { x: x + SLOT_W / 2, y: slotY + SLOT_H / 2 });
        t.textContent = pageId;
        svg.appendChild(t);
      }
      let bottomLabel = '';
      if (occupied && i === 0) bottomLabel = 'MRU';
      if (occupied && i === pages.length - 1) bottomLabel = bottomLabel ? bottomLabel + ' / evict next' : 'evict next';
      if (bottomLabel) {
        const bl = el('text', { x: x + SLOT_W / 2, y: slotY + SLOT_H + 14, class: 'viz-label-dim' });
        bl.textContent = bottomLabel;
        svg.appendChild(bl);
      }
    }
  }

  root0.querySelector('[data-viz-action="access"]').addEventListener('click', () => {
    const v = parseInt(input.value, 10);
    if (isNaN(v)) { setStatus('Enter a page id first.', 'error'); return; }
    const result = access(v);
    flashId = v;
    input.value = '';
    setStatus(result.message, 'ok');
    draw();
    scheduleFlashClear();
  });

  root0.querySelector('[data-viz-action="scan"]').addEventListener('click', () => {
    const startId = nextScanId;
    nextScanId += 5;
    const evictedOld = [];
    const evictedYoung = [];
    for (let i = 0; i < 5; i++) {
      const result = access(startId + i);
      if (result.evicted !== null && result.evicted !== undefined) {
        (result.evictedFrom === 'YOUNG' ? evictedYoung : evictedOld).push(result.evicted);
      }
    }
    flashId = null;
    let msg = `Simulated a full table scan: pages ${startId}–${startId + 4} each touched once, all inserted into the OLD sublist.`;
    if (evictedOld.length) msg += ` Evicted from the OLD sublist tail as it churned: ${evictedOld.join(', ')}.`;
    if (evictedYoung.length) msg += ` Pool was entirely YOUNG (no OLD sublist left to absorb the scan) — had to evict from YOUNG instead: ${evictedYoung.join(', ')}.`;
    if (!evictedOld.length && !evictedYoung.length) msg += ' Pool had room — nothing evicted yet.';
    if (!evictedYoung.length) msg += ' No YOUNG page was touched or evicted.';
    setStatus(msg, 'ok');
    draw();
  });

  root0.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    reset();
    setStatus('Reset to an empty pool.', '');
    draw();
  });

  reset();
  setStatus('Empty pool (8 slots). Access the same page id twice to see it promoted from OLD to YOUNG, then try "Simulate Full Table Scan."', '');
  draw();
})();
</script>

---

## Redo Log (WAL) + Undo Log

```mermaid
sequenceDiagram
    participant TX2 as Transaction
    participant BP3 as Buffer Pool
    participant REDO2 as Redo Log
    participant UNDO2 as Undo Log
    participant DISK2 as Data files

    rect rgba(230, 126, 34, 0.15)
    Note over TX2,UNDO2: Before commit — durability boundary not yet crossed
    TX2->>UNDO2: Write before-image (rollback + MVCC snapshot)
    TX2->>BP3: Modify page in buffer pool (now dirty)
    TX2->>REDO2: Write redo record (new value)
    end
    Note over REDO2: fsync on COMMIT if innodb_flush_log_at_trx_commit=1
    TX2-->>TX2: COMMIT confirmed to client

    Note over BP3,DISK2: Later, asynchronously — decoupled from commit latency
    BP3->>DISK2: Checkpoint flushes dirty pages
    Note over REDO2: redo entries before the checkpoint can now be overwritten

    rect rgba(231, 76, 60, 0.15)
    Note over DISK2,REDO2: Crash before the next checkpoint
    DISK2->>REDO2: On restart, InnoDB scans redo log from last checkpoint
    REDO2->>DISK2: Replays every committed redo record forward
    Note over DISK2: Data files caught up to the last fsynced commit —<br/>nothing acknowledged to a client is lost
    end
```

The redo log is what makes a commit durable long before the modified page is flushed to disk — the buffer pool page and the on-disk data file can lag behind indefinitely, because the redo log is exactly the fallback InnoDB uses to reconstruct that gap after a crash.

**`innodb_flush_log_at_trx_commit`:**
| Value | Behavior | Durability | Performance |
|-------|---------|-----------|------------|
| 0 | Flush every 1s (OS buffer) | 1s data loss on crash | Fastest |
| 1 (default) | Flush + fsync on every commit | Zero loss | Slowest |
| 2 | Flush to OS buffer on commit, fsync every 1s | 1s loss on OS crash | Medium |

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="flush0" class="active">0</button>
    <button data-tab="flush1">1 (default)</button>
    <button data-tab="flush2">2</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="flush0">
      The log buffer is written and fsynced to disk about once a second by a
      background thread, regardless of commits. A crash of <code>mysqld</code>
      itself — or the OS — can lose up to a second of transactions that were
      already reported as committed. Fastest, because commit never waits on
      disk I/O at all.
    </div>
    <div class="tab-panel" data-tab-panel="flush1">
      Every commit writes the redo record <em>and</em> fsyncs it before
      returning to the client. Zero committed data can be lost, at the cost
      of a disk fsync on every single transaction. This is the only setting
      that keeps the ACID "D" airtight.
    </div>
    <div class="tab-panel" data-tab-panel="flush2">
      Every commit writes the redo record to the OS's file cache, but the
      fsync to physical disk still only happens about once a second. Safe
      against a <code>mysqld</code> crash (the OS still has the data in
      cache), but an OS-level crash or power loss in that window loses it —
      a common compromise on read replicas where a bit of risk is acceptable.
    </div>
  </div>
</div>

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Before-image to the undo log.</strong> Before InnoDB touches
      the row in place, it writes the row's current value into the undo log,
      so a rollback or an older MVCC snapshot always has the prior version
      available.
    </div>
    <div class="stepper-panel">
      <strong>2. Page modified in the buffer pool.</strong> The actual row
      change happens in memory, on the cached page. Nothing has hit a file on
      disk yet.
    </div>
    <div class="stepper-panel">
      <strong>3. Redo record appended — the durability boundary.</strong>
      InnoDB writes a redo record for the change, and with
      <code>innodb_flush_log_at_trx_commit=1</code>, fsyncs it before
      returning "commit" to the client. This is the moment a committed write
      can no longer be lost.
    </div>
    <div class="stepper-panel">
      <strong>4. Commit confirmed, dirty page still dirty.</strong> The
      buffer pool page hasn't been written back to the <code>.ibd</code> file
      yet — it's just marked dirty. The redo log is carrying the durability
      guarantee right now, not the data file.
    </div>
    <div class="stepper-panel">
      <strong>5. Async checkpoint flushes to disk.</strong> Later,
      independent of any individual transaction's commit, InnoDB flushes
      dirty pages to the data files, and redo log space before that
      checkpoint becomes reusable.
    </div>
    <div class="stepper-panel">
      <strong>6. Crash recovery replays forward from the last checkpoint.</strong>
      On restart, InnoDB reads the redo log starting at the last checkpoint
      and reapplies every record found there, bringing the data files up to
      exactly the state of the last fsynced commit — nothing acknowledged to
      a client is ever lost.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">innodb_flush_log_at_trx_commit is set to 2 on a read replica. The replica's OS crashes and reboots (mysqld itself didn't crash first). What's at risk, and what isn't?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Up to about a second of transactions is at risk — with value 2, every commit writes to the OS file cache but only fsyncs to physical disk roughly once a second, so an OS-level crash can lose whatever was sitting in that cache and never made it to disk. A plain mysqld crash alone would NOT have lost anything, since the OS cache would have survived and eventually been fsynced — the risk here is specifically an OS/power-level failure, not an application crash.</div>
</div>

---

## MVCC with Undo Log

```mermaid
graph TD
    classDef live fill:#e74c3c,stroke:#c0392b,color:#fff,rx:6
    classDef undo fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef txold fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef txnew fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    CURRENT["Current row version (in the table)<br/>id=1, name='Bob', trx_id=200"]:::live
    CURRENT -->|"roll pointer"| PREV["Undo log v1<br/>id=1, name='Alice', trx_id=100"]:::undo
    PREV -->|"roll pointer"| PREV2["Undo log v0<br/>id=1, name='Alex', trx_id=50"]:::undo

    TX_OLD["Old transaction<br/>read view taken before trx 200 committed"]:::txold
    TX_NEW["New transaction<br/>read view taken after trx 200 committed"]:::txnew

    TX_OLD -.->|"trx_id 200 not visible yet →<br/>follow roll pointer"| PREV
    TX_NEW -->|"trx_id 200 already visible →<br/>read current row directly"| CURRENT
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Transaction starts, takes a read view.</strong> InnoDB
      snapshots which transaction IDs are currently active/uncommitted at
      that moment — anything committed by a trx_id outside the visible range
      of that snapshot can't be seen yet.
    </div>
    <div class="stepper-panel">
      <strong>2. Read the current row version.</strong> Every read starts at
      the row's live version in the table, which carries the trx_id of
      whoever last committed a change to it.
    </div>
    <div class="stepper-panel">
      <strong>3. Compare that trx_id against the read view.</strong> If it's
      visible to this transaction's snapshot (already committed before the
      snapshot was taken), the current version is returned directly — no
      undo log involved.
    </div>
    <div class="stepper-panel">
      <strong>4. Otherwise, follow the roll pointer.</strong> If the current
      version's trx_id isn't visible yet, InnoDB follows the row's roll
      pointer into the undo log to the previous version, and repeats the
      same visibility check against <em>that</em> version's trx_id.
    </div>
    <div class="stepper-panel">
      <strong>5. Keep walking the chain until a visible version is found.</strong>
      This is exactly why a long-running transaction with an old read view
      keeps every undo version behind it alive, and blocks the purge thread
      from reclaiming that undo log space.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

Unlike PostgreSQL (which stores old versions in the heap), MySQL/InnoDB stores them in undo logs.

**Undo log purge:** Background purge thread removes undo records no longer needed by any transaction. Long-running transactions prevent purge → undo tablespace grows.

<div class="quiz-card">
  <p class="quiz-q">A read-only reporting transaction opens a read view and then sits idle for six hours without committing. What effect does this have on the undo tablespace, and why?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It prevents purge from reclaiming old undo log versions that are still older than the row's current version — even though the reporting transaction never writes anything, its read view pins whatever versions were visible when it started as still potentially needed. The purge thread can't distinguish "nobody needs this anymore" from "a long-open transaction might still need this," so the undo tablespace keeps growing until that transaction finally closes.</div>
</div>

---

## InnoDB B-tree (Clustered Index)

InnoDB's primary key **is** the clustered index — every row lives directly in the leaf nodes of that B-tree, there's no separate heap the index points into. A secondary index's leaf nodes don't store the row at all; they store the primary key value, which means looking up a row through a secondary index costs a second lookup into the clustered index — the "index dive."

```mermaid
graph LR
    classDef query fill:#34495e,stroke:#212f3c,color:#fff,rx:6
    classDef clustered fill:#2980b9,stroke:#1f618d,color:#fff,rx:6
    classDef secondary fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef result fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    Q1["SELECT * WHERE id=123"]:::query --> CIDX["Clustered index B-tree<br/>keyed on PRIMARY KEY (id)"]:::clustered
    CIDX -->|"1 lookup"| LEAF1["Leaf node<br/>= the entire row"]:::result

    Q2["SELECT * WHERE email='alice@example.com'"]:::query --> SIDX["Secondary index B-tree<br/>keyed on email"]:::secondary
    SIDX -->|"1st lookup"| LEAF2["Leaf node<br/>= PK value only (id=123)"]:::secondary
    LEAF2 -->|"2nd lookup — the 'index dive'"| CIDX2["Clustered index B-tree<br/>keyed on PRIMARY KEY (id)"]:::clustered
    CIDX2 --> LEAF3["Leaf node<br/>= the entire row"]:::result
```

<div class="quiz-card">
  <p class="quiz-q">A query filters on email (secondary index) and matches 500 rows. Roughly how many B-tree lookups does this cost, and why is it more than 500?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Up to 1,000 — for each of the 500 matches, InnoDB does one lookup in the secondary index to get the row's primary key, then a second lookup in the clustered index to fetch the actual row. Every non-covering secondary-index read pays this double lookup ("index dive"), because a secondary index's leaf nodes only ever store the PK value, never the full row.</div>
</div>

---

## Replication: Binary Log (Binlog)

```mermaid
sequenceDiagram
    participant SRC as Source (Primary)
    participant BINLOG as Binary Log
    participant IO_THREAD as IO Thread (replica)
    participant RELAY as Relay Log (replica)
    participant SQL_THREAD as SQL Thread (replica)
    participant REP_DB as Replica DB

    rect rgba(52, 152, 219, 0.12)
    Note over SRC,BINLOG: On commit
    SRC->>SRC: Transaction commits, assigned a GTID<br/>(source_uuid:transaction_number)
    SRC->>BINLOG: Write binlog event tagged with that GTID
    end

    loop continuous, asynchronous streaming
        IO_THREAD->>BINLOG: Request next event after last-read position
        BINLOG-->>IO_THREAD: Stream new binlog events
        IO_THREAD->>RELAY: Append to relay log
    end

    loop continuous apply
        SQL_THREAD->>RELAY: Read next relay log event
        SQL_THREAD->>SQL_THREAD: Check gtid_executed — skip if<br/>this GTID was already applied
        SQL_THREAD->>REP_DB: Execute SQL / apply row image
        SQL_THREAD->>SQL_THREAD: Record GTID in gtid_executed
    end

    Note over SRC,REP_DB: Replica tracks position purely by GTID —<br/>no binlog filename+offset bookkeeping needed
```

**Binlog formats:**
- `STATEMENT`: log SQL statements (compact, but non-deterministic queries can diverge)
- `ROW`: log actual row changes (verbose, always correct — used by default now)
- `MIXED`: statement for safe queries, row for non-deterministic

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="stmt" class="active state-warn">STATEMENT</button>
    <button data-toggle-opt="row" class="state-ok">ROW</button>
    <button data-toggle-opt="mixed" class="state-ok">MIXED</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="stmt">
    Logs the actual SQL statement executed. Compact — one line replicates a
    multi-row UPDATE — but non-deterministic statements (<code>NOW()</code>,
    <code>RAND()</code>, statement-order-dependent triggers) can produce a
    different result on the replica than they did on the source, silently
    diverging the two databases with no error raised.
  </div>
  <div class="toggle-panel" data-toggle-panel="row">
    Logs the actual before/after row values that changed, not the statement
    that caused them. Always correct regardless of non-determinism, at the
    cost of a larger binlog for statements that touch many rows. This is the
    default today.
  </div>
  <div class="toggle-panel" data-toggle-panel="mixed">
    Uses STATEMENT for queries MySQL can prove are deterministic, and falls
    back to ROW automatically for anything it can't — a middle ground between
    binlog size and correctness.
  </div>
</div>

**GTID (Global Transaction ID):** Each transaction gets a globally unique ID. Replicas use GTIDs to track position — no need to know binlog filename + offset. Enables automatic failover.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Transaction commits on the source.</strong> MySQL assigns
      it a Global Transaction ID —
      <code>&lt;source_uuid&gt;:&lt;transaction_number&gt;</code> — unique
      across the whole replication topology, not just this one server.
    </div>
    <div class="stepper-panel">
      <strong>2. Binlog event written, tagged with that GTID.</strong> The
      event itself carries its GTID, not just a filename+offset position.
    </div>
    <div class="stepper-panel">
      <strong>3. Replica's IO thread streams the event.</strong>
      Asynchronously, into its own relay log — tracking nothing more than
      "give me everything after the GTIDs I've already got"
      (<code>gtid_executed</code>).
    </div>
    <div class="stepper-panel">
      <strong>4. Replica's SQL thread applies it, skipping duplicates.</strong>
      Before applying, it checks whether that exact GTID is already in
      <code>gtid_executed</code> and skips it if so — this is what makes GTID
      replication safe to reconnect, or even redirect, without manual
      position bookkeeping.
    </div>
    <div class="stepper-panel">
      <strong>5. Failover: point the replica at a new source by GTID.</strong>
      Because both source and replica track the same GTID sets, promoting a
      different source and reconnecting other replicas to it doesn't require
      computing a binlog filename/offset — MySQL just diffs the GTID sets and
      streams whatever's missing.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Before GTID-based replication, failing over to a new source meant manually computing the exact binlog filename and byte offset for every replica to resume from. Why does GTID eliminate that step?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because every already-applied transaction is recorded in gtid_executed by its GTID rather than by position, a replica can just tell any new source "here's the full set of GTIDs I already have," and the new source computes the diff and starts streaming from there. There's no file+offset arithmetic to get right, so pointing replicas at a newly promoted source can be fully automated.</div>
</div>

---

## Key Configuration

```ini
innodb_buffer_pool_size = 12G      # 70-80% of RAM
innodb_buffer_pool_instances = 8   # reduce contention
innodb_log_file_size = 2G          # larger = faster writes, slower crash recovery
innodb_flush_log_at_trx_commit = 1 # 1 = full durability (use 2 for replicas)
innodb_flush_method = O_DIRECT     # bypass OS cache (avoid double-buffering)
sync_binlog = 1                    # sync binlog to disk per transaction
binlog_format = ROW
gtid_mode = ON
enforce_gtid_consistency = ON
```

---

## Slow Query Log and Analysis

```mermaid
graph LR
    classDef source fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef tool fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef report fill:#f39c12,stroke:#ba6018,color:#fff,rx:6
    classDef fix fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    subgraph SOURCES["Detection sources"]
        SQ["Slow Query Log<br/>file — queries over long_query_time"]:::source
        PS["Performance Schema<br/>in-memory digest table, no file I/O"]:::source
    end

    SQ -->|"offline analysis"| PT["pt-query-digest<br/>(Percona Toolkit)"]:::tool
    PT --> REPORT["Digest report<br/>ranked by total time / count / avg time"]:::report
    PS -->|"live query, no log file needed"| REPORT

    REPORT --> FIX["Add index / rewrite query<br/>/ partition table"]:::fix
```

The slow query log and Performance Schema are two independent ways to catch the same problem: the log needs `slow_query_log` turned on and writes to a file you analyze after the fact, while `events_statements_summary_by_digest` is always accumulating in memory and can be queried live with no configuration flag or file I/O at all — either path should converge on the same fix.

```ini
# Enable slow query log
slow_query_log = ON
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1           # log queries > 1 second
log_queries_not_using_indexes = ON  # catch full table scans
min_examined_row_limit = 1000 # skip trivially small queries
```

```bash
# Analyze slow query log
pt-query-digest /var/log/mysql/slow.log | head -100

# Output shows per-query fingerprint:
# Query 1: 23.45s total, 234 calls, 0.10s avg
# SELECT * FROM orders WHERE user_id = ? AND status = ?
# Rows examined: 50000 → index missing on (user_id, status)
```

```sql
-- Find slow queries in real time (Performance Schema)
SELECT DIGEST_TEXT, COUNT_STAR, AVG_TIMER_WAIT/1e12 AS avg_sec,
       SUM_ROWS_EXAMINED/COUNT_STAR AS avg_rows_examined
FROM performance_schema.events_statements_summary_by_digest
WHERE AVG_TIMER_WAIT > 1e12  -- > 1 second
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;
```

<div class="quiz-card">
  <p class="quiz-q">log_queries_not_using_indexes is ON alongside long_query_time = 1. A query does a full table scan but finishes in 0.05s. Does it show up in the slow query log?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Yes — log_queries_not_using_indexes logs any query that doesn't use an index regardless of how fast it ran, independent of the long_query_time threshold. The two settings catch different failure modes: one flags queries that were already slow, the other flags queries that will become slow as the table grows, even while they're still fast today.</div>
</div>

---

## Gap Locks and Next-Key Locking (REPEATABLE READ)

InnoDB's default isolation level is REPEATABLE READ, and the SQL standard's own definition of that level only promises one thing: a row you already read won't appear to change if you read it again in the same transaction. It says nothing about rows that don't exist yet. Left at that, a range query like `SELECT * FROM t WHERE id BETWEEN 10 AND 20 FOR UPDATE` would only be able to lock the rows it actually found — id=10 and id=20 — and a plain row lock on those two rows does nothing to stop a completely different transaction from inserting a brand-new row, id=15, into the gap between them before this transaction commits. That's a **phantom read**: re-run the same range query and a row appears that wasn't there a moment ago, even though every row you originally locked is untouched. InnoDB closes that hole itself, beyond what the standard requires, using two lock types that don't exist in the row-lock model alone:

- **Gap lock** — locks the empty space between two consecutive index records (or before the first record / after the last), with no lock on any actual row. Its only job is to block another transaction from inserting a new index entry into that space.
- **Next-key lock** — a record lock on an existing index entry *combined with* a gap lock on the space immediately before it. This, not a plain record lock, is what a range scan under REPEATABLE READ actually takes by default — every index record InnoDB examines during the scan gets locked together with the gap leading up to it.

```mermaid
graph LR
    classDef locked fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef record fill:#e74c3c,stroke:#c0392b,color:#fff,rx:6
    classDef blocked fill:#c0392b,stroke:#922b21,color:#fff,rx:6

    subgraph NK1["Next-key lock on id=10"]
        G0["gap: -inf .. 10"]:::locked
        R10["record id=10"]:::record
    end

    subgraph NK2["Next-key lock on id=20"]
        G1["gap: 10 .. 20"]:::locked
        R20["record id=20"]:::record
    end

    G0 --> R10 --> G1 --> R20

    INS["INSERT id=15"]:::blocked -.->|"falls inside the locked gap<br/>BLOCKED until T1 commits/rolls back"| G1
```

With rows already existing at id=10 and id=20, the range query locks two next-key locks: one on record 10 covering the gap before it, and one on record 20 covering the gap between 10 and 20. id=15 falls inside that second gap — nothing about it involves the *rows* 10 or 20 at all, but the gap they bracket is locked all the same.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Setup.</strong> Table <code>t(id)</code> already has rows
      id=10 and id=20. No transaction is open yet.
    </div>
    <div class="stepper-panel">
      <strong>2. T1 runs the range query under REPEATABLE READ.</strong>
      <code>SELECT * FROM t WHERE id BETWEEN 10 AND 20 FOR UPDATE</code>
      acquires a next-key lock on id=10 (record 10 + the gap before it) and a
      next-key lock on id=20 (record 20 + the gap between 10 and 20).
    </div>
    <div class="stepper-panel">
      <strong>3. T2 tries to insert into the gap.</strong>
      <code>INSERT INTO t VALUES (15)</code> from a separate connection needs
      to place a new index entry inside the (10, 20) gap — the exact space
      T1's next-key lock on id=20 covers.
    </div>
    <div class="stepper-panel">
      <strong>4. T2 blocks.</strong> No row named "15" exists for T2 to
      conflict with — this is a lock-wait purely on the gap, not on any
      record. T2 sits waiting (and can eventually hit a lock-wait timeout) for
      as long as T1 holds the transaction open.
    </div>
    <div class="stepper-panel">
      <strong>5. T1 commits (or rolls back).</strong> Its next-key locks
      release, T2's blocked INSERT proceeds, and id=15 is now in the table —
      but only after T1 was done, which is exactly the phantom-read
      prevention working as intended.
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
    <button data-toggle-opt="rr" class="active state-ok">REPEATABLE READ (InnoDB default)</button>
    <button data-toggle-opt="rc" class="state-warn">READ COMMITTED</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="rr">
    Range scans take next-key locks — record lock + gap lock combined. A
    concurrent INSERT into a locked gap blocks even though it doesn't touch
    any row the first transaction locked. This is InnoDB going beyond what
    the SQL standard's REPEATABLE READ technically requires: phantom reads
    are prevented as a side effect of how the locking is implemented, not
    because the isolation level's definition demands it.
  </div>
  <div class="toggle-panel" data-toggle-panel="rc">
    Gap locks are turned off — InnoDB uses plain record locks only. A range
    query only locks the rows it actually matched, so a concurrent INSERT
    into the "gap" between matched rows never conflicts with anything and
    goes through immediately. The tradeoff is explicit: phantom reads ARE
    possible under READ COMMITTED, re-running the same range query inside the
    same transaction can return a row that wasn't there the first time.
  </div>
</div>

This is precisely why gap-lock blocking catches developers off guard when they're used to another database's READ COMMITTED-style semantics (or MySQL's own READ COMMITTED): an INSERT that looks completely unrelated to a concurrent `SELECT ... FOR UPDATE` — different id, no row in common — can still sit in a lock wait, and `SHOW ENGINE INNODB STATUS\G` will show it waiting on a gap, not a row. That's a common, confusing source of production lock-wait timeouts that look like they "shouldn't" be possible.

<div class="quiz-card">
  <p class="quiz-q">Why does a plain row lock on the existing matching rows (id=10 and id=20) fail to prevent a new row, id=15, from being inserted between them?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>A row lock can only lock a row that already exists — there's no row object for id=15 to attach a lock to before it's inserted, so a plain record lock on 10 and 20 leaves the space between them completely unprotected. That's exactly the gap a next-key lock's gap-lock component is there to close, by locking the empty space itself rather than any row in it.</div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A developer used to READ COMMITTED semantics is confused: their concurrent INSERT of a brand-new row doesn't touch any row locked by another transaction's SELECT ... FOR UPDATE, yet it still blocks. Why?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because under REPEATABLE READ (InnoDB's default), that SELECT ... FOR UPDATE took next-key locks, not plain record locks — the gap-lock half of a next-key lock blocks any INSERT landing in that gap regardless of whether the new row's id matches anything already locked. Under READ COMMITTED there are no gap locks at all, only record locks, so the same INSERT would go through immediately — which is exactly why this blocking feels surprising to someone reasoning from READ COMMITTED-style rules.</div>
</div>

---

## Deadlock Analysis

```mermaid
sequenceDiagram
    participant TX1 as Transaction 1
    participant TX2 as Transaction 2
    participant ROW_A as Row A
    participant ROW_B as Row B

    TX1->>ROW_A: SELECT ... FOR UPDATE (lock A)
    activate ROW_A
    TX2->>ROW_B: SELECT ... FOR UPDATE (lock B)
    activate ROW_B

    rect rgba(231, 76, 60, 0.15)
    TX1->>ROW_B: SELECT ... FOR UPDATE (waiting for B)
    TX2->>ROW_A: SELECT ... FOR UPDATE (waiting for A)
    Note over TX1,TX2: Circular wait — DEADLOCK.<br/>InnoDB's lock-wait-for graph detects the cycle
    end

    Note over TX2: InnoDB picks TX2 as victim<br/>(estimated less rollback work to undo)
    TX2-->>TX2: ERROR 1213: Deadlock — rolled back, must retry
    deactivate ROW_B
    TX1->>ROW_B: Lock acquired, continues
    deactivate ROW_A
```

InnoDB doesn't pick the victim by who detected the deadlock, or by who started first — it estimates which transaction has done less work to undo (fewer rows modified so far) and kills that one, since rolling back a shorter transaction is cheaper than rolling back a longer one.

<div class="quiz-card">
  <p class="quiz-q">In the deadlock above, why is TX2 killed and not TX1, given both are waiting on each other?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>InnoDB doesn't use "who asked first" — it picks whichever transaction is cheaper to roll back (less undo work done so far) as the victim, kills it with error 1213, and lets the other one proceed once its lock is freed. This is why deadlock-prone code should always retry on 1213 rather than treat it as fatal — the losing transaction did nothing wrong, it just cost less to undo.</div>
</div>

```sql
-- View last deadlock
SHOW ENGINE INNODB STATUS\G
-- Look for "LATEST DETECTED DEADLOCK" section
-- Shows: which transactions, which rows were locked, who was killed

-- Enable deadlock logging
innodb_print_all_deadlocks = ON  -- logs every deadlock to error log

-- Prevent deadlocks: always lock rows in the same order
-- Bad: TX1 locks A then B, TX2 locks B then A
-- Good: both always lock in alphabetical/ID order
```

---

## EXPLAIN and Index Optimization

```sql
-- Full EXPLAIN output
EXPLAIN FORMAT=JSON SELECT u.name, COUNT(o.id)
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.id\G

-- Key fields to check:
-- type: ALL (full scan bad), ref/eq_ref (good), range (ok), index (scan index only)
-- key: NULL means no index used
-- rows: estimated rows to examine
-- Extra: "Using filesort" or "Using temporary" = expensive

-- Find missing indexes
EXPLAIN SELECT * FROM orders WHERE user_id = 123 AND status = 'pending'\G
-- If type=ALL and rows=100000 → add composite index

CREATE INDEX idx_orders_user_status ON orders(user_id, status);

-- Covering index: index contains all columns the query needs (no table lookup)
CREATE INDEX idx_orders_covering ON orders(user_id, status, created_at, amount);
-- Query: SELECT amount FROM orders WHERE user_id=1 AND status='paid'
-- Extra: "Using index" → reads index only, never touches table rows
```

<div class="quiz-card">
  <p class="quiz-q">EXPLAIN shows Extra: "Using index" for a query. Does that just mean "an index was used," and is that automatically as good as it gets?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It means more specifically that this was a covering index read — every column the query needed was found in the index itself, with zero lookups into the actual table rows. That's a step better than a normal index lookup (type=ref/range with a key set but no "Using index" in Extra), which still has to fetch the full row from the clustered index after finding a match in a secondary index.</div>
</div>

---

## Partitioning

```sql
-- Range partitioning by year (for large time-series tables)
CREATE TABLE orders (
    id BIGINT NOT NULL,
    user_id BIGINT,
    amount DECIMAL(10,2),
    created_at DATETIME NOT NULL
)
PARTITION BY RANGE (YEAR(created_at)) (
    PARTITION p2022 VALUES LESS THAN (2023),
    PARTITION p2023 VALUES LESS THAN (2024),
    PARTITION p2024 VALUES LESS THAN (2025),
    PARTITION pmax  VALUES LESS THAN MAXVALUE
);

-- Query uses partition pruning automatically
EXPLAIN SELECT * FROM orders WHERE created_at BETWEEN '2024-01-01' AND '2024-12-31';
-- partitions: p2024  ← only scans 2024 partition, skips 2022-2023

-- Drop old partition instantly (no row-by-row DELETE)
ALTER TABLE orders DROP PARTITION p2022;  -- instant, reclaims disk space

-- List partitions and row counts
SELECT PARTITION_NAME, TABLE_ROWS, DATA_LENGTH/1024/1024 AS data_mb
FROM INFORMATION_SCHEMA.PARTITIONS
WHERE TABLE_NAME = 'orders';
```

Partition pruning happens purely from the WHERE clause's relationship to the partitioning expression — MySQL doesn't need to touch an index to decide which partitions to skip, it decides that from the partition definition itself, and only then applies whatever indexing exists inside the partitions it does scan.

<div class="quiz-card">
  <p class="quiz-q">A range-partitioned table has no index on created_at at all. A query filters WHERE created_at BETWEEN '2024-01-01' AND '2024-12-31'. Does partition pruning still work, and does it make the query fast on its own?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Pruning still works — EXPLAIN would show partitions: p2024, skipping p2022/p2023/pmax entirely, because pruning is decided from the partitioning expression, not from an index. But "fast" isn't guaranteed: without an index inside p2024, MySQL still has to full-scan every row in that one partition. Pruning shrinks how much gets scanned, it doesn't replace indexing within the partition it lands on.</div>
</div>

---

## Performance Schema — Real-Time Diagnostics

```sql
-- Top wait events (where time is spent)
SELECT EVENT_NAME, COUNT_STAR, SUM_TIMER_WAIT/1e12 AS total_sec
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE COUNT_STAR > 0
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;

-- I/O by table
SELECT OBJECT_SCHEMA, OBJECT_NAME,
       COUNT_READ, SUM_TIMER_READ/1e12 AS read_sec,
       COUNT_WRITE, SUM_TIMER_WRITE/1e12 AS write_sec
FROM performance_schema.table_io_waits_summary_by_table
ORDER BY (SUM_TIMER_READ + SUM_TIMER_WRITE) DESC LIMIT 10;

-- Current connections with their last query
SELECT PROCESSLIST_ID, PROCESSLIST_USER, PROCESSLIST_HOST,
       PROCESSLIST_DB, PROCESSLIST_COMMAND, PROCESSLIST_TIME,
       LEFT(PROCESSLIST_INFO, 100) AS query
FROM performance_schema.processlist
WHERE PROCESSLIST_COMMAND != 'Sleep'
ORDER BY PROCESSLIST_TIME DESC;
```

---

## Key Monitoring Queries

```sql
-- Buffer pool hit rate (target > 99%)
SELECT (1 - Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests) * 100 AS hit_rate_pct
FROM (
    SELECT variable_value AS Innodb_buffer_pool_reads FROM information_schema.global_status WHERE variable_name = 'Innodb_buffer_pool_reads'
) r, (
    SELECT variable_value AS Innodb_buffer_pool_read_requests FROM information_schema.global_status WHERE variable_name = 'Innodb_buffer_pool_read_requests'
) rr;

-- Replication lag in seconds
SHOW REPLICA STATUS\G
-- Seconds_Behind_Source: 0 = in sync, >30 = alert

-- InnoDB row lock waits (high = contention)
SHOW STATUS LIKE 'Innodb_row_lock%';
-- Innodb_row_lock_waits: cumulative waits
-- Innodb_row_lock_time_avg: average wait ms

-- Table sizes
SELECT table_name,
       round(data_length/1024/1024, 1) AS data_mb,
       round(index_length/1024/1024, 1) AS index_mb,
       table_rows
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY data_length + index_length DESC LIMIT 20;
```
