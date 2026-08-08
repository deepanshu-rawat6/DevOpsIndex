# Databases on Kubernetes (GKE / On-Prem)

Running stateful databases on Kubernetes — system design, replication, failover, snapshots, and operational patterns for each database.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

## Why Run DBs on K8s?

Running databases on Kubernetes is operationally harder than managed services (Cloud SQL, RDS) but gives you:
- **Cost control** — no managed service markup (3-5× cheaper at scale)
- **Portability** — same setup on GKE, EKS, on-prem
- **Customization** — specific versions, plugins, tuning impossible in managed offerings
- **Data residency** — compliance requirements that forbid managed cloud DBs

**When NOT to run DBs on K8s:** Small teams, < 3 engineers who understand K8s storage, or when managed services fit your compliance requirements. Operational burden is real.

<div class="quiz-card">
  <p class="quiz-q">A 2-engineer team wants Postgres on K8s to avoid the managed-service markup. Good idea?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Probably not yet. The cost savings are real, but running stateful DBs on
    K8s (storage, failover, backups) needs engineers who already understand
    K8s storage — a team under 3 such engineers usually pays for that gap in
    outages, not cash saved.
  </div>
</div>

## Files

| File | Database | Topics |
|------|----------|--------|
| [postgres.md](./postgres.md) | PostgreSQL | StatefulSet, Patroni HA, sync/async replication, automatic failover, PITR, pgbackup |
| [mysql.md](./mysql.md) | MySQL | Operator, InnoDB Cluster, semi-sync replication, master promotion, XtraBackup |
| [mongodb.md](./mongodb.md) | MongoDB | Replica set on K8s, elections, oplog, readPreference, mongodump/mongorestore |
| [redis-cluster.md](./redis-cluster.md) | Redis Cluster | Sharding, slot distribution, sentinel vs cluster, persistence (RDB/AOF), failover |
| [kafka.md](./kafka.md) | Apache Kafka | Strimzi operator, partition replication, ISR, leader election, consumer groups |
| [clickhouse.md](./clickhouse.md) | ClickHouse | ClickHouse Operator, sharding, replication via ZooKeeper/ClickHouse Keeper, backups |

## Common Patterns Across All DBs

```mermaid
graph TD
    PRIMARY["Primary / Leader<br>(accepts writes)"] -->|"sync or async replication"| REP1["Replica 1<br>(read traffic)"]
    PRIMARY --> REP2["Replica 2<br>(standby / DR)"]

    PROBE["Health check / probe<br>detect primary failure"] -->|"primary unhealthy"| ELECT["Leader election<br>replica promotion"]
    ELECT --> NEW_PRIMARY["New Primary<br>(former Replica 1)"]
    NEW_PRIMARY -->|"old primary rejoins as replica"| OLD["Old Primary<br>(now replica)"]
```

### Sync vs Async Replication

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="sync" class="active">Synchronous</button>
    <button data-tab="async">Asynchronous</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="sync">
      <p><strong>Write completes when:</strong> the primary AND at least one replica confirm the write.</p>
      <p><strong>Data loss on failover:</strong> zero — the replica already has everything the primary had.</p>
      <p><strong>Write latency:</strong> higher — every write waits on a round trip to the replica.</p>
      <p><strong>Replica lag:</strong> zero, by construction.</p>
      <p><strong>Use case:</strong> financial data, and anything else where losing a committed write is not an option.</p>
    </div>
    <div class="tab-panel" data-tab-panel="async">
      <p><strong>Write completes when:</strong> the primary confirms; replicas catch up afterward.</p>
      <p><strong>Data loss on failover:</strong> up to the replication lag — seconds to minutes of writes can vanish.</p>
      <p><strong>Write latency:</strong> lower — the primary never waits on a replica.</p>
      <p><strong>Replica lag:</strong> can fall behind under load or network pressure.</p>
      <p><strong>Use case:</strong> read replicas, analytics, DR copies where a little staleness is acceptable.</p>
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Your replica is 40 seconds behind the primary under async replication, and the primary just died. What happens to the last 40 seconds of writes?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    They're gone. Async replication only guarantees the primary accepted the
    write — not that any replica has it yet. Whatever hadn't shipped in that
    40-second lag window is lost the moment the primary becomes unavailable.
  </div>
</div>

### Snapshot Strategy (3-2-1 Rule)

```mermaid
graph LR
    LIVE["Live Database<br>(primary)"] -->|"daily full backup"| S3["Object Storage<br>(GCS / S3)"]
    LIVE -->|"WAL/oplog streaming"| S3
    S3 -->|"cross-region copy"| S3_DR["DR Region<br>Object Storage"]
    LIVE -->|"volume snapshot"| SNAP["K8s VolumeSnapshot<br>(GCP Persistent Disk)"]
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Full snapshot.</strong> Daily full backup of the primary, retained for 7 days.
    </div>
    <div class="stepper-panel">
      <strong>2. Continuous incremental.</strong> WAL (Postgres) or oplog (MongoDB) streamed continuously,
      enabling point-in-time recovery (PITR) between full snapshots.
    </div>
    <div class="stepper-panel">
      <strong>3. Cross-region copy.</strong> At least one copy of every backup lives in a different
      region or zone than the primary — the "1 offsite" in 3-2-1.
    </div>
    <div class="stepper-panel">
      <strong>4. Test restore.</strong> A weekly automated restore, run end-to-end. An untested
      backup is not a backup.
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
  <p class="quiz-q">You have a daily full snapshot and continuous WAL streaming, but you've never actually restored from either. Are you covered?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. An untested backup is not a backup — corruption, missing permissions,
    or a broken restore script only surface when you actually try to recover,
    which is exactly the worst time to discover it. That's why the 3-2-1
    strategy includes a weekly automated restore test as a required step, not
    an optional one.
  </div>
</div>
