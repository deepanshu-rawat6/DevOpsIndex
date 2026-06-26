# Redis Cluster on Kubernetes

## Redis Modes

```mermaid
graph TD
    STANDALONE["Standalone<br>Single instance<br>No HA<br>Use: dev, small cache"] --> SENTINEL
    SENTINEL["Sentinel<br>1 master + N replicas<br>Sentinel monitors + promotes<br>Use: HA without sharding"] --> CLUSTER
    CLUSTER["Redis Cluster<br>N masters, each with replicas<br>Data sharded across masters<br>Use: horizontal scale + HA"]
```

---

## Redis Cluster Architecture (6-node minimum)

```mermaid
graph TD
    subgraph "Redis Cluster on K8s"
        M0["redis-0 (master)<br>slots: 0-5460"] --> R0["redis-3 (replica of redis-0)"]
        M1["redis-1 (master)<br>slots: 5461-10922"] --> R1["redis-4 (replica of redis-1)"]
        M2["redis-2 (master)<br>slots: 10923-16383"] --> R2["redis-5 (replica of redis-2)"]
    end
    CLIENT["Client<br>(redis-py cluster / jedis cluster)"] --> M0 & M1 & M2
```

**16384 hash slots** are distributed across masters. Every key is hashed (`CRC16(key) % 16384`) to find which slot (and thus which master) owns it.

---

## Key Distribution (Hash Slots)

```mermaid
graph LR
    KEY["SET user:123 alice"] --> HASH["CRC16('user:123') % 16384 = 8547"]
    HASH --> SLOT["Slot 8547 is on redis-1<br>(slots 5461-10922)"]
    SLOT --> M1_2["Request routed to redis-1"]
```

**Hash tags** `{tag}key` force keys to the same slot (for multi-key operations):
```
SET {user:123}.name alice   -- slot = CRC16('user:123') % 16384
SET {user:123}.email a@b.c  -- same slot
MGET {user:123}.name {user:123}.email  -- works (same slot)
```

---

## Failover

```mermaid
sequenceDiagram
    participant M1_3 as redis-1 (master)
    participant R1_3 as redis-4 (replica)
    participant M0_2 as redis-0 (other master)
    participant M2_2 as redis-2 (other master)
    participant CLIENT2 as Client

    Note over M1_3: redis-1 crashes
    M0_2->>M1_3: PING (cluster gossip)
    M2_2->>M1_3: PING (cluster gossip)
    M0_2--xM1_3: No response (PFAIL after cluster-node-timeout=15s)
    M2_2--xM1_3: No response

    Note over M0_2,M2_2: Cluster marks redis-1 as FAIL (majority agree)
    R1_3->>M0_2: FAILOVER request
    M0_2->>R1_3: ACK — vote for redis-4 as new master
    M2_2->>R1_3: ACK — vote for redis-4 as new master

    R1_3->>R1_3: Promoted to master for slots 5461-10922
    Note over CLIENT2: Client gets MOVED/ASK redirect to redis-4
    CLIENT2->>R1_3: Requests for slots 5461-10922 now go here
```

**Failover time:** `cluster-node-timeout` (default 15s) + election + promotion ≈ 15-30s.

---

## Persistence: RDB vs AOF

```mermaid
graph LR
    subgraph RDB["RDB (Redis Database Snapshot)"]
        R1_P["Full snapshot every N seconds<br>save 900 1<br>save 300 10<br>save 60 10000<br>Fast restore, possible data loss<br>up to last snapshot"]
    end
    subgraph AOF["AOF (Append Only File)"]
        A1_P["Every write operation logged<br>appendfsync always: flush per write<br>appendfsync everysec: flush per second<br>Slower, near-zero data loss"]
    end
    subgraph BOTH["RDB + AOF (recommended for production)"]
        B1_P["AOF for durability<br>RDB for fast restart<br>Redis loads RDB first (faster),<br>then replays AOF for recent data"]
    end
```

```bash
# redis.conf
save 3600 1        # snapshot if 1 key changed in 1h
save 300 100       # snapshot if 100 keys changed in 5m
save 60 10000      # snapshot if 10000 keys changed in 1m
appendonly yes
appendfsync everysec  # fsync every second (good balance)
no-appendfsync-on-rewrite yes  # don't fsync during compaction
```

---

## Redis Cluster on K8s (StatefulSet)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  replicas: 6   # 3 masters + 3 replicas
  serviceName: redis-headless
  template:
    spec:
      containers:
      - name: redis
        image: redis:7.2-alpine
        command:
        - redis-server
        - /etc/redis/redis.conf
        - --cluster-enabled yes
        - --cluster-config-file /data/nodes.conf
        - --cluster-node-timeout 15000
        - --appendonly yes
        - --save 3600 1
        resources:
          limits:
            memory: 8Gi
          requests:
            memory: 4Gi
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: premium-rwo
      resources:
        requests:
          storage: 50Gi
```

```bash
# Initialize the cluster (run once after pods start)
redis-cli --cluster create \
  redis-0.redis-headless:6379 \
  redis-1.redis-headless:6379 \
  redis-2.redis-headless:6379 \
  redis-3.redis-headless:6379 \
  redis-4.redis-headless:6379 \
  redis-5.redis-headless:6379 \
  --cluster-replicas 1   # 1 replica per master

# Check cluster state
redis-cli -c cluster info
redis-cli -c cluster nodes
```

---

## Backups

```bash
# Trigger RDB snapshot on primary
redis-cli BGSAVE
# Wait for completion
redis-cli LASTSAVE  # returns UNIX timestamp of last successful save

# Copy RDB to GCS
gsutil cp /data/dump.rdb gs://my-redis-backups/$(date +%Y%m%d)/dump.rdb

# Volume snapshot (quicker, consistent)
kubectl apply -f - << 'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: redis-snapshot-$(date +%Y%m%d)
spec:
  source:
    persistentVolumeClaimName: data-redis-0
EOF
```

---

## Monitoring

```promql
# Memory usage (alert > 80% of maxmemory)
redis_memory_used_bytes / redis_memory_max_bytes > 0.8

# Cache hit rate (alert < 90%)
rate(redis_keyspace_hits_total[5m]) /
(rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m])) < 0.9

# Cluster state (1 = ok)
redis_cluster_state != 1

# Replication lag (bytes)
redis_connected_slaves < 1  # alert if no replicas
```
