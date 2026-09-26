# etcd Internals

How etcd stores data, reaches consensus across a cluster, and serves as the source of truth for Kubernetes — the Raft log replication that keeps members consistent, the MVCC model that gives every key a revision history, the watch API that powers K8s controllers without polling, and the compaction and defrag operations that keep the database from growing unbounded.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

<div class="prereq-chips">
  <span class="prereq-label">Prerequisites</span>
  <a href="/topic/databases/replication" class="prereq-chip">Distributed Replication</a>
  <a href="/topic/databases/redis-internals" class="prereq-chip">Redis Internals</a>
</div>

---

## What etcd Is

etcd is a strongly consistent, distributed key-value store built for configuration data and coordination — not for large blobs or high-throughput writes. Every key is a string (UTF-8), every value is arbitrary bytes, and every write increments a global revision counter. Reads are linearizable by default: you never see stale data from an old leader.

In CAP terms etcd is **CP** — it chooses consistency over availability. If a network partition isolates a minority of nodes, those nodes stop serving reads and writes rather than risk returning stale or divergent data. The majority partition continues normally; the minority waits.

**Kubernetes uses etcd as its only persistent store.** Every API object — pods, deployments, services, ConfigMaps, secrets — lives as a value under `/registry/<resource>/<namespace>/<name>`. Every `kubectl apply` is an etcd write; every controller's informer is an etcd watch. The API server is essentially a proxy between HTTP/REST and etcd's gRPC API, with admission, auth, and resource versioning on top.

**Why etcd over ZooKeeper?** Kubernetes chose etcd because its HTTP+gRPC API is simpler to operate and deploy, its Raft consensus is easier to reason about than ZooKeeper's ZAB protocol, and it ships as a single static binary with no JVM dependency. etcd v3 also offers a much richer watch API than ZooKeeper's one-shot watches.

```bash
# The etcd data model: flat key-value with prefix queries
etcdctl put /config/db/host postgres-primary
etcdctl put /config/db/port 5432
etcdctl get /config/db/ --prefix       # all keys under /config/db/
# KEY                    VALUE
# /config/db/host        postgres-primary
# /config/db/port        5432
```

<div class="quiz-card">
  <p class="quiz-q">etcd is a CP system. A 5-node cluster loses network connectivity to 2 of its nodes. Do those 2 isolated nodes keep serving reads?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The 2 isolated nodes form a minority partition and cannot confirm they are still seeing the latest committed data — the leader could be on the other side. A CP system stops serving rather than risk returning stale reads. The 3-node majority partition retains quorum and continues normally; the minority nodes wait and refuse client requests until connectivity is restored.</div>
</div>

---

## Raft Consensus

etcd uses Raft to keep all members consistent. Raft assigns every node one of three roles and advances through terms — a monotonically increasing election epoch.

```mermaid
stateDiagram-v2
    [*] --> Follower
    Follower --> Candidate : election timeout fires\n(no heartbeat from leader)
    Candidate --> Follower : sees higher term\nor loses election
    Candidate --> Leader : wins majority vote\n(receives > N/2 RequestVote grants)
    Leader --> Follower : sees higher term\n(another node became leader)
    Leader --> Leader : keeps sending AppendEntries heartbeats\nevery heartbeat-interval (default 100ms)
```

**Log replication — how a write commits:**

```mermaid
sequenceDiagram
    participant C as Client
    participant L as Leader
    participant F1 as Follower 1
    participant F2 as Follower 2

    C->>L: write request (PUT /foo = bar)
    L->>L: append entry to local log (index N, term T)
    par
        L->>F1: AppendEntries(index N, term T, entry)
        L->>F2: AppendEntries(index N, term T, entry)
    end
    F1-->>L: success (ACK)
    F2-->>L: success (ACK)
    Note over L: majority ACK received (2 of 2 followers) — entry committed
    L->>L: apply entry to state machine
    L-->>C: success response
    par
        L->>F1: commitIndex updated
        L->>F2: commitIndex updated
    end
```

A write is **committed** once the leader receives ACKs from a majority (including itself). Committed means durable: even if the leader crashes immediately after, a new leader elected from the majority will have the entry and will apply it.

**Quorum math:** a cluster of N nodes tolerates floor((N-1)/2) simultaneous failures.

| Cluster size | Failures tolerated | Quorum needed |
|---|---|---|
| 1 | 0 | 1 |
| 3 | 1 | 2 |
| 5 | 2 | 3 |
| 7 | 3 | 4 |

**Why odd numbers?** A 6-node cluster tolerates 2 failures (quorum = 4) — the same as a 5-node cluster. The extra node adds cost without adding fault tolerance. Always deploy 3, 5, or 7 nodes; even sizes are wasteful.

<div class="quiz-card">
  <p class="quiz-q">A 5-node etcd cluster loses 3 nodes simultaneously. Can it still accept writes?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. With 3 nodes gone only 2 remain, and quorum for a 5-node cluster is 3 (majority). The 2 surviving nodes cannot form a majority — they stop accepting writes and reads until enough nodes rejoin. This is the CP tradeoff: the cluster refuses to risk split-brain by letting a minority partition pretend to be the authoritative leader.</div>
</div>

---

## MVCC Storage Model

etcd uses **multi-version concurrency control**: every write creates a new version of the key at a new global revision rather than overwriting in place. Old versions are kept until explicitly compacted away.

**Three revision fields on every key:**

| Field | Meaning |
|---|---|
| `createRevision` | Global revision when this key was first created |
| `modRevision` | Global revision of the last write to this key |
| `version` | Number of writes to this key since creation (resets on delete+recreate) |

```bash
etcdctl put /pods/nginx "spec: ..."     # global revision advances to 3
etcdctl put /pods/nginx "spec: ..."     # global revision advances to 7
etcdctl put /pods/nginx "spec: ..."     # global revision advances to 12

etcdctl get /pods/nginx -w json | jq '.kvs[0] | {createRevision, modRevision, version}'
# { "createRevision": 3, "modRevision": 12, "version": 3 }
```

```mermaid
graph LR
    classDef rev fill:#2980b9,stroke:#1f618d,color:#fff,rx:6
    classDef key fill:#27ae60,stroke:#1e8449,color:#fff,rx:6
    classDef compact fill:#c0392b,stroke:#922b21,color:#fff,rx:6

    R1["rev 1"]:::rev --> R2["rev 2"]:::rev --> R3["rev 3"]:::rev --> R4["rev 4 ... 6"]:::rev --> R7["rev 7"]:::rev --> R8["rev 8 ... 11"]:::rev --> R12["rev 12"]:::rev

    R3 --> KV3["/pods/nginx\nversion 1"]:::key
    R7 --> KV7["/pods/nginx\nversion 2"]:::key
    R12 --> KV12["/pods/nginx\nversion 3"]:::key

    COMPACT["compact at rev 10\ndeletes KV3, KV7"]:::compact -.-> KV3
    COMPACT -.-> KV7
```

**Kubernetes uses `resourceVersion` for optimistic locking.** The resourceVersion field on every K8s object is etcd's `modRevision` for that key. A `kubectl apply` includes the resourceVersion it read; the API server issues a conditional write (`--prev-kv`) to etcd. If another write landed in between, the revisions don't match — etcd rejects the write and the client must re-read and retry.

```bash
# Query at a historical revision (before compaction)
etcdctl get /pods/nginx --rev=7   # returns the version as of revision 7

# Prefix query — all pods in the default namespace
etcdctl get /registry/pods/default/ --prefix
```

<div class="quiz-card">
  <p class="quiz-q">A kubectl apply sets a Deployment's resourceVersion to 42. Concurrently, another kubectl apply for the same Deployment read it at resourceVersion=41. What happens when the second apply reaches the API server?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The API server rejects it with a 409 Conflict. It issues a conditional write to etcd (compare-and-swap on the current revision), and because the current revision is now 42, not 41, the condition fails. The client receives the conflict error and must re-read the object at its current version, merge its changes, and retry with the updated resourceVersion. This is optimistic locking — no locks held during the read, conflict detected at write time.</div>
</div>

---

## The Watch API

The watch API is what makes Kubernetes controllers efficient. Instead of polling etcd every second for changes, every controller opens a long-lived streaming gRPC watch on a key prefix. etcd pushes each committed WatchEvent (PUT or DELETE) to all matching watchers in revision order, in real time.

```mermaid
sequenceDiagram
    participant C as K8s Controller
    participant E as etcd

    C->>E: Watch /registry/deployments/ --start-revision=100
    E-->>C: WatchEvent PUT /registry/deployments/default/nginx rev=101
    E-->>C: WatchEvent DELETE /registry/deployments/default/old rev=102
    E-->>C: BOOKMARK (rev=103, no data — checkpoint)
    Note over C: controller crashes, restarts

    C->>E: Watch /registry/deployments/ --start-revision=103
    E-->>C: WatchEvent PUT /registry/deployments/default/nginx rev=104
    Note over E: compaction runs, compacts past rev=100

    C->>E: Watch /registry/deployments/ --start-revision=99
    E-->>C: ERROR: CompactRevision=100, requested revision compacted
    Note over C: informer does full re-list + re-watch from current revision
```

**Watch bookmarks** are periodic no-data events the server sends with just a revision number. The client records this as its "safe resume point" — on reconnect it can start the watch from the bookmark revision and know it missed nothing.

**What happens on a compact error:** if a client reconnects with a `--start-revision` that has been compacted away, etcd returns `GRPC code 11 (OUT_OF_RANGE)` with the `CompactRevision` field set. Kubernetes' informer framework handles this automatically: it does a full List of all objects at the current revision, resyncs the local cache, then opens a fresh watch from that new revision. Controllers see a synthetic "Added" event for everything — this is a normal informer resync, not an error state.

<div class="quiz-card">
  <p class="quiz-q">A K8s controller crashes and restarts 2 hours later. Its last-seen resourceVersion was 5000, but etcd's periodic compaction has already moved past revision 5000. What does the informer framework do?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The informer receives a compact error when it tries to resume the watch at revision 5000. It responds by doing a full List of all objects in the watched resource type (at the current revision), rebuilds its local cache, then opens a fresh watch starting from that current revision. Controllers receive synthetic "Added" events for all existing objects so they can reconcile from a clean state. This is expected behavior and happens routinely — the informer's List+Watch pattern is designed specifically to handle compaction gaps.</div>
</div>

---

## Compaction & Defrag

Without intervention, etcd's database grows forever — every write adds a new MVCC version, and old versions never disappear on their own. Compaction and defrag are the two-step cleanup.

**Compaction** marks old revisions as deleted inside bbolt's B-tree. It does not shrink the file on disk — it just frees pages internally for reuse by future writes.

**Defrag** rewrites the bbolt file from scratch, releasing freed pages back to the OS. The file shrinks. Defrag briefly blocks all writes on that member (typically 1–10 seconds) — always run on one member at a time.

**Auto-compaction modes:**

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="periodic" class="active">periodic (default)</button>
    <button data-tab="revision">revision</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="periodic">
      <code>--auto-compaction-mode=periodic --auto-compaction-retention=1h</code><br>
      Compacts every hour, keeping only the last 1 hour of revision history. Good default for most clusters. History older than the retention window is gone — <code>--rev</code> queries that far back will fail.
    </div>
    <div class="tab-panel" data-tab-panel="revision">
      <code>--auto-compaction-mode=revision --auto-compaction-retention=1000</code><br>
      Keeps only the last 1000 revisions regardless of time. More predictable DB size for clusters with variable write rates, but history may be very short on busy clusters.
    </div>
  </div>
</div>

**DB quota alarm recovery — step by step:**

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Quota exceeded.</strong> etcd writes return <code>mvcc: database space exceeded</code>. The API server starts 503ing. <code>etcdctl alarm list</code> shows <code>NOSPACE</code>. No writes can land until you clear it.
    </div>
    <div class="stepper-panel">
      <strong>2. Compact old revisions.</strong> Get the current revision and compact everything before it: <code>REV=$(etcdctl endpoint status --write-out=json | jq '.[0].Status.header.revision') &amp;&amp; etcdctl compact $REV</code>. This frees pages inside bbolt but the file is still large.
    </div>
    <div class="stepper-panel">
      <strong>3. Defrag each member.</strong> Run <code>etcdctl defrag --endpoints=&lt;member&gt;</code> on each member one at a time. Each call blocks writes on that member for a few seconds while the file is rewritten. The file on disk shrinks.
    </div>
    <div class="stepper-panel">
      <strong>4. Disarm the alarm.</strong> <code>etcdctl alarm disarm</code> clears the NOSPACE alarm. Writes resume. Verify with <code>etcdctl endpoint status</code> that DB size is below quota.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

Default quota is **2GB** (`--quota-backend-bytes`). Hard maximum is **8GB**. Alert at 80% so you have time to compact before hitting the wall.

<div class="quiz-card">
  <p class="quiz-q">etcdctl compact removes all key versions before a given revision. Does the etcd data file on disk shrink immediately after compaction?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. Compaction marks pages as free inside bbolt's B-tree — those pages are available for future writes to reuse, but the file itself stays the same size on disk. Only defrag (etcdctl defrag) actually rewrites the file and releases those freed pages back to the OS, making the file smaller. The two-step sequence is always: compact first, then defrag.</div>
</div>

---

## Clustering & Membership

**Static bootstrapping:** all members are listed upfront in `--initial-cluster`. Every member must come online before the cluster elects a leader and starts accepting writes. Safe and simple; requires knowing IPs in advance.

**Dynamic membership:** add a member to a running cluster with `etcdctl member add`, then start the new etcd process. It contacts existing members, downloads a snapshot, and catches up. The cluster is slightly more vulnerable during sync — plan accordingly.

**Learner nodes** (`--learner` flag on `etcdctl member add`): non-voting members that receive all log entries but never vote in elections and cannot become leaders. They don't affect quorum math. Use them to safely add capacity or pre-sync a new member before promoting it to a full voting member — reduces the window where a slow sync could drop the cluster below quorum.

```bash
etcdctl member list
# ID                  STATUS    NAME     PEER ADDRS                   CLIENT ADDRS
# 8e9e05c52164694d    started   etcd-1   https://10.0.0.1:2380        https://10.0.0.1:2379
# 91bc3c398fb3c146    started   etcd-2   https://10.0.0.2:2380        https://10.0.0.2:2379
# fd422379fda50e48    started   etcd-3   https://10.0.0.3:2380        https://10.0.0.3:2379

# Add a learner first, then promote
etcdctl member add etcd-4 --peer-urls=https://10.0.0.4:2380 --learner
# Once synced:
etcdctl member promote <member-id>
```

**Stacked vs. external topology:**

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="stacked" class="active">Stacked</button>
    <button data-tab="external">External</button>
    <button data-tab="learner">Learner pattern</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="stacked">
      etcd runs as a static pod on each control-plane node (kubeadm default). Simpler — one machine to manage per control-plane member. Downside: losing a control-plane node loses both an API server and an etcd member simultaneously, which can eat into your fault tolerance faster than expected. See <a href="/topic/kubernetes/kubeadm-bootstrap">kubeadm bootstrap</a> for the stacked HA topology in detail.
    </div>
    <div class="tab-panel" data-tab-panel="external">
      Dedicated etcd cluster separate from control-plane nodes. Failure domains are decoupled — an API server crash doesn't touch etcd quorum, and an etcd member crash doesn't take an API server with it. More machines and more ops overhead, but the right call for large or critical clusters.
    </div>
    <div class="tab-panel" data-tab-panel="learner">
      Add the new node as a learner, let it fully sync the snapshot (can take minutes on a large cluster), then promote to a voting member. The window where quorum is at risk from a slow-syncing new member is eliminated. Particularly important when scaling from 3 to 5 members on a busy cluster.
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">You add a 4th member to a running 3-node etcd cluster. The new member spends 5 minutes downloading a snapshot and catching up. During that sync, what is the cluster's effective quorum?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The cluster now has 4 voting members, so quorum is 3. During the sync the new member is present but not caught up — if one of the original 3 nodes also fails during this window, only 2 of 4 members are reachable and the cluster loses quorum. This is why learner nodes exist: add as a learner (non-voting, doesn't change quorum math) until synced, then promote. The 3-node quorum (2) is maintained throughout.</div>
</div>

---

## Operations Reference

```bash
# Health check — all members
etcdctl endpoint health \
  --endpoints=https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379

# Status — leader, revision, DB size per member
etcdctl endpoint status \
  --endpoints=https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379 \
  --write-out=table

# Read a key (K8s values are protobuf — pipe through etcdhelper or just check existence)
etcdctl get /registry/pods/default/nginx

# List all K8s resource keys (keys only — values are protobuf, not human-readable)
etcdctl get /registry/ --prefix --keys-only

# Watch a prefix live (useful for debugging controller behavior)
etcdctl watch /registry/pods/ --prefix

# Snapshot — run on the leader, include TLS flags for kubeadm clusters
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key

# Verify snapshot integrity
etcdctl snapshot status /backup/etcd-$(date +%F).db --write-out=table

# Compact + defrag + disarm (quota alarm recovery)
REV=$(etcdctl endpoint status --write-out=json \
  | jq '.[0].Status.header.revision')
etcdctl compact $REV
etcdctl defrag --endpoints=https://10.0.0.1:2379   # one member at a time
etcdctl defrag --endpoints=https://10.0.0.2:2379
etcdctl defrag --endpoints=https://10.0.0.3:2379
etcdctl alarm disarm
```

For the full snapshot restore procedure (stopping the API server, restoring on each member, restarting), see [Backup & Disaster Recovery → etcd backup](/topic/advanced/backup-dr).

---

## Performance & Tuning

**The #1 bottleneck is disk WAL fsync latency.** etcd fsync-commits the write-ahead log before acknowledging every write to the client. If the disk is slow, every write takes longer, heartbeat responses slow down, election timeouts fire, and the cluster starts re-electing leaders — which manifests as API server 503s and `context deadline exceeded` errors in kubectl.

```mermaid
graph LR
    classDef bad fill:#c0392b,stroke:#922b21,color:#fff,rx:6
    classDef ok fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    WRITE["client write"] --> WAL["WAL fsync\n(disk I/O)"]:::bad
    WAL -->|"p99 > 10ms"| SLOW["heartbeat delayed"]:::bad
    SLOW --> TIMEOUT["election timeout fires"]:::bad
    TIMEOUT --> REELECT["leader re-election"]:::bad
    REELECT --> APIDOWN["API server 503s\nfor election duration (~1-2s)"]:::bad

    WAL2["WAL fsync\n(NVMe, p99 < 2ms)"]:::ok --> FAST["heartbeat on time"]:::ok
    FAST --> STABLE["stable leader"]:::ok
    STABLE --> HEALTHY["API server healthy"]:::ok
```

**Disk:** Use NVMe or SSD. Dedicate a separate disk to etcd data away from the OS and container logs. EBS `gp3` works; `io2` is better for large clusters. Network-attached volumes with variable latency cause intermittent leader elections.

**Heartbeat and election timeout:** `--heartbeat-interval` (default 100ms) and `--election-timeout` (default 1000ms = 10× heartbeat). The rule: election-timeout must be ≥ 10× heartbeat-interval AND ≥ 5× p99 round-trip latency between members. For cross-region clusters with 50ms RTT, set heartbeat to 500ms and election-timeout to 5000ms.

**Prometheus alerts:**

```promql
# WAL fsync p99 — alert > 10ms
histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.01

# Backend commit p99 — alert > 250ms
histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])) > 0.25

# DB size vs quota — alert > 80%
etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes > 0.8

# Leader changes per hour — should be ~0; spikes indicate network or disk issues
rate(etcd_server_leader_changes_seen_total[1h]) > 1
```

<div class="quiz-card">
  <p class="quiz-q">etcd's p99 WAL fsync jumps from 2ms to 50ms after you move its data directory to a network-attached volume. Shortly after, the K8s API server starts returning 503s. What is the causal chain?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The slow volume causes every etcd write to take 50ms+ to fsync the WAL. That delays the leader's ability to send timely AppendEntries heartbeats to followers. Followers that don't receive a heartbeat within election-timeout (default 1000ms) conclude the leader is dead and start an election. During a re-election (typically 1–2 seconds) etcd stops accepting writes. The API server — unable to write to etcd — returns 503s for that window. If fsync stays slow, this cycle repeats: slow disk → missed heartbeats → frequent re-elections → repeated API outages.</div>
</div>

---

## Lease System

Leases give keys a TTL without per-key expiry (which would require a separate timer per key). A client grants a lease with a TTL, attaches any number of keys to it with `--lease`, and must call `keep-alive` before the TTL expires — otherwise the lease and all attached keys are atomically deleted. This is how Kubernetes pod leases, node heartbeats, and leader election work.

```bash
# Grant a lease — returns a lease ID
etcdctl lease grant 30
# lease 694d6c3fe1c6b80a granted with TTL(30s)

# Attach a key to the lease
etcdctl put /leader/my-app "node-1" --lease=694d6c3fe1c6b80a

# Inspect a lease (remaining TTL, attached keys)
etcdctl lease timetolive 694d6c3fe1c6b80a --keys
# TTL=28, granted-TTL=30, Keys=[/leader/my-app]

# Keep-alive: renew lease (call before TTL expires)
etcdctl lease keep-alive 694d6c3fe1c6b80a
# lease 694d6c3fe1c6b80a keepalived with TTL(30)
# (blocks and re-sends every TTL/3 seconds until Ctrl-C)

# Revoke lease explicitly (immediately deletes all attached keys)
etcdctl lease revoke 694d6c3fe1c6b80a
```

**Distributed lock pattern:**

```bash
# 1. Grant a short-lived lease (your "lock TTL")
LEASE=$(etcdctl lease grant 15 | awk '/lease/{print $2}')

# 2. Try to put the lock key only if it doesn't exist (compare-and-swap via txn)
etcdctl txn <<EOF
create("/locks/db-migration") = "0"

put /locks/db-migration "node-1" --lease=$LEASE


EOF
# Returns "SUCCESS" if key didn't exist (created) or "FAILURE" if another holder exists

# 3. Keep-alive loop while holding the lock
etcdctl lease keep-alive $LEASE &

# 4. Do critical work...

# 5. Release: revoke lease (atomically deletes the lock key)
etcdctl lease revoke $LEASE
```

**Leader election with `etcdctl elect`:**

```bash
# Blocks until this caller wins the election (no other holder of "my-app" key)
etcdctl elect my-app node-1
# node-1 elected — blocks, keeping the lease alive until Ctrl-C or failure
```

<div class="quiz-card">
  <p class="quiz-q">A process holds a lease with TTL=30 and calls keep-alive every 10 seconds. The process freezes for 35 seconds (GC pause, swap). What happens to the attached keys?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The lease expires after 30 seconds with no keep-alive, and etcd atomically deletes all keys attached to that lease. When the frozen process resumes, its lease ID is gone — it must grant a new lease, re-attach keys, and re-establish its role. This is intentional: etcd uses lease expiry as a failure-detection mechanism. If a process can't keep-alive, it's assumed dead, and its lock/leader key should be released so another holder can take over. The window where a false positive eviction can occur (process alive but slow) is a known tradeoff of TTL-based leases.</div>
</div>

---

## Transactions (Compare-and-Swap)

`etcdctl txn` executes a conditional multi-key operation atomically: if all conditions pass, the success ops run; otherwise the failure ops run. Nothing in between.

```bash
# Syntax: conditions, blank line, success ops, blank line, failure ops
etcdctl txn <<EOF
value("/config/active-dc") = "us-east-1"

put /config/active-dc "us-west-2"

put /config/failover-attempted "true"
EOF
# SUCCESS: /config/active-dc was "us-east-1" → switched to "us-west-2"
# FAILURE: was something else → wrote failover-attempted flag instead
```

**Condition operators:**

| Condition | Meaning |
|---|---|
| `value("key") = "val"` | Key's current value equals val |
| `mod("key") = "rev"` | Key's modRevision equals rev (optimistic locking) |
| `create("key") = "0"` | Key does not exist (createRevision = 0) |
| `version("key") = "N"` | Key has been written exactly N times |

**Optimistic locking with `mod` — concurrent update guard:**

```bash
# Read current state + revision
etcdctl get /config/settings -w json | jq '{value: .kvs[0].value, mod: .kvs[0].mod_revision}'
# { "value": "eyJtYXhfd29ya2Vyc...", "mod": 47 }

# Update only if nobody else wrote it since we read it
etcdctl txn <<EOF
mod("/config/settings") = "47"

put /config/settings "{\"max_workers\":20}"

EOF
# FAILURE → re-read and retry
```

<div class="quiz-card">
  <p class="quiz-q">Two processes read /config/settings at modRevision=47 and both issue a txn guarded by mod("/config/settings") = "47". Can both succeed?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The first txn to commit changes modRevision to 48. When the second txn arrives, the condition mod("/config/settings") = "47" is now false — the revision doesn't match — so the second txn executes its failure branch. This is identical to SQL's optimistic locking with a version column: the loser must re-read the new state and retry. Because etcd processes writes serially through Raft, there is no scenario where both txns see revision 47 and both commit.</div>
</div>

---

## Auth & RBAC

etcd's built-in auth is prefix-based: roles grant read or write permissions on key prefixes, and users are assigned roles. Auth is off by default; enabling it requires creating a root user first.

```bash
# 1. Create root user BEFORE enabling auth (or you lock yourself out)
etcdctl user add root
# Enter password: xxxxxxxx

# 2. Grant root role to root user
etcdctl user grant-role root root

# 3. Enable auth — all subsequent calls require credentials
etcdctl auth enable
# Authentication Enabled

# 4. All commands now need --user or env var
export ETCDCTL_USER=root:password

# Create a read-only role for a monitoring service
etcdctl role add etcd-reader
etcdctl role grant-permission etcd-reader read "" --prefix   # read any key

# Create a role for the K8s API server
etcdctl role add kube-apiserver
etcdctl role grant-permission kube-apiserver readwrite /registry/ --prefix

# Create users and assign roles
etcdctl user add monitoring
etcdctl user grant-role monitoring etcd-reader

etcdctl user add kube-apiserver
etcdctl user grant-role kube-apiserver kube-apiserver

# Inspect
etcdctl user list
etcdctl role list
etcdctl user get monitoring      # shows assigned roles
etcdctl role get etcd-reader     # shows granted permissions
```

<div class="quiz-card">
  <p class="quiz-q">etcdctl auth enable is called before creating any user. What happens?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>etcd refuses to enable auth without a root user existing first. If auth were enabled with no root, no one would be able to administer the cluster — you'd be permanently locked out. etcd enforces: a user named "root" with the built-in "root" role must exist before auth enable succeeds. Always create root first, verify you can authenticate as root, then enable auth — in that order.</div>
</div>

---

## TLS Setup

etcd has two independent TLS channels: **peer TLS** (etcd-to-etcd, port 2380) and **client TLS** (clients-to-etcd, port 2379). Both use the same CA but have separate cert/key pairs.

**Generate CA and certs (openssl):**

```bash
# 1. Create CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -key ca.key -out ca.crt -days 3650 \
  -subj "/CN=etcd-ca"

# 2. Per-member peer cert (repeat for each node — change IP/hostname)
#    SAN must include both hostname and IP — etcd verifies both
cat > etcd-1-peer-ext.cnf <<EOF
subjectAltName=DNS:etcd-1,DNS:etcd-1.example.com,IP:10.0.0.1,IP:127.0.0.1
EOF

openssl genrsa -out etcd-1-peer.key 2048
openssl req -new -key etcd-1-peer.key -out etcd-1-peer.csr \
  -subj "/CN=etcd-1"
openssl x509 -req -in etcd-1-peer.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out etcd-1-peer.crt -days 365 \
  -extfile etcd-1-peer-ext.cnf

# 3. Client cert (for etcdctl, K8s API server — no IP SAN needed for clients)
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=etcd-client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt -days 365

# 4. Distribute certs to each node
scp ca.crt client.crt client.key root@10.0.0.1:/etc/etcd/tls/
scp etcd-1-peer.crt etcd-1-peer.key root@10.0.0.1:/etc/etcd/tls/
# Repeat for etcd-2, etcd-3 with their respective peer certs

# 5. Set permissions
chmod 600 /etc/etcd/tls/*.key
chown -R etcd:etcd /etc/etcd/tls/
```

**The six TLS flags:**

| Flag | Channel | What it does |
|---|---|---|
| `--peer-cert-file` | Peer | This member's cert presented to other etcd members |
| `--peer-key-file` | Peer | Private key for peer cert |
| `--peer-trusted-ca-file` | Peer | CA to verify other members' peer certs |
| `--cert-file` | Client | Cert presented to clients |
| `--key-file` | Client | Private key for client cert |
| `--trusted-ca-file` | Client | CA to verify client certs (needed only with `--client-cert-auth`) |

**etcdctl environment shortcuts (avoids repeating flags every command):**

```bash
export ETCDCTL_CACERT=/etc/etcd/tls/ca.crt
export ETCDCTL_CERT=/etc/etcd/tls/client.crt
export ETCDCTL_KEY=/etc/etcd/tls/client.key
export ETCDCTL_ENDPOINTS=https://10.0.0.1:2379,https://10.0.0.2:2379,https://10.0.0.3:2379
export ETCDCTL_API=3

# Now works without --cacert/--cert/--key on every call
etcdctl endpoint health
```

**Cert rotation (rolling, no downtime):**

```bash
# 1. Issue new cert with new expiry (keep same CA)
# 2. Add both old and new cert to trusted-ca-file (bundle) and restart one member
# 3. Verify cluster healthy after each member restart
# 4. Once all members accept new cert, remove old cert from bundle, restart again
```

<div class="quiz-card">
  <p class="quiz-q">The peer cert for etcd-1 was generated with only the IP (10.0.0.1) in its SAN — not the hostname. etcd-2 connects to etcd-1 using its hostname (etcd-1.internal). What happens?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>TLS handshake fails with a certificate verification error. Go's TLS library (which etcd uses) verifies that the name used to connect matches either an IP SAN or a DNS SAN in the peer's certificate. If etcd-2 dials etcd-1.internal and the cert only has IP:10.0.0.1, the hostname doesn't match any SAN — connection refused. This is why the cert generation must include both the IP and every hostname the member might be reached by, and why you must test connectivity with both the DNS name and IP before going to production.</div>
</div>

---

## Additional Operations Reference

Additions to the operations cookbook (beyond the existing snapshot, compact, defrag, health check commands):

```bash
# Transfer leadership before maintenance (graceful — less disruption than stopping)
etcdctl move-leader <target-member-id>
# Get member IDs from: etcdctl member list

# Decommission a member cleanly
etcdctl member remove <member-id>
# Stop the etcd process on that node BEFORE running this — otherwise it tries to reconnect

# Force-remove a dead member that can't be reached (last resort for quorum recovery)
# Only safe when the cluster has quorum without the dead member
etcdctl member remove <dead-member-id>   # same command — works even if member unreachable

# Performance benchmark (built-in)
etcdctl check perf --load=s   # s=small, m=medium, l=large, xl=extra-large
# Reports: requests per second, latency p50/p99/p999

# Distributed lock (blocks until lock acquired, runs command while holding it)
etcdctl lock my-lock -- /path/to/command

# Leader election (blocks until elected; name is the election namespace)
etcdctl elect my-election proposal-value

# Count keys by K8s resource type (useful for quota debugging)
etcdctl get /registry/ --prefix --keys-only \
  | awk -F/ 'NF>3{print $3}' | sort | uniq -c | sort -rn

# Watch for config changes in real time starting from current revision
etcdctl watch /registry/ --prefix --rev=$(etcdctl endpoint status \
  --write-out=json | jq '.[0].Status.header.revision')
```

**Additional PromQL alerts:**

```promql
# Proposals failed — Raft couldn't commit entries (leadership instability)
rate(etcd_server_proposals_failed_total[5m]) > 0

# Peer round-trip latency p99 — alert > 50ms (cross-region: > 150ms)
histogram_quantile(0.99, rate(etcd_network_peer_round_trip_time_seconds_bucket[5m])) > 0.05

# Slow apply — server can't apply committed entries fast enough (CPU/disk)
rate(etcd_server_slow_apply_total[5m]) > 0

# gRPC request errors — alert if error rate > 1%
sum(rate(grpc_server_handled_total{grpc_code!="OK"}[5m])) /
sum(rate(grpc_server_handled_total[5m])) > 0.01
```

Grafana dashboard: import ID **3070** (etcd by Prometheus community) or the CoreOS etcd mixin dashboard from `github.com/etcd-io/etcd/contrib/mixin`.
