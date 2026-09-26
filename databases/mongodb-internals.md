# MongoDB Internals

How MongoDB actually stores, replicates, and serves documents underneath `mongosh` — the storage engine, the oplog, how an election really resolves, and the write-concern arithmetic that decides whether a failover loses data. For the operational side of running this on real VMs (firewall rules, `mongod.conf`, the Prometheus exporter, a step-by-step bootstrap), see [on-prem-vm/mongodb.md](../on-prem-vm/mongodb.md); for the Kubernetes-operator version, see [on-prem-k8s/mongodb.md](../on-prem-k8s/mongodb.md).

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## WiredTiger Storage Engine

Every write goes through the same three structures, whether it's a single `insertOne` or a bulk load:

```mermaid
graph TD
    classDef engine fill:#2c3e50,stroke:#1a252f,color:#fff,rx:6
    classDef mem fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef durable fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef disk fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6

    CLIENT["MongoDB client"] -->|"insert / update / delete"| MONGOD["mongod process"]
    MONGOD --> WT["WiredTiger Storage Engine"]:::engine

    subgraph WT["WiredTiger"]
        CACHE["WT Cache — in-memory B-tree pages<br/>size: wiredTigerCacheSizeGB<br/>default: 50% of (RAM − 1GB)"]:::mem
        JOURNAL["Journal (WAL)<br/>append-only, fsynced every 100ms<br/>or immediately if j:true"]:::durable
        CHECKPOINT["Checkpoint<br/>every 60s or 2GB of journal written<br/>flushes dirty cache pages to disk"]:::durable
    end

    CACHE -->|"dirty pages"| CHECKPOINT
    CHECKPOINT --> DATA["Collection files (.wt)<br/>B-tree, snappy-compressed by default"]:::disk
    CHECKPOINT --> IDX["Index files (.wt)<br/>B-tree on _id + user indexes"]:::disk
    JOURNAL -.->|"replayed on crash recovery<br/>if newer than last checkpoint"| DATA
```

The journal and the checkpoint solve two different failure windows. A crash between checkpoints only loses what's replayable from the journal — that's why the journal is fsynced far more often (100ms) than a full checkpoint runs (60s). Without the journal, a crash mid-checkpoint could lose everything written since the *previous* checkpoint, not just the last 100ms.

<div class="quiz-card">
  <p class="quiz-q">mongod crashes 30 seconds after the last checkpoint, with the journal enabled. How much data is lost?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>None, assuming the journal itself synced. On restart, WiredTiger replays journal entries written after the last checkpoint to bring the data files back up to date. The checkpoint is a durability <em>floor</em>, not a durability <em>ceiling</em> — the journal covers everything since.</div>
</div>

### Sizing the cache

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Start from total RAM.</strong> A dedicated MongoDB host with 32 GB RAM is the baseline for this example.
    </div>
    <div class="stepper-panel">
      <strong>2. Apply roughly 40–50% of RAM, not the raw default.</strong> WiredTiger's own default is <code>(RAM − 1GB) × 0.5</code>, but on a real production host you also want headroom for per-connection memory (allocated <em>outside</em> the WiredTiger cache) and the OS page cache. 32 GB → <code>cacheSizeGB: 12–14</code> is a safer starting point than the raw default.
    </div>
    <div class="stepper-panel">
      <strong>3. Watch eviction, not just hit ratio.</strong> <code>db.serverStatus().wiredTiger.cache</code> exposes <em>"pages evicted because they exceeded the in-memory maximum"</em> and <em>"tracked dirty bytes in the cache."</em> Rising eviction under normal load means the cache is undersized for the working set.
    </div>
    <div class="stepper-panel">
      <strong>4. Never approach 100% of RAM.</strong> A saturated WiredTiger cache starves the OS page cache — which is what makes oplog reads and secondary catch-up fast — and starves per-connection buffers, which live outside WiredTiger entirely. The result is worse than a smaller, stable cache: constant eviction pressure and possible swapping.
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
  <p class="quiz-q">A host has 64 GB RAM. Someone sets cacheSizeGB: 60 to "maximize" MongoDB's cache. What breaks in production?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Only 4 GB is left for the OS, the filesystem page cache, and per-connection memory — which MongoDB allocates outside WiredTiger. The page cache is what makes secondary catch-up and repeated reads fast; starve it and every cache miss goes straight to disk. Under real connection load the host can start swapping, which turns into severe, hard-to-diagnose latency spikes. ~50% of RAM is the practical ceiling, not a floor to push past.</div>
</div>

---

## Document Model and BSON

MongoDB stores documents as BSON (Binary JSON), not JSON text:

```
BSON document: {_id: ObjectId("..."), name: "Alice", age: 30}

Binary encoding:
[doc_length 4B][type 1B][key "name\0"][value "Alice"][type 1B][key "age\0"][value 30 4B]...[terminator 0x00]
```

**Why BSON, not JSON:** the length-prefixed encoding means WiredTiger (and any driver) can skip over a field without parsing its contents — it just reads the 4-byte length and jumps. BSON also has native types JSON lacks: `Date`, `ObjectId`, `Binary`, `Decimal128` — a JSON encoding would have to represent all of these as strings and lose type fidelity.

**ObjectId** is 12 bytes: 4-byte timestamp + 5-byte random value + 3-byte incrementing counter. That construction is deliberate — it's sortable by creation time, globally unique without a central sequence generator, and safe to generate on any node (including offline clients) without coordination.

<div class="quiz-card">
  <p class="quiz-q">Two documents are inserted from different application servers within the same second, with no shared database sequence. Why don't their ObjectIds collide?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The 5-byte random value component makes a collision astronomically unlikely even without coordination between the two servers, and the 3-byte counter (per-process, incrementing) further guarantees uniqueness for IDs generated in rapid succession on the same process. No central authority or round-trip to the database is needed to generate a safe ID.</div>
</div>

---

## Replication: Oplog, Elections &amp; Quorum

### The oplog

The oplog is a capped collection in the `local` database (`local.oplog.rs`). Every write on the primary is recorded as an **idempotent** operation — replaying the same oplog entry twice produces the same result, which is what makes replica catch-up and resync safe to retry.

```mermaid
sequenceDiagram
    participant P as Primary — local.oplog.rs
    participant S1 as Secondary 1
    participant S2 as Secondary 2

    Note over P: client write commits locally first
    P->>P: append idempotent entry to oplog
    par tailing cursor per secondary
        S1->>P: tail oplog (long-lived cursor, not polling)
        P-->>S1: stream new entries as they're appended
        S1->>S1: apply entry, advance local optime
    and
        S2->>P: tail oplog (long-lived cursor)
        P-->>S2: stream new entries
        S2->>S2: apply entry, advance local optime
    end
    Note over S1,S2: each secondary's "optime" is how far it has replayed —<br/>this is exactly what rs.status() reports as replication lag
```

**Op types:** `i` (insert), `u` (update), `d` (delete), `c` (command — `createCollection`, `dropCollection`), `n` (no-op / keepalive, also used to fill in a stable point for chained replication).

**Oplog window:** capped at a fixed size — default 5% of disk space, minimum ~1 GB. If a secondary falls behind by more than the oplog window (its next needed entry has already rolled off), it can no longer catch up incrementally and must perform a full initial resync instead.

<div class="quiz-card">
  <p class="quiz-q">A secondary was network-partitioned for 6 hours. The primary's oplog only covers the last 4 hours of writes at current write volume. What happens when the secondary reconnects?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The secondary can't resume incremental replication — the oplog entry it needs next has already been overwritten (the oplog is a capped collection). MongoDB falls back to a full initial sync: wipe the secondary's data directory and copy everything from the primary from scratch. This is exactly why oplog size should be set generously relative to expected downtime windows, not just current write volume.</div>
</div>

### Elections and quorum

A replica set elects a primary by majority vote among voting members. An **arbiter** is a voting member that holds no data — it exists purely to break ties cheaply, without paying for a full extra data copy.

```mermaid
graph TD
    classDef primary fill:#e74c3c,stroke:#c0392b,color:#fff,rx:6
    classDef secondary fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef arbiter fill:#f39c12,stroke:#ba6018,color:#fff,rx:6

    HB["Secondary misses primary heartbeat<br/>(default electionTimeoutMillis: 10s)"] --> NOM["Eligible secondary calls for election<br/>(nominates itself as candidate)"]
    NOM --> VOTE["Every voting member casts one vote<br/>higher priority + more up-to-date optime wins ties"]
    VOTE --> MAJ{"Candidate got<br/>a majority of votes?"}
    MAJ -->|Yes| NEWP["Candidate becomes PRIMARY<br/>starts accepting writes"]:::primary
    MAJ -->|No — split vote or<br/>no majority reachable| RETRY["Election fails, cluster stays without<br/>a primary; retried after a randomized backoff"]

    subgraph "3-member set example"
        P["Primary (1 vote)"]:::primary
        S["Secondary (1 vote)"]:::secondary
        A["Arbiter (1 vote, no data)"]:::arbiter
    end
```

**Why votes ≠ data copies:** an arbiter's vote counts exactly the same as a data-bearing secondary's vote when computing whether a write reached `w: "majority"`, or whether an election has a quorum — but it holds zero bytes of actual data. A 3-member Primary-Secondary-Arbiter (PSA) set only needs 2 of 3 votes to elect a new primary or acknowledge a majority write, and primary + arbiter alone satisfies that majority — even though the arbiter can never *serve* that data if the primary then dies.

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="psa" class="active state-warn">PSA (Primary-Secondary-Arbiter)</button>
    <button data-toggle-opt="pss" class="state-ok">PSS (Primary-Secondary-Secondary)</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="psa">
    3 voting members, only 2 hold data. Cheaper to run (the arbiter needs almost no resources), and still gets majority-write durability in the common case. The gap: if the primary and arbiter both acknowledge a write but the secondary hasn't replicated it yet, and the primary then dies, that write is gone — the arbiter has no copy to hand to a new primary.
  </div>
  <div class="toggle-panel" data-toggle-panel="pss">
    3 voting members, all 3 hold data. Costs a full third data copy, but a majority write is guaranteed to exist on at least 2 real copies at all times — there's no "phantom vote" scenario. This is the safer topology when write durability matters more than infrastructure cost.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">In a PSA set, the secondary is temporarily unreachable. A write arrives at the primary with w: "majority". Does it succeed, and is it fully safe?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It succeeds — primary + arbiter is 2 of 3 votes, a majority, so w:"majority" is satisfied without the secondary. But "acknowledged" isn't the same as "safely durable on a second copy": the arbiter holds no data, so this write exists only on the primary. If the primary crashes before the secondary reconnects and catches up, that write is lost. This exact gap is the tradeoff of PSA vs. PSS.</div>
</div>

### Try It Yourself: Live PSA Election

This is a different election model than the Raft demo elsewhere in this repo
([replication.md](replication.md)) — worth being precise about the
difference rather than treating "leader election" as one interchangeable
mechanic. Raft's demo picks whichever node happens to time out first and
wins purely on term number and majority; the first candidate to campaign
wins as long as its log qualifies. MongoDB's election is **priority-weighted**:
each member has a configured `priority` (default 1, arbiters always 0), a
member only calls an election after missing heartbeats for
`electionTimeoutMillis` (default 10s), and a higher-priority secondary that
is otherwise healthy can trigger its own election and take over from a
lower-priority primary even with no failure at all — a "priority takeover,"
not just a race to time out first. The demo below models that, plus the PSA
topology's specific risk: an **arbiter** votes but holds no data and can
never itself become primary.

Default topology is PSA: `P1` (priority 1, data), `S1` (priority 1, data,
starts as PRIMARY), `A1` (arbiter — priority 0, no data). Click any node to
kill or revive it, use "Kill Primary" to force a failover, or add a
differently-prioritized secondary and watch it take over. Majority here is
computed against the full configured voting membership (not just currently
up nodes) — this is what makes the risk case below possible: kill the
arbiter, then kill either remaining data node, and the cluster has only 1
of 3 votes left and cannot elect anyone.

<div class="structure-viz" id="mongo-election-viz">
  <svg class="viz-canvas" viewBox="0 0 640 170"></svg>
  <div class="viz-controls">
    <button class="viz-btn viz-btn-danger" data-viz-action="kill-primary">Kill Primary</button>
    <input class="viz-input" type="text" placeholder="node name" data-viz-field="name" style="width:6rem" />
    <input class="viz-input" type="number" placeholder="priority" data-viz-field="priority" style="width:5rem" />
    <button class="viz-btn" data-viz-action="add">Add Node</button>
    <button class="viz-btn" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background:#14532d"></span> Primary</span>
    <span><span class="viz-swatch" style="background:#1e3a8a"></span> Secondary (up)</span>
    <span><span class="viz-swatch" style="background:#7f1d1d"></span> Down</span>
    <span><span class="viz-swatch" style="background:#f39c12"></span> Arbiter (diamond, no data)</span>
    <span>Click any node box to kill/revive it.</span>
  </div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root0 = document.getElementById('mongo-election-viz');
  const svg = root0.querySelector('.viz-canvas');
  const status = root0.querySelector('.viz-status');
  const nameField = root0.querySelector('[data-viz-field="name"]');
  const priorityField = root0.querySelector('[data-viz-field="priority"]');

  let nodes;

  // ---- Core election logic (no DOM) --------------------------------------
  // Mirrors this section's own narration: priority-weighted election (the
  // highest-priority ELIGIBLE data-bearing node wins, not just any majority
  // winner), majority computed over ALL configured voting members (alive or
  // not — this is what makes the PSA risk below possible), and the arbiter
  // can vote but can never itself become primary.

  function makeInitialNodes() {
    return [
      { id: 'P1', priority: 1, hasData: true, isArbiter: false, alive: true, isPrimary: false },
      { id: 'S1', priority: 1, hasData: true, isArbiter: false, alive: true, isPrimary: true },
      { id: 'A1', priority: 0, hasData: false, isArbiter: true, alive: true, isPrimary: false },
    ];
  }

  function eligibleCandidates(list) {
    return list.filter((n) => n.hasData && n.alive);
  }

  function pickCandidate(eligible) {
    if (!eligible.length) return null;
    return eligible.slice().sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
  }

  function majorityNeeded(list) {
    return Math.floor(list.length / 2) + 1;
  }

  function evaluate(list) {
    const total = list.length;
    const majority = majorityNeeded(list);
    const aliveCount = list.filter((n) => n.alive).length;
    const eligible = eligibleCandidates(list);
    const messages = [];

    if (eligible.length === 0) {
      list.forEach((n) => { n.isPrimary = false; });
      messages.push('No data-bearing node is up — no eligible candidate, no primary.');
      return { messages, primaryId: null };
    }

    messages.push('Eligible: ' + eligible.map((n) => n.id + ' (priority ' + n.priority + ')').join(', ') + '.');

    if (aliveCount < majority) {
      list.forEach((n) => { n.isPrimary = false; });
      let m = 'Only ' + aliveCount + ' voter(s) alive (need ' + majority + ' for majority of ' + total + ') — cluster cannot elect a primary.';
      const arbiter = list.find((n) => n.isArbiter);
      if (arbiter && !arbiter.alive) {
        m += ' This is the PSA topology risk this file describes: losing the arbiter plus one data node loses you majority entirely.';
      }
      messages.push(m);
      return { messages, primaryId: null };
    }

    const current = list.find((n) => n.isPrimary && n.alive && n.hasData);
    let candidate;
    let isTakeover = false;

    if (current) {
      const outranking = eligible.filter((n) => n.priority > current.priority);
      if (outranking.length === 0) {
        messages.push(current.id + ' remains PRIMARY (' + aliveCount + '/' + total + ' votes available).');
        return { messages, primaryId: current.id };
      }
      candidate = pickCandidate(outranking);
      isTakeover = true;
    } else {
      candidate = pickCandidate(eligible);
    }

    const arbiter = list.find((n) => n.isArbiter);
    if (arbiter && arbiter.alive && candidate.id !== arbiter.id) {
      messages.push('Arbiter ' + arbiter.id + ' votes for ' + candidate.id + '.');
    }
    list.forEach((n) => { n.isPrimary = n.id === candidate.id; });
    if (isTakeover) {
      messages.push(candidate.id + ' (priority ' + candidate.priority + ') outranks current primary ' + current.id + ' (priority ' + current.priority + ') — priority takeover. ' + candidate.id + ' has ' + aliveCount + '/' + total + ' votes, majority reached, ' + candidate.id + ' becomes PRIMARY.');
    } else {
      messages.push(candidate.id + ' has ' + aliveCount + '/' + total + ' votes — majority reached, ' + candidate.id + ' becomes PRIMARY.');
    }
    return { messages, primaryId: candidate.id };
  }

  function killPrimaryAction(list) {
    const primary = list.find((n) => n.isPrimary && n.alive);
    if (!primary) {
      return { messages: ['No primary is currently alive — nothing to kill.'], ok: false };
    }
    primary.alive = false;
    primary.isPrimary = false;
    const msgs = [primary.id + ' (Primary) down.'];
    const res = evaluate(list);
    return { messages: msgs.concat(res.messages), ok: res.primaryId !== null };
  }

  function toggleNodeAction(list, id) {
    const node = list.find((n) => n.id === id);
    if (!node) return { messages: ['No node named ' + id + '.'], ok: false };
    node.alive = !node.alive;
    if (!node.alive) node.isPrimary = false;
    const msgs = [node.id + (node.isArbiter ? ' (arbiter)' : '') + ' ' + (node.alive ? 'revived' : 'killed') + '.'];
    const res = evaluate(list);
    return { messages: msgs.concat(res.messages), ok: res.primaryId !== null };
  }

  function addNodeAction(list, name, priority) {
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      return { messages: ['Enter a valid node name (letters, digits, -, _).'], ok: false };
    }
    if (list.some((n) => n.id === name)) {
      return { messages: ['A node named ' + name + ' already exists.'], ok: false };
    }
    if (!Number.isFinite(priority) || priority < 0) {
      return { messages: ['Priority must be a non-negative number.'], ok: false };
    }
    list.push({ id: name, priority: priority, hasData: true, isArbiter: false, alive: true, isPrimary: false });
    const msgs = [name + ' added as secondary (priority ' + priority + ', data-bearing).'];
    const res = evaluate(list);
    return { messages: msgs.concat(res.messages), ok: res.primaryId !== null };
  }

  // ---- Rendering -----------------------------------------------------------

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = 'viz-status' + (kind === 'ok' ? ' viz-status-ok' : kind === 'error' ? ' viz-status-error' : '');
  }

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function text(x, y, str, cls) {
    const t = el('text', cls ? { x: x, y: y, class: cls } : { x: x, y: y });
    t.textContent = str;
    return t;
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const n = nodes.length;
    const boxW = Math.max(80, Math.min(120, Math.floor((640 - (n + 1) * 16) / n)));
    const boxH = 100;
    const gap = Math.floor((640 - n * boxW) / (n + 1));
    const y = 30;

    nodes.forEach((node, i) => {
      const x = gap + i * (boxW + gap);
      const cx = x + boxW / 2;
      const cy = y + boxH / 2;

      let cls = 'viz-node';
      if (!node.alive) cls = 'viz-node-removing';
      else if (node.isPrimary) cls = 'viz-node-new';

      const g = el('g', { style: 'cursor:pointer' });
      g.addEventListener('click', () => {
        const res = toggleNodeAction(nodes, node.id);
        setStatus(res.messages.join(' '), res.ok ? 'ok' : (res.messages.join(' ').indexOf('cannot elect') >= 0 ? 'error' : 'ok'));
        draw();
      });

      if (node.isArbiter) {
        const points = [
          [cx, y],
          [x + boxW, cy],
          [cx, y + boxH],
          [x, cy],
        ].map((p) => p[0] + ',' + p[1]).join(' ');
        g.appendChild(el('polygon', { points: points, class: cls }));
      } else {
        g.appendChild(el('rect', { x: x, y: y, width: boxW, height: boxH, rx: 8, class: cls }));
      }

      g.appendChild(text(cx, cy - 26, node.id));
      if (node.isArbiter) {
        g.appendChild(text(cx, cy - 8, 'ARBITER', 'viz-label-dim'));
        g.appendChild(text(cx, cy + 6, 'no data', 'viz-label-dim'));
      } else {
        g.appendChild(text(cx, cy - 8, 'priority ' + node.priority, 'viz-label-dim'));
      }
      g.appendChild(text(cx, cy + 24, !node.alive ? 'DOWN' : (node.isPrimary ? 'PRIMARY' : 'secondary')));

      svg.appendChild(g);
    });
  }

  root0.querySelector('[data-viz-action="kill-primary"]').addEventListener('click', () => {
    const res = killPrimaryAction(nodes);
    const joined = res.messages.join(' ');
    setStatus(joined, res.ok ? 'ok' : 'error');
    draw();
  });

  root0.querySelector('[data-viz-action="add"]').addEventListener('click', () => {
    const name = nameField.value.trim();
    const priority = parseInt(priorityField.value, 10);
    const res = addNodeAction(nodes, name, priority);
    const joined = res.messages.join(' ');
    const failed = /Enter a valid|already exists|must be a non-negative/.test(joined);
    setStatus(joined, failed ? 'error' : (res.ok ? 'ok' : 'error'));
    if (!failed) { nameField.value = ''; priorityField.value = ''; }
    draw();
  });

  root0.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    nodes = makeInitialNodes();
    setStatus('Reset to the default PSA set: P1 (priority 1), S1 (priority 1, PRIMARY), A1 (arbiter, no data).', '');
    draw();
  });

  nodes = makeInitialNodes();
  setStatus('PSA set loaded: P1 (priority 1), S1 (priority 1, PRIMARY), A1 (arbiter, no data, votes but never becomes primary). Click a node to kill/revive it, or use Kill Primary to force a failover.', '');
  draw();
})();
</script>

### Rollback on rejoin

If the old primary had writes that were never replicated to any secondary before it crashed, and a new primary was elected and continued accepting new writes, the two oplogs have diverged. When the old primary rejoins as a secondary, MongoDB **rolls back** its un-replicated writes — moving them out to a rollback directory as BSON files rather than silently discarding them — so it can resync onto the new primary's oplog history.

<div class="quiz-card">
  <p class="quiz-q">After a rollback, where do the discarded writes actually go, and how would you recover one if it turned out to matter?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>They're written out as BSON files under the data directory's rollback folder — not deleted outright. An operator can inspect them (e.g. with bsondump) and manually replay any writes that need to be recovered. The best fix, though, is prevention: requiring w:"majority" before acknowledging a write to the client means a write can't be "confirmed" to an application unless it already exists on enough copies to survive exactly this scenario.</div>
</div>

---

## Write Concern and Read Concern — Deep Dive

Write concern controls how many replica set members must acknowledge a write before the client is told it succeeded. Getting this wrong is the single most common cause of "the failover ate my data."

```mermaid
sequenceDiagram
    participant APP as Application
    participant PRI as Primary
    participant SEC as Secondary

    Note over APP,SEC: writeConcern: {w: "majority", j: true}
    APP->>PRI: insert document
    PRI->>PRI: write to journal (j:true = fsync before ack)
    PRI->>SEC: replicate via oplog tailing
    SEC->>SEC: write to journal + apply
    SEC-->>PRI: acknowledge
    Note over PRI: majority (2/3 votes) confirmed
    PRI-->>APP: write result: confirmed

    Note over APP,SEC: readConcern: "majority"
    APP->>PRI: find({_id: ...}) with majority read concern
    PRI->>PRI: only return data already committed to a majority
    Note over PRI: won't return data that could still be rolled back
    PRI-->>APP: document (guaranteed stable, won't vanish on failover)
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="w0" class="active">w: 0</button>
    <button data-tab="w1">w: 1</button>
    <button data-tab="wmaj">w: "majority"</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="w0">
      <strong>Fire and forget.</strong> mongod returns immediately without waiting for any acknowledgement — not even from the primary's own in-memory buffer. Maximum throughput. Fine for metrics/logs/events where losing a few is acceptable; never for financial, user, or transactional data.
    </div>
    <div class="tab-panel" data-tab-panel="w1">
      <strong>Primary only (default before MongoDB 5.0).</strong> Fastest option that still confirms the write landed somewhere. Risk: if the primary crashes before replicating to any secondary, the write is lost — whichever secondary gets elected next never had it.
    </div>
    <div class="tab-panel" data-tab-panel="wmaj">
      <strong>Majority of voting members (recommended).</strong> At least 2 of 3 votes must acknowledge before the client sees success. If the primary then fails, whoever gets elected next already has the data. One extra round-trip of latency, in exchange for a durability guarantee that survives failover.
    </div>
  </div>
</div>

| Write concern | Data loss on failover | Latency |
|---|---|---|
| `{w: 0}` | Yes, silently | Lowest |
| `{w: 1}` | Yes, if only the primary had it | Low |
| `{w: "majority"}` | No | +1 replica round-trip |
| `{w: "majority", j: true}` | No, and disk-durable | Highest |

<div class="quiz-card">
  <p class="quiz-q">Why does pairing w: "majority" with j: true matter, when majority already implies more than one copy exists?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>"Majority" is about how many <em>members</em> acknowledged, not whether each one's copy actually hit disk. Without j:true, a member could acknowledge a write that's still only in its in-memory WiredTiger cache — if that specific member then crashes before its next journal fsync, its copy of the "acknowledged, majority-confirmed" write is gone too. j:true forces the journal fsync before acknowledging, closing that gap.</div>
</div>

---

## Aggregation Pipeline

An aggregation is a sequence of stages, each one transforming the document stream from the previous stage:

```mermaid
graph LR
    COLL["orders collection"] --> MATCH["$match<br/>{status:'paid', created_at:{$gte:...}}"]
    MATCH --> LOOKUP["$lookup<br/>join users by user_id"]
    LOOKUP --> UNWIND["$unwind<br/>flatten joined array"]
    UNWIND --> GROUP["$group<br/>{_id:'$user_id', total:{$sum:'$amount'}}"]
    GROUP --> MATCH2["$match<br/>post-group filter: total >= 1000"]
    MATCH2 --> SORT["$sort<br/>{total:-1}"]
    SORT --> LIMIT["$limit: 100"]
    LIMIT --> OUT["Result stream"]
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Early $match.</strong> Filtering before anything else shrinks the document set every later stage has to process — and, critically, an early $match can use an index the same way a normal find() would. A $match placed after other stages can't.
    </div>
    <div class="stepper-panel">
      <strong>2. $lookup + $unwind.</strong> $lookup joins in an array of matching documents from another collection (like a left outer join); $unwind flattens that array back into one document per match so later stages can treat it as a flat field.
    </div>
    <div class="stepper-panel">
      <strong>3. $group.</strong> Collapses many documents into one per group key, computing accumulators ($sum, $avg, $push, ...) along the way. This is usually the point where the pipeline stops being index-eligible — the output no longer resembles the original documents.
    </div>
    <div class="stepper-panel">
      <strong>4. Post-group $match, $sort, $limit.</strong> Filtering and sorting on computed fields (like the group's total) has to happen after $group produces them — there's no index to use here since these are runtime-computed values.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```javascript
db.orders.aggregate([
    {$match:  {status:"paid", created_at:{$gte: new Date("2024-01-01")}}},  // filter early, index-eligible
    {$lookup: {from:"users", localField:"user_id", foreignField:"_id", as:"user"}},
    {$unwind: "$user"},
    {$group:  {_id:"$user_id", total:{$sum:"$amount"}, count:{$sum:1}}},
    {$match:  {total:{$gte:1000}}},   // post-group filter, no index available here
    {$sort:   {total:-1}},
    {$limit:  100},
    {$project:{_id:0, user_id:"$_id", total:1, count:1}}
], {allowDiskUse: true})   // needed once an intermediate stage's working set exceeds 100MB RAM
```

`explain('executionStats')` on an aggregation shows exactly which stages used an index (`IXSCAN`) versus a full scan — the same distinction as a plain `find()`.

<div class="quiz-card">
  <p class="quiz-q">Why can't the $match after $group in the pipeline above use an index, even though there's an index on total?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Trick question — there's no index on total to begin with, because total doesn't exist until $group computes it. Indexes are built on stored document fields, not on values synthesized mid-pipeline. Any $match, $sort, or $limit placed after a $group that references a computed field always runs unindexed.</div>
</div>

---

## Index Types

```javascript
// Standard B-tree
db.users.createIndex({email: 1})                    // ascending
db.users.createIndex({email: 1, status: 1})         // compound
db.users.createIndex({email: 1}, {unique: true})    // unique

// Partial index — only indexes matching documents, smaller and faster
db.users.createIndex({email: 1}, {
    partialFilterExpression: {deleted: {$exists: false}}
})

// TTL index — auto-deletes documents N seconds after createdAt
db.sessions.createIndex({createdAt: 1}, {expireAfterSeconds: 3600})

// Text index — full-text search
db.posts.createIndex({body: "text", title: "text"})
db.posts.find({$text: {$search: "kubernetes failover"}})

// Geospatial
db.locations.createIndex({coords: "2dsphere"})
db.locations.find({coords: {$near: {$geometry: {type:"Point", coordinates:[77.2,28.6]}, $maxDistance: 1000}}})
```

<div class="quiz-card">
  <p class="quiz-q">A TTL index is set with expireAfterSeconds: 3600 on a field called createdAt. A background job deletes stale sessions after exactly 60 minutes, right on the second. Is that guaranteed?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. TTL deletion runs via a background thread that sweeps expired documents roughly once every 60 seconds, not instantly at the expiry timestamp — so documents can live up to ~1 minute past their nominal expiry. TTL indexes are for eventual cleanup, not a precise expiry guarantee; don't rely on them for time-sensitive access-control logic.</div>
</div>

---

## explain() — Query Analysis

```javascript
// Find execution plan
db.orders.find({user_id: "123", status: "paid"}).explain("executionStats")
// winningPlan.stage: "COLLSCAN" = full scan (bad) | "IXSCAN" = index (good)
// executionStats.totalDocsExamined vs totalDocsReturned: large ratio = missing index

// Compound index matching the query shape
db.orders.createIndex({user_id: 1, status: 1})

// Covering index: every projected field is in the index itself — zero document fetches
db.orders.createIndex({user_id: 1, status: 1, amount: 1})
db.orders.find({user_id: "123"}, {status: 1, amount: 1, _id: 0})
// explain shows "Using index" — no heap/document reads at all
```

<div class="quiz-card">
  <p class="quiz-q">explain() shows totalDocsExamined: 50,000 and totalDocsReturned: 12 for a query that IS using an index (IXSCAN, not COLLSCAN). Is that fine?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Not necessarily — a high examined-to-returned ratio even under IXSCAN usually means the index doesn't fully match the query's filter, so MongoDB is index-scanning a broad range and then filtering most of it out after fetching. The fix is typically a more selective compound index that matches more of the query's actual filter fields, not just "any index beats no index."</div>
</div>

---

## Transactions (4.0+)

```javascript
const session = db.getMongo().startSession();
session.startTransaction({ readConcern: {level: "snapshot"}, writeConcern: {w: "majority"} });
try {
    const accounts = session.getDatabase("bank").accounts;
    accounts.updateOne({_id: "alice"}, {$inc: {balance: -100}}, {session});
    accounts.updateOne({_id: "bob"},   {$inc: {balance:  100}}, {session});
    session.commitTransaction();
} catch (err) {
    session.abortTransaction();
    throw err;
} finally {
    session.endSession();
}
```

`readConcern: "snapshot"` gives every read inside the transaction a consistent point-in-time view — as if the whole transaction ran instantaneously — even though the two `updateOne` calls execute sequentially.

<div class="quiz-card">
  <p class="quiz-q">The commitTransaction() call above uses writeConcern: {w: "majority"}. If the primary crashes between the two updateOne calls and before commitTransaction, what happens to Alice's already-decremented balance?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Nothing persists — a multi-document transaction is atomic across all its operations. If it never reaches commitTransaction, none of its writes are visible or durable; MongoDB doesn't apply "half" of a transaction. On reconnect, the application's try/catch would see the error and should retry the whole transaction from scratch, not attempt to resume partway through.</div>
</div>

---

## Change Streams

A real-time feed of insert/update/delete events, built directly on top of the oplog.

```javascript
const stream = db.orders.watch([
    {$match: {"operationType": {$in: ["insert", "update"]}}},
    {$match: {"fullDocument.status": "paid"}}
]);
stream.on("change", change => processOrder(change.fullDocument));

// Crash recovery: persist the resumeToken, restart from exactly where you left off
const stream2 = db.orders.watch([], {resumeAfter: lastToken});
```

<div class="quiz-card">
  <p class="quiz-q">A change-stream consumer crashes and restarts 20 minutes later without a saved resumeToken. What happens to the events it missed?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>They're gone — a fresh watch() with no resumeAfter only sees events from the moment it starts, not a backlog. Since change streams read from the oplog, missed events are also permanently unrecoverable once they roll off the oplog window, the same limitation replication lag runs into. Always persist the resumeToken somewhere durable (not in-process memory) if the consumer needs to survive a restart without gaps.</div>
</div>

---

## Sharding

```mermaid
graph TD
    classDef router fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef cfg fill:#f39c12,stroke:#ba6018,color:#fff,rx:6
    classDef shard fill:#2980b9,stroke:#1f618d,color:#fff,rx:6

    APP["Application"] --> MONGOS["mongos router<br/>stateless — no data of its own"]:::router
    MONGOS -->|"chunk map lookup"| CFG["Config server replica set<br/>authoritative chunk-to-shard mapping"]:::cfg
    MONGOS -->|"routes query to the<br/>right shard(s) only"| S1["Shard 1 replica set<br/>user_id: 0 – 500K"]:::shard
    MONGOS --> S2["Shard 2 replica set<br/>user_id: 500K – 1M"]:::shard
    CFG -.->|"balancer moves chunks<br/>to keep shards even"| S1
    CFG -.-> S2
```

```javascript
sh.enableSharding("mydb")
sh.shardCollection("mydb.orders", {user_id: "hashed"})
// hashed  = even write distribution, but range queries scatter across every shard
// ranged  = supports efficient range queries, but monotonically increasing keys hotspot one shard

sh.getBalancerState()  // is the auto-balancer currently moving chunks?
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="hashed" class="active state-ok">Hashed shard key</button>
    <button data-toggle-opt="ranged" class="state-warn">Ranged shard key</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="hashed">
    MongoDB hashes the key before assigning it to a chunk range, so writes spread evenly across every shard regardless of the key's natural distribution. The cost: a query for a <em>range</em> of the original key (e.g. "all orders from March") can no longer target one shard — it has to scatter-gather across all of them, since hashed values don't preserve ordering.
  </div>
  <div class="toggle-panel" data-toggle-panel="ranged">
    Chunks are contiguous ranges of the actual key value, so range queries stay efficient — a query for "user_id between 100K and 200K" targets exactly the shard(s) holding that range. The cost: a monotonically increasing key (like an auto-incrementing ID or a timestamp) sends every new write to whichever shard currently holds the highest range — a hotspot, not distributed at all.
  </div>
</div>

### Try It Yourself: Live Chunk Split &amp; Migration

Pick a shard-key type, then insert values yourself. Try a monotonically
increasing sequence (1, 2, 3, 4, …) under each mode and watch what happens to
where the documents land — this is the same mechanism the toggle above
describes and the quiz below tests, just running live instead of asserted in
prose. Once one shard is visibly overloaded, click "Run balancer" and watch it
split that shard's biggest chunk and migrate half of it to the least-loaded
shard.

<div class="structure-viz" id="mongo-sharding-viz">
  <svg class="viz-canvas" viewBox="0 0 720 250"></svg>
  <div class="viz-controls">
    <button class="viz-btn" data-viz-action="set-mode" data-viz-mode="hashed">Hashed shard key</button>
    <button class="viz-btn" data-viz-action="set-mode" data-viz-mode="ranged">Ranged shard key</button>
    <input class="viz-input" type="number" placeholder="shard key value" data-viz-field="key" style="width:9rem" />
    <button class="viz-btn" data-viz-action="insert">Insert doc</button>
    <button class="viz-btn" data-viz-action="balance">Run balancer</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background:var(--warn)"></span> Just inserted</span>
    <span><span class="viz-swatch" style="background:var(--ok)"></span> Just split/migrated</span>
    <span>Each box is a chunk (key range + doc count); the bar shows load relative to the busiest chunk. Past 4 chunks on one shard, extras collapse into a "+N chunks" summary so the layout never overflows.</span>
  </div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root = document.getElementById('mongo-sharding-viz');
  const svg = root.querySelector('.viz-canvas');
  const status = root.querySelector('.viz-status');
  const keyField = root.querySelector('[data-viz-field="key"]');
  const modeButtons = root.querySelectorAll('[data-viz-action="set-mode"]');

  // ---- Core sharding logic (no DOM) --------------------------------------
  // Mirrors this section's own toggle copy: a hashed key scatters writes
  // evenly across shards regardless of insertion order; a ranged key keeps
  // chunks as contiguous ranges of the real value, so a monotonically
  // increasing key always lands in whichever chunk currently owns the
  // highest range -- a hotspot the balancer can migrate but never fully
  // prevent, since every *new* write still targets the same "latest" chunk.

  const RANGED_BOUNDARIES = [1000, 2000]; // 2 interior boundaries -> 3 ranges
  const HASH_SPACE = 1000;
  const HASH_BOUNDARIES = [334, 667];

  function knuthHash(n) {
    // Fibonacci/multiplicative hashing: scatters sequential integers across
    // buckets even though the input keys are monotonically increasing.
    const x = Math.imul(n | 0, 2654435761) >>> 0;
    return x % HASH_SPACE;
  }

  function effectiveKey(value, mode) {
    const n = Math.trunc(Number(value));
    return mode === 'hashed' ? knuthHash(n) : n;
  }

  function fmtBound(v) {
    if (v === -Infinity) return '-∞';
    if (v === Infinity) return '+∞';
    return String(v);
  }

  function makeInitialShards(mode) {
    const bounds = mode === 'hashed' ? HASH_BOUNDARIES : RANGED_BOUNDARIES;
    const shards = [];
    for (let i = 0; i < 3; i++) {
      shards.push({
        chunks: [{
          min: i === 0 ? -Infinity : bounds[i - 1],
          max: i === bounds.length ? Infinity : bounds[i],
          keys: [],
        }],
      });
    }
    return shards;
  }

  function cloneShards(shards) {
    return shards.map((s) => ({ chunks: s.chunks.map((c) => ({ min: c.min, max: c.max, keys: c.keys.slice() })) }));
  }

  function locateChunk(shards, key) {
    for (let s = 0; s < shards.length; s++) {
      const chunks = shards[s].chunks;
      for (let c = 0; c < chunks.length; c++) {
        const ch = chunks[c];
        if (key >= ch.min && key < ch.max) return { shardIndex: s, chunkIndex: c };
      }
    }
    return null;
  }

  function insertDocLogic(shards, value, mode) {
    const key = effectiveKey(value, mode);
    const loc = locateChunk(shards, key);
    if (!loc) return { shards: shards, ok: false, message: 'No chunk owns key ' + key + ' (unexpected).' };
    const next = cloneShards(shards);
    next[loc.shardIndex].chunks[loc.chunkIndex].keys.push(key);
    return { shards: next, ok: true, shardIndex: loc.shardIndex, chunkIndex: loc.chunkIndex, key: key };
  }

  function shardTotals(shards) {
    return shards.map((s) => s.chunks.reduce((sum, c) => sum + c.keys.length, 0));
  }

  function runBalancerLogic(shards) {
    const totals = shardTotals(shards);
    const totalDocs = totals.reduce((a, b) => a + b, 0);
    const maxTotal = Math.max.apply(null, totals);
    const minTotal = Math.min.apply(null, totals);
    const maxShardIdx = totals.indexOf(maxTotal);
    const minShardIdx = totals.indexOf(minTotal);
    const fairShare = totalDocs / shards.length;

    const imbalanced = totalDocs >= 3 && (maxTotal - minTotal) >= 2 && maxTotal > fairShare + 1;
    if (!imbalanced) {
      return { shards: shards, changed: false, message: 'Balanced — no migration needed (max ' + maxTotal + ' docs, min ' + minTotal + ' docs, fair share ~' + fairShare.toFixed(1) + ').' };
    }

    const next = cloneShards(shards);
    const sourceShard = next[maxShardIdx];
    let biggestIdx = 0;
    sourceShard.chunks.forEach((c, i) => { if (c.keys.length > sourceShard.chunks[biggestIdx].keys.length) biggestIdx = i; });
    const chunk = sourceShard.chunks[biggestIdx];

    if (chunk.keys.length < 2) {
      return { shards: shards, changed: false, message: 'Largest chunk on shard ' + maxShardIdx + ' only has ' + chunk.keys.length + ' doc(s) — nothing left to split.' };
    }

    const sortedKeys = chunk.keys.slice().sort((a, b) => a - b);
    const mid = sortedKeys[Math.floor(sortedKeys.length / 2)];
    const leftKeys = chunk.keys.filter((k) => k < mid);
    const rightKeys = chunk.keys.filter((k) => k >= mid);

    if (leftKeys.length === 0 || rightKeys.length === 0) {
      return { shards: shards, changed: false, message: 'Shard ' + maxShardIdx + '\'s largest chunk holds all-identical shard-key values — a "jumbo chunk" that cannot be split further (this is a real MongoDB failure mode too).' };
    }

    const leftChunk = { min: chunk.min, max: mid, keys: leftKeys };
    const rightChunk = { min: mid, max: chunk.max, keys: rightKeys };

    sourceShard.chunks.splice(biggestIdx, 1, leftChunk);
    next[minShardIdx].chunks.push(rightChunk);
    next.forEach((s) => s.chunks.sort((a, b) => a.min - b.min));

    const message = 'Split shard ' + maxShardIdx + '\'s chunk [' + fmtBound(chunk.min) + ', ' + fmtBound(chunk.max) + ') at ' + mid +
      ' — kept [' + fmtBound(leftChunk.min) + ', ' + fmtBound(mid) + ') (' + leftKeys.length + ' docs) on shard ' + maxShardIdx +
      ', migrated [' + fmtBound(mid) + ', ' + fmtBound(rightChunk.max) + ') (' + rightKeys.length + ' docs) to shard ' + minShardIdx + '.';

    return {
      shards: next,
      changed: true,
      message: message,
      left: { shardIndex: maxShardIdx, min: leftChunk.min, max: leftChunk.max },
      right: { shardIndex: minShardIdx, min: rightChunk.min, max: rightChunk.max },
    };
  }

  // ---- State --------------------------------------------------------------
  let mode = 'hashed';
  let state = { hashed: makeInitialShards('hashed'), ranged: makeInitialShards('ranged') };
  let lastInsert = null; // {shardIndex, min, max}
  let lastBalance = null; // {touched: [{shardIndex, min, max}, ...]}

  // ---- Rendering ------------------------------------------------------------
  const MAX_SLOTS = 4; // cap rendered chunk boxes per shard row so the layout
  // never overflows no matter how many splits accumulate in one session.

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = 'viz-status' + (kind === 'ok' ? ' viz-status-ok' : kind === 'error' ? ' viz-status-error' : '');
  }

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function text(x, y, str, cls) {
    const t = el('text', cls ? { x: x, y: y, class: cls } : { x: x, y: y });
    t.textContent = str;
    return t;
  }

  function currentModeLabel() {
    return mode === 'hashed' ? 'HASHED' : 'RANGED';
  }

  function refreshModeButtons() {
    modeButtons.forEach((btn) => {
      btn.disabled = btn.getAttribute('data-viz-mode') === mode;
    });
  }

  function displaySlots(chunks) {
    if (chunks.length <= MAX_SLOTS) {
      return chunks
        .slice()
        .sort((a, b) => a.min - b.min)
        .map((c) => ({ label: '[' + fmtBound(c.min) + ', ' + fmtBound(c.max) + ')', count: c.keys.length, real: c }));
    }
    const sorted = chunks.slice().sort((a, b) => b.keys.length - a.keys.length);
    const shown = sorted.slice(0, MAX_SLOTS - 1).sort((a, b) => a.min - b.min);
    const rest = sorted.slice(MAX_SLOTS - 1);
    const restCount = rest.reduce((sum, c) => sum + c.keys.length, 0);
    const slots = shown.map((c) => ({ label: '[' + fmtBound(c.min) + ', ' + fmtBound(c.max) + ')', count: c.keys.length, real: c }));
    slots.push({ label: '+' + rest.length + ' chunks', count: restCount, real: null });
    return slots;
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const shards = state[mode];
    const totals = shardTotals(shards);
    const allCounts = [];
    shards.forEach((s) => s.chunks.forEach((c) => allCounts.push(c.keys.length)));
    const maxCount = Math.max(1, ...allCounts);

    const labelW = 108;
    const rightMargin = 12;
    const canvasW = 720;
    const rowH = 66;
    const rowGap = 14;
    const topMargin = 14;
    const innerW = canvasW - labelW - rightMargin;

    shards.forEach((shard, si) => {
      const rowY = topMargin + si * (rowH + rowGap);
      svg.appendChild(text(labelW / 2, rowY + rowH / 2 - 8, 'Shard ' + si));
      svg.appendChild(text(labelW / 2, rowY + rowH / 2 + 10, totals[si] + ' docs', 'viz-label-dim'));

      const slots = displaySlots(shard.chunks);
      const n = slots.length;
      const gap = 8;
      const boxW = (innerW - (n + 1) * gap) / n;
      const boxH = rowH - 12;
      const boxY = rowY + 6;

      slots.forEach((slot, i) => {
        const x = labelW + gap + i * (boxW + gap);
        const cx = x + boxW / 2;

        let cls = 'viz-node';
        if (slot.real && lastInsert && lastInsert.shardIndex === si && lastInsert.min === slot.real.min && lastInsert.max === slot.real.max) {
          cls = 'viz-node-highlight';
        }
        if (slot.real && lastBalance && lastBalance.touched.some((t) => t.shardIndex === si && t.min === slot.real.min && t.max === slot.real.max)) {
          cls = 'viz-node-new';
        }

        svg.appendChild(el('rect', { x: x, y: boxY, width: boxW, height: boxH, rx: 6, class: cls }));
        svg.appendChild(text(cx, boxY + 14, slot.label, 'viz-label-dim'));
        svg.appendChild(text(cx, boxY + 30, slot.real ? (slot.count + ' docs') : (slot.count + ' docs (agg.)')));

        const barMaxW = Math.max(1, boxW - 16);
        const ratio = maxCount > 0 ? Math.min(1, slot.count / maxCount) : 0;
        svg.appendChild(el('rect', { x: cx - barMaxW / 2, y: boxY + boxH - 12, width: barMaxW, height: 6, style: 'fill:var(--border)' }));
        svg.appendChild(el('rect', { x: cx - barMaxW / 2, y: boxY + boxH - 12, width: Math.max(1, barMaxW * ratio), height: 6, style: 'fill:var(--accent)' }));
      });
    });
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.getAttribute('data-viz-mode');
      lastInsert = null;
      lastBalance = null;
      refreshModeButtons();
      setStatus('Switched to ' + currentModeLabel() + ' shard key. Each mode keeps its own chunk state, so switching back later picks up where you left it.', '');
      draw();
    });
  });

  root.querySelector('[data-viz-action="insert"]').addEventListener('click', () => {
    const raw = keyField.value.trim();
    if (raw === '' || !Number.isFinite(Number(raw))) {
      setStatus('Enter a numeric shard key value first.', 'error');
      return;
    }
    const res = insertDocLogic(state[mode], raw, mode);
    if (!res.ok) {
      setStatus(res.message, 'error');
      return;
    }
    state[mode] = res.shards;
    const chunk = state[mode][res.shardIndex].chunks[res.chunkIndex];
    lastInsert = { shardIndex: res.shardIndex, min: chunk.min, max: chunk.max };
    lastBalance = null;
    const hashNote = mode === 'hashed' ? ' (hashed to ' + res.key + ')' : '';
    setStatus('Inserted key=' + raw + hashNote + ' into shard ' + res.shardIndex + ', chunk [' + fmtBound(chunk.min) + ', ' + fmtBound(chunk.max) + ').', 'ok');
    keyField.value = '';
    draw();
  });

  root.querySelector('[data-viz-action="balance"]').addEventListener('click', () => {
    const res = runBalancerLogic(state[mode]);
    state[mode] = res.shards;
    lastInsert = null;
    lastBalance = res.changed ? { touched: [res.left, res.right] } : null;
    setStatus(res.message, res.changed ? 'ok' : '');
    draw();
  });

  root.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    state[mode] = makeInitialShards(mode);
    lastInsert = null;
    lastBalance = null;
    setStatus(currentModeLabel() + ' shards reset to 3 empty chunks. The other mode\'s state is untouched.', '');
    draw();
  });

  refreshModeButtons();
  setStatus('HASHED shard key loaded — 3 empty chunks. Insert a monotonically increasing sequence (1, 2, 3, …) and compare against Ranged.', '');
  draw();
})();
</script>

<div class="quiz-card">
  <p class="quiz-q">A collection is sharded on {createdAt: 1} (ranged) because "we need to query recent orders fast." Six months in, one shard is consistently at 90% disk while the others sit at 20%. Why?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>createdAt is monotonically increasing — every new document has a timestamp later than everything before it, so every new write lands in the chunk range holding the newest values, which lives on one shard. The balancer can move existing chunks around, but it can't stop new writes from concentrating on the shard that currently owns the "latest" range. This is the textbook ranged-shard-key hotspot; a hashed key (or a compound key that mixes in something with better write distribution) avoids it at the cost of losing efficient range scans.</div>
</div>

---

## Monitoring

```javascript
db.currentOp({secs_running: {$gt: 5}})   // find long-running ops
db.killOp(opid)
db.setProfilingLevel(1, {slowms: 100})   // log queries slower than 100ms
db.system.profile.find().sort({ts: -1}).limit(10)
rs.status()                              // replica set health + per-member replication lag
```

---

## Schema Validation

MongoDB's `$jsonSchema` validator runs on insert and update — like a DB constraint, not an ORM validation. Existing documents that don't match are not automatically rejected (controlled by `validationLevel`).

```javascript
// Create collection with validation
db.createCollection("orders", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["user_id", "total", "status", "created_at"],
      properties: {
        user_id: {
          bsonType: "objectId",
          description: "must be an ObjectId"
        },
        total: {
          bsonType: "decimal",
          minimum: 0,
          description: "must be non-negative decimal"
        },
        status: {
          enum: ["pending", "paid", "shipped", "cancelled"],
          description: "must be one of the allowed statuses"
        },
        created_at: {
          bsonType: "date"
        },
        items: {
          bsonType: "array",
          minItems: 1,
          items: {
            bsonType: "object",
            required: ["sku", "qty", "price"],
            properties: {
              sku:   { bsonType: "string" },
              qty:   { bsonType: "int", minimum: 1 },
              price: { bsonType: "decimal", minimum: 0 }
            }
          }
        }
      }
    }
  },
  validationAction: "error",    // "error": reject violating writes; "warn": log and allow
  validationLevel:  "strict"    // "strict": validate all inserts+updates; "moderate": only docs that already match
})

// Add a validator to an existing collection
db.runCommand({
  collMod: "orders",
  validator: { $jsonSchema: { /* schema here */ } },
  validationAction: "warn",     // start with warn — see what would fail before enforcing
  validationLevel: "strict"
})

// Inspect the current validator
db.getCollectionInfos({ name: "orders" })[0].options.validator

// Bypass validation (admin only — use for backfill migrations)
db.orders.insertOne({ /* doc */ }, { bypassDocumentValidation: true })
```

**validationLevel semantics:**

| Level | On insert | On update |
|---|---|---|
| `strict` (default) | Validates always | Validates always |
| `moderate` | Validates always | Only validates if the document currently matches the schema |

`moderate` is useful during migrations: existing non-conforming documents won't be rejected on update, giving you time to backfill them.

<div class="quiz-card">
  <p class="quiz-q">A collection has validationLevel="moderate" and validationAction="error". An existing document is missing a required field. A subsequent update to that document adds a new field. Is the update rejected?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. With "moderate" level, MongoDB only validates an update if the document currently matches the schema. Since the existing document is already non-conforming (missing a required field), it doesn't match the schema, so the update is not validated — it proceeds regardless of what the schema requires. This is the intentional design: moderate gives you a window to fix existing bad data without blocking writes on it.</div>
</div>

---

## Time Series Collections

Special collection type (MongoDB 5.0+) with bucketing built into the storage engine. MongoDB internally groups documents with the same `metaField` value into time-window buckets. Range scans and aggregations over time are significantly faster because they can skip entire buckets rather than scanning individual documents.

```javascript
// Create a time series collection
db.createCollection("metrics", {
  timeseries: {
    timeField: "timestamp",      // field containing the Date (required)
    metaField: "host",           // field identifying the series source (optional but important)
    granularity: "seconds"       // "seconds", "minutes", or "hours" — controls bucket window size
  },
  expireAfterSeconds: 2592000    // TTL: auto-delete buckets older than 30 days
})

// Insert — looks like a normal insert
db.metrics.insertMany([
  { host: "web-01", timestamp: new Date(), cpu_pct: 42.3, mem_pct: 71.0 },
  { host: "web-01", timestamp: new Date(), cpu_pct: 41.8, mem_pct: 70.5 },
  { host: "web-02", timestamp: new Date(), cpu_pct: 15.1, mem_pct: 55.2 }
])

// Efficient range query — hits only relevant buckets
db.metrics.find({
  host: "web-01",
  timestamp: {
    $gte: new Date(Date.now() - 3600000),    // last 1 hour
    $lt:  new Date()
  }
})

// Aggregation over time — $dateTruncate for bucketed summaries
db.metrics.aggregate([
  { $match: { host: "web-01", timestamp: { $gte: new Date(Date.now() - 86400000) } } },
  { $group: {
    _id: { $dateTruncate: { date: "$timestamp", unit: "minute", binSize: 5 } },
    avg_cpu: { $avg: "$cpu_pct" },
    max_mem: { $max: "$mem_pct" }
  }},
  { $sort: { _id: 1 } }
])
```

**Limitations vs regular collections:**
- No ad-hoc updates to individual documents (update writes a new document; the old one is logically deleted inside its bucket)
- No unique indexes except compound `{metaField, timeField}`
- `timeField` must be a BSON Date — string timestamps require pre-processing
- `metaField` is the primary cardinality axis — high-cardinality meta (e.g., per-request UUID) kills bucketing efficiency

<div class="quiz-card">
  <p class="quiz-q">A time series collection stores metrics with metaField="sensor_id". There are 10 million unique sensor IDs. Why does this kill bucketing efficiency?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The metaField determines how documents are grouped into buckets — all documents with the same metaField value and within the same time window go into one bucket. With 10 million unique sensor IDs, each sensor gets its own bucket series. Each bucket holds at most a handful of documents (one sensor generates few data points per time window), so instead of dense buckets covering many documents, you have millions of mostly-empty buckets. The bucketing benefit disappears: range scans can't skip large chunks of data, and storage overhead increases. Time series collections work best when metaField cardinality is low to medium (hundreds to thousands of unique values, not millions).</div>
</div>

---

## Index Deep Dive: ESR Rule, Multikey, Wildcard

### ESR Rule for Compound Index Field Order

The query planner's ability to use a compound index depends on field order. The ESR rule tells you the optimal order:

**E**quality fields first → **S**ort fields next → **R**ange fields last

```javascript
// Query: status = "active" AND created_at in last 7 days, sorted by score descending
db.users.find({
  status: "active",                          // Equality
  created_at: { $gte: sevenDaysAgo }         // Range
}).sort({ score: -1 })                       // Sort

// Bad index: {created_at, status, score}
// — range field first means sort and equality can't use the index efficiently

// Correct ESR index: {status, score, created_at}
db.users.createIndex({ status: 1, score: -1, created_at: 1 })
// Equality (status) → Sort (score) → Range (created_at)
```

**Why:** MongoDB walks the index left-to-right. Equality conditions narrow the index range precisely. Sort fields come next so MongoDB can satisfy the sort from the index without a blocking sort stage. Range fields come last because a range scan means the sort field values may not be contiguous in the remaining entries.

### Multikey Indexes

An index on an array field is a multikey index — MongoDB creates one index entry per array element.

```javascript
// Document: { tags: ["mongodb", "nosql", "database"] }
db.posts.createIndex({ tags: 1 })       // multikey — 3 index entries for this document
db.posts.find({ tags: "mongodb" })      // uses the multikey index

// Compound multikey restriction: at most ONE array field per compound index
db.posts.createIndex({ tags: 1, categories: 1 })
// ERROR: both are arrays → compound multikey with two array fields is forbidden
// Fix: index one array field and one scalar field
db.posts.createIndex({ tags: 1, author: 1 })   // OK: one array, one scalar
```

### Wildcard Indexes

Index any field without knowing field names upfront — useful for user-defined schemas or document stores.

```javascript
// Index all fields (use sparingly — large index size)
db.events.createIndex({ "$**": 1 })

// Index a specific nested path and its subfields
db.events.createIndex({ "properties.$**": 1 })
// Matches queries on properties.foo, properties.bar, properties.nested.deep

// Cannot be used for sort (wildcard indexes are query-only)
// Cannot be a unique index
```

<div class="quiz-card">
  <p class="quiz-q">A compound index is defined as {category: 1, tags: 1}. The "tags" field is an array. Is this index allowed? What about {tags: 1, categories: 1} where both fields are arrays?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>{category: 1, tags: 1} is allowed — one scalar field and one array field is a valid compound multikey index. MongoDB creates entries for each element of the tags array combined with the scalar category value. {tags: 1, categories: 1} is not allowed if any document has both fields as arrays — MongoDB returns an error "cannot index parallel arrays" because indexing the Cartesian product of two arrays would be unbounded. The rule: a compound index can include at most one field whose value is an array.</div>
</div>

---

## $lookup Performance

`$lookup` is a server-side join. Without the right index, it does a collection scan of the `from` collection for every input document — O(N×M) cost.

```javascript
// --- Equality join (simple form) ---
// REQUIRES an index on orders.user_id — verify before deploying
db.orders.createIndex({ user_id: 1 })

db.users.aggregate([
  { $match: { status: "active" } },
  {
    $lookup: {
      from: "orders",
      localField: "_id",         // field from the "users" collection
      foreignField: "user_id",   // field from the "orders" collection — index this
      as: "orders"
    }
  }
])

// --- Pipeline join (expressive form) ---
// Can apply conditions, projections, and computed fields inside the lookup
db.users.aggregate([
  {
    $lookup: {
      from: "orders",
      let: { uid: "$_id" },              // expose local field as a variable
      pipeline: [
        { $match: {
          $expr: { $eq: ["$user_id", "$$uid"] },   // use the variable
          status: "paid"                             // additional filter inside lookup
        }},
        { $project: { _id: 1, total: 1, created_at: 1 } },   // trim output
        { $sort: { created_at: -1 } },
        { $limit: 5 }
      ],
      as: "recent_orders"
    }
  }
])
// Pipeline joins also require an index on the from collection's join field

// --- Check if the index is being used ---
db.users.aggregate([ /* pipeline */ ], { explain: "executionStats" })
// Look for: IXSCAN in the $lookup sub-pipeline (not COLLSCAN)
// "totalDocsExamined" inside $lookup sub-pipeline should equal returned docs
```

**When to denormalize instead of $lookup:**
- 1:1 relationships where the joined document is always needed together
- Joined documents are small and infrequently updated
- Query latency is critical (embedding eliminates the join entirely)

**$lookup on sharded collections:**
- The `from` collection must be either unsharded or sharded by `_id`
- Pipeline-form $lookup on sharded `from` triggers scatter-gather — high latency on large shards

<div class="quiz-card">
  <p class="quiz-q">A $lookup joins users (10K docs) with orders (10M docs) on orders.user_id with no index on orders.user_id. How many total document examinations does MongoDB perform?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>For each of the 10,000 user documents, MongoDB scans the entire orders collection (10M docs) to find matching orders.user_id values. Total: 10,000 × 10,000,000 = 100 billion document examinations. In practice the query will time out or run for hours. Always create an index on the foreignField (or the field matched in a pipeline join's $match $expr) before running $lookup on any non-trivial dataset.</div>
</div>

---

## Aggregation Pipeline Optimization

The MongoDB query planner pushes some optimizations automatically. Others require manual stage ordering.

```javascript
// 1. $match EARLY — eliminates documents before downstream stages process them
//    Automatic: planner moves $match before adjacent $project
//    Manual: always write $match before $lookup, $unwind, $group

db.orders.aggregate([
  { $match: { status: "paid", created_at: { $gte: thirtyDaysAgo } } },   // ← first
  { $lookup: { from: "users", localField: "user_id", foreignField: "_id", as: "user" } },
  { $unwind: "$user" },
  { $group: { _id: "$user.country", revenue: { $sum: "$total" } } }
])

// 2. $project EARLY — reduce document size before expensive stages
{ $project: { user_id: 1, total: 1, created_at: 1 } }   // drop unused fields before $lookup

// 3. allowDiskUse — triggers when $sort or $group exceeds 100MB in-memory
db.orders.aggregate([ /* stages */ ], { allowDiskUse: true })
// Without it, a sort or group on a large dataset throws:
// "Exceeded memory limit for $group/$sort, but didn't opt in to external sorting"

// 4. explain a pipeline
db.orders.aggregate([
  { $match: { status: "paid" } },
  { $group: { _id: "$country", total: { $sum: "$amount" } } }
], { explain: "executionStats" })
// Look for: IXSCAN (not COLLSCAN) in the $match stage
// "nReturned" at each stage — large drops mean filtering is working
// "executionTimeMillisEstimate" — identifies the slow stage

// 5. Common anti-patterns

//    BAD: $group before $match — aggregates the whole collection first
[
  { $group: { _id: "$country", total: { $sum: "$amount" } } },
  { $match: { total: { $gt: 1000 } } }
]
//    GOOD: filter on indexed fields before $group
[
  { $match: { status: "paid" } },
  { $group: { _id: "$country", total: { $sum: "$amount" } } },
  { $match: { total: { $gt: 1000 } } }
]

//    BAD: $unwind without prior $match — explodes every array element before filtering
[
  { $unwind: "$items" },
  { $match: { "items.sku": "ABC-123" } }
]
//    GOOD: $match on array field before $unwind (uses multikey index on items.sku)
[
  { $match: { "items.sku": "ABC-123" } },
  { $unwind: "$items" },
  { $match: { "items.sku": "ABC-123" } }    // second match after unwind is exact
]
```

<div class="quiz-card">
  <p class="quiz-q">An aggregation pipeline starts with $group followed by $match. The planner "optimizes" by moving $match before $group. Why is this optimization not always safe?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The planner can only move $match before $group when the $match filters on fields that exist before grouping — i.e., fields from the original documents. If the $match filters on computed fields created by $group (like an accumulated "total" or a renamed "_id" alias), those fields don't exist before $group runs, so moving $match would change the result. MongoDB's query planner is conservative and only reorders stages when it can prove the result is identical. When in doubt, profile with explain() to verify the stage order the planner actually uses.</div>
</div>

---

## mongosh Admin Cookbook

Quick-reference one-liners for production administration.

```javascript
// --- Current operations ---
// Find queries running longer than 5 seconds
db.currentOp({ "secs_running": { $gt: 5 }, "op": { $in: ["query", "command"] } })
// Columns to check: opid, client, ns, secs_running, planSummary

// Kill a specific operation
db.killOp(12345)    // opid from currentOp output

// --- Query profiling ---
db.setProfilingLevel(1, { slowms: 50 })    // log queries > 50ms (0=off, 1=slow, 2=all)
db.system.profile.find({}, { op:1, ns:1, millis:1, ts:1, planSummary:1 }).sort({ts:-1}).limit(5)
db.getProfilingStatus()                    // check current threshold

// --- Index intelligence ---
// Find unused indexes (zero accesses since last restart — candidates for drop)
db.orders.aggregate([
  { $indexStats: {} },
  { $match: { "accesses.ops": 0 } },
  { $project: { name: 1, key: 1 } }
])

// Diagnose a slow query (look for COLLSCAN, totalDocsExamined >> nReturned)
db.orders.find({ user_id: ObjectId("..."), status: "paid" }).explain("executionStats")

// --- Replication ---
// Replication lag per member in seconds
rs.status().members.map(m => ({
  name: m.name,
  state: m.stateStr,
  lagSecs: m.optimeDate ? (new Date() - m.optimeDate) / 1000 : null
}))

// Change sync source without restart
rs.syncFrom("10.0.0.1:27017")

// Check oplog window (must exceed backup + maintenance windows)
rs.printReplicationInfo()
// oplog size:   10240 MB
// log length:   24.3 hrs  ← increase oplogSizeMB if this is too short

// --- Space reclamation ---
// Reclaim fragmented space after heavy deletes (blocks writes on the collection)
db.runCommand({ compact: "orders" })
// How much space is reclaimable:
db.orders.stats().wiredTiger["block-manager"]["file bytes available for reuse"]

// --- Connections ---
db.serverStatus().connections
// { current: 412, available: 51588, totalCreated: 29043 }
```
