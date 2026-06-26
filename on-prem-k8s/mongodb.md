# MongoDB on Kubernetes

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

**Election prerequisites:** Candidate must have oplog at least as recent as the majority. A secondary that is too far behind cannot win election — prevents data loss.

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

---

## Read Preference Options

| Mode | Where reads go | Use case |
|------|---------------|---------|
| `primary` (default) | Always primary | Strong consistency required |
| `primaryPreferred` | Primary if available, else secondary | Slight performance boost with fallback |
| `secondary` | Any secondary | Analytics, reporting (stale OK) |
| `secondaryPreferred` | Secondary if available, else primary | Read scale-out |
| `nearest` | Lowest latency node | Geographic distribution |

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
