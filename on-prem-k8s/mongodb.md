# MongoDB on Kubernetes

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Replica Set Architecture

```mermaid
graph TD
    subgraph "MongoDB Replica Set (StatefulSet: 3 nodes)"
        P["mongo-0 PRIMARY<br>accepts all reads+writes<br>holds oplog"]
        S1["mongo-1 SECONDARY<br>replicates from primary<br>can serve reads (readPreference)"]
        S2["mongo-2 SECONDARY (or Arbiter)<br>vote-only if arbiter<br>or full copy"]
    end
    P -->|"oplog streaming<br>(async by default)"| S1
    P -->|"oplog streaming"| S2

    CLIENT["App"] -->|"PRIMARY connection"| P
    READER["Read-only app"] -->|"readPreference: secondary"| S1
```

**Oplog (Operations Log):** MongoDB's replication log. A capped collection in the `local` database on the primary. Secondaries tail the oplog and apply operations. Size determines how far behind a secondary can fall before it needs a full resync.

<div class="quiz-card">
  <p class="quiz-q">mongo-2 is configured as an arbiter instead of a full secondary. It has a vote in elections — does it also hold a copy of the data, and can an app read from it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. An arbiter is vote-only — it never holds a copy of the data or the oplog. It exists purely to break ties in elections (useful for keeping an odd number of voters without paying for a third full data-bearing node). Since it has no data, it can never be a read target, no matter what readPreference is set.</div>
</div>

---

## Write Concern and Read Concern

```yaml
# Write concern: how many nodes must confirm a write
writeConcern:
  w: "majority"     # majority of voting members must acknowledge
  j: true           # writes must be journaled (flushed to disk)
  wtimeout: 5000    # fail if not confirmed in 5s

# Read concern: what data reads can see
readConcern:
  level: "majority" # only read data committed to majority (no dirty reads)
                    # Alternatives: local (default, may read uncommitted), linearizable
```

**Write concern `majority` with 3 nodes:** 2/3 nodes must confirm. If primary + 1 secondary confirm → write committed. If primary fails after 1 secondary confirms → the secondary has the data and becomes primary.

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="local" class="active state-warn">local</button>
    <button data-toggle-opt="majority" class="state-ok">majority</button>
    <button data-toggle-opt="linearizable" class="state-ok">linearizable</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="local">
    Default. Returns whatever data is on the node handling the read, even if that data hasn't been replicated to (or could still be rolled back by) the rest of the set. Fastest, but a dirty read is possible.
  </div>
  <div class="toggle-panel" data-toggle-panel="majority">
    Only returns data that's been acknowledged by a majority of voting members — the same durability bar as write concern <code>majority</code>. Can't return data that could later be rolled back after a failover.
  </div>
  <div class="toggle-panel" data-toggle-panel="linearizable">
    Strongest guarantee: the read reflects every write that completed before it started, cluster-wide. Only meaningful on reads against the primary, and the slowest of the three because it has to confirm no concurrent election is in progress.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A write with writeConcern w: "majority" is acknowledged by the primary and exactly one secondary, then the primary immediately crashes. Is that write lost?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. Primary + 1 secondary = 2 of 3 nodes, which already satisfies majority before the crash. The secondary that has the data is a valid candidate to become the new primary in the election that follows, so the write survives the failover. It would only be at risk if fewer than a majority had confirmed it.</div>
</div>

---

## Election and Failover

```mermaid
sequenceDiagram
    participant P2 as mongo-0 (Primary)
    participant S1_2 as mongo-1 (Secondary)
    participant S2_2 as mongo-2 (Secondary)

    Note over P2: Primary becomes unavailable (node failure)
    S1_2->>S2_2: heartbeat missed for electionTimeoutMillis (10s)
    S1_2->>S1_2: Increment term, become candidate
    S1_2->>S2_2: RequestVote (term=2)
    S2_2-->>S1_2: VoteGranted (I'm up to date)
    Note over S1_2: Won majority (2/3 votes including self)
    S1_2->>S1_2: Become PRIMARY
    Note over S1_2,S2_2: Election complete, ~10s downtime

    Note over P2: mongo-0 recovers
    P2->>S1_2: I'm alive, current term?
    S1_2-->>P2: Term=2, I am primary
    P2->>P2: Step down, become secondary
    P2->>S1_2: Catch up oplog
```

Walk through the same failover as discrete stages:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Stable.</strong> mongo-0 is primary, accepting all reads and writes. mongo-1 and mongo-2 are secondaries, tailing its oplog.
    </div>
    <div class="stepper-panel">
      <strong>2. Primary goes dark.</strong> mongo-0 fails (node loss, crash). The secondaries stop receiving heartbeats from it.
    </div>
    <div class="stepper-panel">
      <strong>3. Election timeout, candidacy.</strong> After <code>electionTimeoutMillis</code> (10s default) with no heartbeat, mongo-1 increments the term, becomes a candidate, and requests votes from the rest of the set.
    </div>
    <div class="stepper-panel">
      <strong>4. Majority vote, new primary.</strong> mongo-2 grants its vote since mongo-1's oplog is at least as recent as its own. mongo-1 wins a majority (2 of 3, including itself) and becomes the new primary — roughly 10s of write unavailability for that period.
    </div>
    <div class="stepper-panel">
      <strong>5. Old primary rejoins as secondary.</strong> mongo-0 recovers, discovers a higher term already has a primary, steps down to secondary, and catches up its oplog from mongo-1.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Election prerequisites:** Candidate must have oplog at least as recent as the majority. A secondary that is too far behind cannot win election — prevents data loss.

<div class="quiz-card">
  <p class="quiz-q">mongo-2's oplog has fallen noticeably behind the rest of the set. The primary fails and mongo-2 tries to call an election and become primary. What stops it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>A candidate must have an oplog at least as recent as the majority of the set to win an election. Because mongo-2 is behind, the other voting members won't grant it their votes, so it can't win — this is what prevents a stale node from becoming primary and silently losing whatever writes it never received.</div>
</div>

---

## Ops Manager / Community Operator

```yaml
apiVersion: mongodbcommunity.mongodb.com/v1
kind: MongoDBCommunity
metadata:
  name: mongodb
spec:
  members: 3
  type: ReplicaSet
  version: "7.0.0"
  security:
    authentication:
      modes: ["SCRAM"]
  users:
  - name: appuser
    db: admin
    passwordSecretRef:
      name: mongodb-secret
    roles:
    - name: readWrite
      db: myapp
  statefulSet:
    spec:
      volumeClaimTemplates:
      - metadata:
          name: data-volume
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: premium-rwo
          resources:
            requests:
              storage: 100Gi
```

---

## Backups

```bash
# Consistent backup with mongodump (logical)
mongodump \
  --uri="mongodb://user:pass@mongo-0:27017,mongo-1:27017,mongo-2:27017/?replicaSet=rs0" \
  --readPreference=secondary \   # don't impact primary
  --oplog \                      # capture oplog for point-in-time
  --out /backup/$(date +%Y%m%d)

# Restore from dump
mongorestore --uri="mongodb://..." --oplogReplay /backup/20240115

# VolumeSnapshot (physical — faster, consistent)
# Must pause writes or use --fsync lock for consistency
kubectl exec mongo-0 -- mongosh --eval "db.fsyncLock()"
# Take snapshot...
kubectl exec mongo-0 -- mongosh --eval "db.fsyncUnlock()"
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="logical" class="active">mongodump (logical)</button>
    <button data-tab="physical">VolumeSnapshot (physical)</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="logical">
      Reads documents out through the driver and writes them back out as BSON — portable across MongoDB versions and storage engines, and safe to run against a live secondary with <code>--readPreference=secondary</code> so it doesn't add load to the primary. Slower than a disk-level copy, and restoring means replaying documents back in, not just remounting a volume.
    </div>
    <div class="tab-panel" data-tab-panel="physical">
      A raw copy of the data files — much faster to take and restore for large datasets, but only consistent if writes are quiesced first (<code>fsyncLock</code>) or the node is stopped. Tied to the same storage engine and, generally, the same MongoDB version it was taken from.
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Why does the VolumeSnapshot approach require db.fsyncLock() before the snapshot, when mongodump doesn't need anything like it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>mongodump reads consistent, already-committed documents out through the normal driver interface — there's nothing "mid-write" to catch. A VolumeSnapshot copies the raw data files on disk, so without fsyncLock pausing writes first, the snapshot could capture files mid-write and be internally inconsistent on restore. fsyncUnlock releases the write pause once the snapshot is taken.</div>
</div>

---

## Read Preference Options

| Mode | Where reads go | Use case |
|------|---------------|---------|
| `primary` (default) | Always primary | Strong consistency required |
| `primaryPreferred` | Primary if available, else secondary | Slight performance boost with fallback |
| `secondary` | Any secondary | Analytics, reporting (stale OK) |
| `secondaryPreferred` | Secondary if available, else primary | Read scale-out |
| `nearest` | Lowest latency node | Geographic distribution |

<div class="quiz-card">
  <p class="quiz-q">Every secondary in the set is down (only the primary is reachable). A query uses readPreference: secondary. Another uses secondaryPreferred. What happens to each?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>secondary has nowhere to fall back to — with no secondary available, the read fails outright. secondaryPreferred falls back to the primary when no secondary is available, so it still succeeds. The "Preferred" suffix is exactly what makes the fallback behavior different, not just a synonym for the base mode.</div>
</div>

---

## MongoDB on Kubernetes — Community Operator

```bash
# Install MongoDB Community Operator
helm repo add mongodb https://mongodb.github.io/helm-charts
helm install community-operator mongodb/community-operator \
  --namespace mongodb-operator --create-namespace
```

```yaml
# Secret for admin password
apiVersion: v1
kind: Secret
metadata:
  name: mongodb-secret
  namespace: mongodb
type: Opaque
stringData:
  password: "changeme"
---
# 3-node Replica Set
apiVersion: mongodbcommunity.mongodb.com/v1
kind: MongoDBCommunity
metadata:
  name: mongodb
  namespace: mongodb
spec:
  members: 3
  type: ReplicaSet
  version: "7.0.4"

  security:
    authentication:
      modes: ["SCRAM"]

  users:
  - name: appuser
    db: admin
    passwordSecretRef:
      name: mongodb-secret
    roles:
    - name: readWrite
      db: myapp
    - name: clusterMonitor
      db: admin
    scramCredentialsSecretName: appuser-scram

  # MongoDB configuration
  additionalMongodConfig:
    operationProfiling:
      slowOpThresholdMs: 100
    replication:
      oplogSizeMB: 2048

  # Storage per pod
  statefulSet:
    spec:
      volumeClaimTemplates:
      - metadata:
          name: data-volume
        spec:
          accessModes: [ReadWriteOnce]
          storageClassName: gp3
          resources:
            requests:
              storage: 100Gi
      - metadata:
          name: logs-volume
        spec:
          accessModes: [ReadWriteOnce]
          storageClassName: gp3
          resources:
            requests:
              storage: 10Gi
      template:
        spec:
          containers:
          - name: mongod
            resources:
              requests:
                cpu: "2"
                memory: 8Gi
              limits:
                cpu: "4"
                memory: 16Gi
```

```bash
# Check replica set status
kubectl get mongodbcommunity mongodb -n mongodb
# NAME      PHASE   VERSION
# mongodb   Running 7.0.4

# Connect string (headless service creates per-pod DNS)
# mongodb-0.mongodb-svc.mongodb.svc.cluster.local:27017
# mongodb-1.mongodb-svc.mongodb.svc.cluster.local:27017
# mongodb-2.mongodb-svc.mongodb.svc.cluster.local:27017

kubectl exec -it mongodb-0 -n mongodb -- mongosh \
  "mongodb://appuser:changeme@mongodb-0.mongodb-svc:27017,mongodb-1.mongodb-svc:27017,mongodb-2.mongodb-svc:27017/myapp?replicaSet=mongodb"

# Check replica set status from inside
> rs.status()
> rs.isMaster()   # shows who is primary
```

```yaml
# Services created automatically by operator:
# mongodb-svc       ClusterIP None   — headless, per-pod DNS
# mongodb-svc-ext   ClusterIP        — single endpoint for the replica set
apiVersion: v1
kind: Service
metadata:
  name: mongodb-svc
  namespace: mongodb
spec:
  clusterIP: None   # headless
  selector:
    app: mongodb-svc
  ports:
  - port: 27017
```

<div class="quiz-card">
  <p class="quiz-q">The operator creates both mongodb-svc (headless, per-pod DNS) and mongodb-svc-ext (a single ClusterIP endpoint). Why does the connection string above list out mongodb-0.mongodb-svc, mongodb-1.mongodb-svc, mongodb-2.mongodb-svc individually instead of just pointing at the single mongodb-svc-ext endpoint?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>A replica set client needs to know about — and be able to reach — every member individually, because it has to track who's currently primary and be able to route reads to specific secondaries under a given readPreference. A single virtual endpoint can't distinguish one member from another, so the driver is handed the per-pod headless DNS names and figures out the topology itself via replicaSet=mongodb.</div>
</div>

---

## Pod Anti-Affinity & Pod Disruption Budget

Without pod anti-affinity, Kubernetes can schedule all 3 MongoDB replicas on the same node — losing that node loses the entire replica set. Without a PodDisruptionBudget, a rolling node drain can evict multiple replicas simultaneously.

**Add anti-affinity to the MongoDBCommunity CR** (under `spec.statefulSetConfiguration`):

```yaml
statefulSetConfiguration:
  spec:
    template:
      spec:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:   # hard rule — refuse to schedule if can't spread
            - labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - mongodb
              topologyKey: kubernetes.io/hostname              # one replica per node
            preferredDuringSchedulingIgnoredDuringExecution:   # soft rule — prefer different AZs
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                  - key: app
                    operator: In
                    values:
                    - mongodb
                topologyKey: topology.kubernetes.io/zone
```

**PodDisruptionBudget** — prevents draining more than one MongoDB node at a time:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mongodb-pdb
  namespace: mongodb
spec:
  minAvailable: 2        # always keep at least primary + one secondary up
  selector:
    matchLabels:
      app: mongodb       # matches pods created by the operator
```

<div class="quiz-card">
  <p class="quiz-q">A node drain evicts mongodb-0 (primary) and mongodb-1 (secondary) simultaneously on a 3-member replica set with no PDB. What is the cluster state immediately after?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The replica set loses 2 of 3 members simultaneously, dropping below quorum (majority = 2). The surviving member (mongodb-2) cannot elect a new primary without a majority vote — it stays secondary. The cluster goes read-only: reads may succeed with readPreference: secondary, but writes are rejected until at least one evicted pod reschedules and rejoins. A PDB prevents this by blocking the drain of a second node while the first's pod is not yet Ready again.</div>
</div>

---

## WiredTiger Cache for Kubernetes

The MongoDB internals file explains the 50%-of-RAM rule. On Kubernetes, the relevant RAM is the **container memory limit**, not the node's total RAM.

If `cacheSizeGB` is not set, WiredTiger defaults to `(total RAM − 1GB) / 2`. On a node with 64GB RAM, a container with a 12Gi memory limit but no `cacheSizeGB` will attempt to use ~31GB — it triggers the OOMKiller almost immediately.

```yaml
# In MongoDBCommunity spec:
spec:
  additionalMongodConfig:
    storage.wiredTiger.engineConfig.cacheSizeGB: 6    # ~50% of container memory limit (12Gi)
  statefulSetConfiguration:
    spec:
      template:
        spec:
          containers:
          - name: mongod
            resources:
              requests:
                memory: "8Gi"
                cpu: "2"
              limits:
                memory: "12Gi"    # cacheSizeGB should be ~50% of this value
                cpu: "4"
```

Rule: `cacheSizeGB ≈ (container memory limit in GB) × 0.5`. Leave headroom for the connection pool, sort buffers, and the OS page cache.

<div class="quiz-card">
  <p class="quiz-q">A MongoDB pod has a memory limit of 8Gi and no cacheSizeGB set. The node has 64GB RAM. What does WiredTiger use as its cache size, and what happens?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>WiredTiger reads total system RAM (64GB) and sets cache to (64−1)/2 ≈ 31.5GB. The container's memory limit is 8Gi — allocating 31GB inside an 8GB container immediately triggers the OOM killer, which terminates mongod. The pod restarts, hits OOM again, and enters CrashLoopBackOff. Always set cacheSizeGB explicitly to roughly 50% of the container memory limit.</div>
</div>

---

## Prometheus Monitoring

The Community Operator doesn't deploy a MongoDB Exporter — deploy it separately.

**Create the monitoring user** (run inside the primary pod):

```javascript
db.getSiblingDB("admin").createUser({
  user: "prometheus",
  pwd: "monitoring-password",
  roles: [
    { role: "clusterMonitor", db: "admin" },
    { role: "read", db: "local" }
  ]
})
```

**Deploy mongodb-exporter** (Percona's exporter):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mongodb-exporter
  namespace: mongodb
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mongodb-exporter
  template:
    metadata:
      labels:
        app: mongodb-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9216"
    spec:
      containers:
      - name: mongodb-exporter
        image: percona/mongodb_exporter:0.40
        args:
        - --mongodb.uri=$(MONGODB_URI)
        - --collect-all          # enable all available collectors
        - --compatible-mode      # include legacy metric names for older dashboards
        env:
        - name: MONGODB_URI
          valueFrom:
            secretKeyRef:
              name: mongodb-exporter-secret
              key: uri
        ports:
        - containerPort: 9216
---
apiVersion: v1
kind: Secret
metadata:
  name: mongodb-exporter-secret
  namespace: mongodb
stringData:
  # List all replica set members — driver handles primary discovery and failover
  uri: "mongodb://prometheus:monitoring-password@mongodb-0.mongodb-svc.mongodb.svc.cluster.local:27017,mongodb-1.mongodb-svc.mongodb.svc.cluster.local:27017,mongodb-2.mongodb-svc.mongodb.svc.cluster.local:27017/admin?replicaSet=mongodb"
---
apiVersion: v1
kind: Service
metadata:
  name: mongodb-exporter
  namespace: mongodb
  labels:
    app: mongodb-exporter
spec:
  ports:
  - name: metrics
    port: 9216
  selector:
    app: mongodb-exporter
```

**Prometheus ServiceMonitor** (Prometheus Operator):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: mongodb-exporter
  namespace: mongodb
spec:
  selector:
    matchLabels:
      app: mongodb-exporter
  endpoints:
  - port: metrics
    interval: 30s
```

**Key alert rules:**

```promql
# No PRIMARY member — replica set is read-only
sum(mongodb_rs_members_state{state="PRIMARY"}) == 0

# Secondary replication lag > 30s
max(mongodb_rs_members_optimeDate{state="SECONDARY"})
  - max(mongodb_rs_members_optimeDate{state="PRIMARY"}) > 30

# Connection pool > 80% utilized
mongodb_connections{state="current"} / mongodb_connections{state="available"} > 0.8

# WiredTiger cache dirty ratio > 20% (memory pressure)
mongodb_wiredtiger_cache_dirty_bytes
  / mongodb_wiredtiger_cache_bytes_currently_in_cache > 0.2
```

<div class="quiz-card">
  <p class="quiz-q">The mongodb-exporter URI points only at mongodb-0's pod DNS name. After a failover, mongodb-1 becomes primary. Does the exporter keep reporting correctly?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — the exporter is connected to mongodb-0 specifically. After failover, mongodb-0 is now a secondary, so the exporter's primary-state metrics will be wrong, and if mongodb-0 restarts it loses the connection entirely. The fix is to list all replica set members in the URI with replicaSet= (as shown above): the MongoDB driver discovers which member is currently primary and reconnects automatically after failover.</div>
</div>

---

## Rolling Upgrade via Operator

The Community Operator performs rolling upgrades when `spec.version` changes:

```bash
# Patch the MongoDBCommunity resource to the new version
kubectl -n mongodb patch mongodbcommunity mongodb \
  --type='merge' \
  -p '{"spec":{"version":"7.0.5"}}'

# Watch upgrade progress
kubectl -n mongodb get mongodbcommunity -w
# NAME      PHASE      VERSION
# mongodb   Updating   7.0.4    ← rolling pods one at a time
# mongodb   Running    7.0.5    ← complete
```

**What the operator does:** restarts pods one at a time — secondaries first, waits for each to reach Running + Ready, then triggers a primary stepdown and updates the primary last.

**Verify each member upgraded:**

```bash
for pod in mongodb-0 mongodb-1 mongodb-2; do
  echo -n "$pod: "
  kubectl -n mongodb exec $pod -- mongosh --eval "db.version()" --quiet
done
# mongodb-0: 7.0.5
# mongodb-1: 7.0.5
# mongodb-2: 7.0.5
```

**Rollback:** MongoDB does not support downgrading major versions. For a minor version rollback, patch `spec.version` back to the previous version — the operator applies the same rolling restart in reverse.
