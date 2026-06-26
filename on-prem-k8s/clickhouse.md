# ClickHouse on Kubernetes

## Architecture

```mermaid
graph TD
    subgraph "ClickHouse Cluster (Sharded + Replicated)"
        subgraph "Shard 1"
            CH00["clickhouse-0-0 (replica 0)<br>handles ~50% of data"]
            CH01["clickhouse-0-1 (replica 1)<br>hot standby for shard 1"]
        end
        subgraph "Shard 2"
            CH10["clickhouse-1-0 (replica 0)<br>handles ~50% of data"]
            CH11["clickhouse-1-1 (replica 1)<br>hot standby for shard 2"]
        end
        ZK3["ZooKeeper / ClickHouse Keeper<br>coordinates replication<br>stores replica state"]
        CH00 & CH01 --> ZK3
        CH10 & CH11 --> ZK3
    end

    CLIENT3["Client<br>queries distributed table"] -->|"fan-out query to all shards"| DIST["Distributed table<br>merges results"]
    DIST --> CH00 & CH10
```

**Distributed table** — a virtual table that fans queries out to all shards and merges results. Actual data lives in `MergeTree` tables on each shard.

---

## Replication with ClickHouse Keeper

```mermaid
sequenceDiagram
    participant CLIENT4 as Client
    participant CH0 as clickhouse-0-0 (replica 0)
    participant KEEPER as ClickHouse Keeper
    participant CH1 as clickhouse-0-1 (replica 1)

    CLIENT4->>CH0: INSERT INTO events VALUES (...)
    CH0->>CH0: Write to local ReplicatedMergeTree part
    CH0->>KEEPER: Register new data part (part_name, checksum)
    KEEPER->>CH1: Notify: new part available from CH0
    CH1->>CH0: Fetch data part
    CH0-->>CH1: Data part
    CH1->>CH1: Apply locally
    CH1->>KEEPER: Confirm part received
    KEEPER-->>CLIENT4: (async — CH0 already confirmed to client)
```

**ClickHouse replication is asynchronous by default.** The INSERT returns when the local replica writes it. The keeper coordinates other replicas fetching it. This can lead to stale reads from a replica.

---

## ClickHouse Operator (Altinity)

```yaml
apiVersion: clickhouse.altinity.com/v1
kind: ClickHouseInstallation
metadata:
  name: clickhouse
spec:
  configuration:
    clusters:
    - name: main
      layout:
        shardsCount: 2
        replicasCount: 2
    zookeeper:
      nodes:
      - host: zookeeper-0.zookeeper-headless
      - host: zookeeper-1.zookeeper-headless
      - host: zookeeper-2.zookeeper-headless
    settings:
      max_connections: 200
      max_concurrent_queries: 100

  templates:
    volumeClaimTemplates:
    - name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: premium-rwo
        resources:
          requests:
            storage: 500Gi
```

---

## Backups with clickhouse-backup

```bash
# Install clickhouse-backup
# Create full backup to GCS
clickhouse-backup create --tables "mydb.*" full_backup_$(date +%Y%m%d)
clickhouse-backup upload full_backup_$(date +%Y%m%d)

# Incremental backup (since last full)
clickhouse-backup create --diff-from full_backup_20240101 incr_$(date +%Y%m%d)
clickhouse-backup upload incr_$(date +%Y%m%d)

# Restore
clickhouse-backup download full_backup_20240101
clickhouse-backup restore full_backup_20240101

# Run as K8s CronJob
apiVersion: batch/v1
kind: CronJob
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: altinity/clickhouse-backup:latest
            command: [clickhouse-backup, create-and-upload]
            env:
            - name: GCS_BUCKET
              value: my-clickhouse-backups
```

---

## Monitoring

```promql
# Queries per second
rate(ClickHouseMetrics_Query[5m])

# Memory usage
ClickHouseMetrics_MemoryTracking / ClickHouseAsyncMetrics_MemoryTotal > 0.8

# Replication queue lag (alert if > 100 parts behind)
ClickHouseMetrics_ReplicatedChecks > 100

# Merge queue (writes slow if too high)
ClickHouseMetrics_BackgroundPoolTask > 50
```
