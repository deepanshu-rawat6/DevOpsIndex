# Kubernetes Workloads

---

## Pod Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending: Pod created, waiting for scheduler
    Pending --> Running: Node assigned, containers starting
    Running --> Succeeded: All containers exited 0 (Job complete)
    Running --> Failed: Container exited non-zero, restartPolicy=Never
    Running --> Running: Container crash, restartPolicy=Always (CrashLoopBackOff if repeated)
    Pending --> Failed: Image pull error, resource unavailable
```

```mermaid
graph LR
    classDef phase fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef cstate fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef good fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef bad fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef warn fill:#f39c12,stroke:#d68910,color:#000,rx:8

    PENDING["Pending Scheduled, pulling image"]:::phase
    RUNNING["Running At least 1 container running"]:::phase
    SUCCEEDED["Succeeded All containers exited 0"]:::good
    FAILED["Failed Container exited non-zero"]:::bad
    UNKNOWN["Unknown Node unreachable"]:::warn

    PENDING --> RUNNING
    RUNNING --> SUCCEEDED
    RUNNING --> FAILED
    RUNNING --> UNKNOWN
```

**Container states within a Running pod:**

| State | Meaning |
|-------|---------|
| `Waiting` | Starting, pulling image, or CrashLoopBackOff |
| `Running` | Process is executing |
| `Terminated` | Process exited (check exitCode: 0=success, 137=OOMKilled, 1=error) |

**CrashLoopBackOff** — container keeps crashing. Kubernetes applies exponential backoff (10s → 20s → 40s → 80s → 160s → 5min cap) between restart attempts. Not a stuck state — it will keep retrying. Check logs with `kubectl logs <pod> --previous`.

---

## Probes

Probes are health checks kubelet runs against your container. Three types, each with a distinct purpose.

```mermaid
graph TD
    classDef probe fill:#8e44ad,stroke:#6c3483,color:#fff,rx:8
    classDef action fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef ok fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef note fill:#f39c12,stroke:#d68910,color:#000,rx:6

    subgraph StartupProbe["Startup Probe"]
        SP["Runs FIRST during container startup Blocks liveness+readiness until it passes For slow-starting apps (legacy, DB migrations)"]:::probe
        SP -->|"fails failureThreshold times"| KILL1["Container killed and restarted"]:::action
        SP -->|"passes"| SP_OK["Liveness + Readiness probes begin"]:::ok
    end

    subgraph LivenessProbe["Liveness Probe"]
        LP["Runs throughout pod lifetime Is the process still alive and not deadlocked?"]:::probe
        LP -->|"fails consecutively"| KILL2["Container killed and restarted kubelet respects restartPolicy"]:::action
        LP -->|"passes"| LP_OK["Container stays running"]:::ok
    end

    subgraph ReadinessProbe["Readiness Probe"]
        RP["Runs throughout pod lifetime Is the process ready to serve traffic?"]:::probe
        RP -->|"fails"| REMOVE["Pod IP removed from Service endpoints Traffic stops flowing to this pod"]:::action
        RP -->|"passes"| ADD["Pod IP added to Service endpoints Traffic flows to pod"]:::ok
    end
```

**Probe implementation types:**

```yaml
# HTTP GET — most common for web services
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10   # wait before first probe (startup time)
  periodSeconds: 10          # probe every 10s
  failureThreshold: 3        # fail 3 times before action
  timeoutSeconds: 5

# TCP Socket — for non-HTTP (gRPC, databases)
readinessProbe:
  tcpSocket:
    port: 5432
  initialDelaySeconds: 5

# Exec — run command inside container
livenessProbe:
  exec:
    command: ["pg_isready", "-U", "postgres"]
  periodSeconds: 30

# gRPC (K8s 1.24+)
livenessProbe:
  grpc:
    port: 8080
    service: "liveness"
```

**Key probe interactions:**
- Liveness failure → container restart (pod stays, container restarts)
- Readiness failure → pod removed from service endpoints (pod stays running, just gets no traffic)
- Startup probe present → liveness and readiness are BLOCKED until startup passes

---

## QoS Classes

Kubernetes assigns a QoS class to every pod. This determines **OOM kill priority** when a node runs out of memory.

```mermaid
graph TD
    classDef guaranteed fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef burstable fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef besteffort fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    subgraph G["Guaranteed — OOM killed LAST"]
        G1["requests == limits for ALL containers cpu: 500m request = 500m limit memory: 256Mi request = 256Mi limit"]:::guaranteed
    end

    subgraph B["Burstable — OOM killed if over request"]
        B1["requests < limits (or only requests set) cpu: 200m request, 1000m limit memory: 128Mi request, 512Mi limit"]:::burstable
    end

    subgraph BE["BestEffort — OOM killed FIRST"]
        BE1["No requests, no limits set Kernel kills these first under memory pressure"]:::besteffort
    end

    G --> B --> BE
    BE -.- NOTE["OOM kill order: BestEffort first, then Burstable over their request, then Guaranteed (almost never)"]
```

**Production recommendation:** Set both requests and limits for all containers. Use Guaranteed class for critical services (controllers, databases). Never run production workloads as BestEffort.

---

## Rolling Updates and Rollbacks

```mermaid
graph LR
    classDef v1 fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef v2 fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef terminating fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef rs fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph Start["Start: 3x v1 running"]
        V1A["v1 pod"]:::v1
        V1B["v1 pod"]:::v1
        V1C["v1 pod"]:::v1
    end

    subgraph Step1["maxSurge=1, maxUnavailable=0 Create 1 new v2 pod (surge)"]
        V1D["v1 pod"]:::v1
        V1E["v1 pod"]:::v1
        V1F["v1 pod"]:::v1
        V2A["v2 pod (new)"]:::v2
    end

    subgraph Step2["v2 pod passes readiness Terminate 1 v1 pod"]
        V1G["v1 pod"]:::v1
        V1H["v1 pod"]:::v1
        V1I["v1 pod terminating"]:::terminating
        V2B["v2 pod ✅"]:::v2
    end

    subgraph End["All 3 replaced with v2"]
        V2C["v2 pod"]:::v2
        V2D["v2 pod"]:::v2
        V2E["v2 pod"]:::v2
    end

    subgraph ReplicaSets["Deployment keeps both ReplicaSets"]
        RS1["ReplicaSet v1 replicas: 0 (kept for rollback)"]:::rs
        RS2["ReplicaSet v2 replicas: 3"]:::rs
    end
```

```yaml
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1         # max pods ABOVE desired (create new before deleting old)
      maxUnavailable: 0   # max pods BELOW desired (zero-downtime: never remove before replacement ready)
```

**Rollback:** The old ReplicaSet is never deleted (kept at 0 replicas). Rollback simply scales old RS back up and new RS back down:

```bash
kubectl rollout undo deployment/my-app                    # rollback to previous
kubectl rollout undo deployment/my-app --to-revision=3    # rollback to specific revision
kubectl rollout history deployment/my-app                  # see revision history
kubectl rollout status deployment/my-app                   # watch rollout progress
kubectl rollout pause deployment/my-app                    # pause mid-rollout (canary hold)
kubectl rollout resume deployment/my-app                   # resume
```

---

## StatefulSet vs Deployment

```mermaid
graph TD
    classDef deploy fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef stateful fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef pvc fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef storage fill:#e67e22,stroke:#d35400,color:#fff,rx:8

    subgraph DeploymentModel["Deployment: interchangeable pods"]
        D1["app-7f9d4-abc random name"]:::deploy
        D2["app-7f9d4-def random name"]:::deploy
        D3["app-7f9d4-ghi random name"]:::deploy
        SHARED_STORAGE["Shared storage or no persistent storage"]:::storage
        D1 --- SHARED_STORAGE
        D2 --- SHARED_STORAGE
    end

    subgraph StatefulSetModel["StatefulSet: stable identity"]
        SS1["postgres-0 stable name, index 0"]:::stateful
        SS2["postgres-1 stable name, index 1"]:::stateful
        SS3["postgres-2 stable name, index 2"]:::stateful
        PVC1["PVC: postgres-data-postgres-0 bound only to postgres-0"]:::pvc
        PVC2["PVC: postgres-data-postgres-1 bound only to postgres-1"]:::pvc
        PVC3["PVC: postgres-data-postgres-2"]:::pvc
        SS1 --> PVC1
        SS2 --> PVC2
        SS3 --> PVC3
    end
```

**StatefulSet guarantees:**

| Guarantee | Detail |
|-----------|--------|
| **Stable pod names** | `<name>-0`, `<name>-1`, `<name>-2` — never random |
| **Stable DNS** | `postgres-0.postgres-svc.ns.svc.cluster.local` (requires Headless Service) |
| **Stable storage** | Each pod gets its own PVC via `volumeClaimTemplates`. PVC survives pod deletion. |
| **Ordered startup** | Pods start in order: 0 → 1 → 2. Each must be Running+Ready before next starts. |
| **Ordered shutdown** | Pods stop in reverse order: 2 → 1 → 0. |

**When to use StatefulSet:** Databases (PostgreSQL, MySQL), distributed systems with leader election (Kafka, Zookeeper, etcd), any app that needs stable network identity or per-instance storage.

---

## ReplicaSet vs StatefulSet — Deep Comparison

### ReplicaSet (via Deployment) — Stateless Pods

A ReplicaSet ensures N identical, interchangeable pod replicas are running. You never create a ReplicaSet directly — you use a **Deployment** which manages ReplicaSets for you (rolling updates, rollback).

```mermaid
graph TD
    DEP["Deployment<br>manages ReplicaSets"] --> RS_OLD["ReplicaSet v1<br>replicas: 0 (kept for rollback)"]
    DEP --> RS_NEW["ReplicaSet v2<br>replicas: 3"]
    RS_NEW --> P1["api-7f9d4-abc<br>random suffix"]
    RS_NEW --> P2["api-7f9d4-def<br>random suffix"]
    RS_NEW --> P3["api-7f9d4-ghi<br>random suffix"]
    P1 & P2 & P3 --> PVC_SHARED["Shared PVC (optional)<br>ReadWriteMany<br>e.g. EFS"]

    classDef pod fill:#3498db,stroke:#2980b9,color:#fff
    classDef rs fill:#e67e22,stroke:#d35400,color:#fff
    class P1,P2,P3 pod
    class RS_OLD,RS_NEW rs
```

**Pod identity:** none. Pod `api-7f9d4-abc` is identical to `api-7f9d4-def`. If one dies, the ReplicaSet creates a replacement with a new random name — no data is lost because stateless pods don't hold state.

**Scale up/down:** all pods started/stopped in parallel, any order. Scale from 3→5: 2 new pods created simultaneously.

### StatefulSet — Stateful Pods with Identity

```mermaid
graph TD
    STS["StatefulSet: postgres"] --> HS["Headless Service<br>clusterIP: None<br>postgres-svc"]
    STS --> P0["postgres-0<br>stable index"]
    STS --> P1["postgres-1<br>stable index"]
    STS --> P2["postgres-2<br>stable index"]
    P0 --> PVC0["PVC: data-postgres-0<br>always bound to postgres-0"]
    P1 --> PVC1["PVC: data-postgres-1<br>always bound to postgres-1"]
    P2 --> PVC2["PVC: data-postgres-2<br>always bound to postgres-2"]
    HS --> DNS0["DNS: postgres-0.postgres-svc.default.svc.cluster.local"]
    HS --> DNS1["DNS: postgres-1.postgres-svc.default.svc.cluster.local"]

    classDef pod fill:#9b59b6,stroke:#8e44ad,color:#fff
    classDef pvc fill:#2ecc71,stroke:#27ae60,color:#fff
    class P0,P1,P2 pod
    class PVC0,PVC1,PVC2 pvc
```

**Headless Service** (`clusterIP: None`) — required for StatefulSet DNS. Unlike a regular Service (which load-balances), a Headless Service creates individual DNS records for each pod. `postgres-0.postgres-svc` always resolves to `postgres-0`'s IP — clients can target a specific pod (e.g., write to primary, read from replicas).

### Ordered Startup and Deletion

```mermaid
sequenceDiagram
    participant STS as StatefulSet Controller
    participant P0 as postgres-0
    participant P1 as postgres-1
    participant P2 as postgres-2

    Note over STS: Scale up (0 --> 3)
    STS->>P0: create postgres-0
    P0-->>STS: Running + Ready
    STS->>P1: create postgres-1 (only after P0 ready)
    P1-->>STS: Running + Ready
    STS->>P2: create postgres-2 (only after P1 ready)
    P2-->>STS: Running + Ready

    Note over STS: Scale down (3 --> 1)
    STS->>P2: delete postgres-2 (highest index first)
    P2-->>STS: terminated
    STS->>P1: delete postgres-1
    P1-->>STS: terminated
    Note over P0: postgres-0 remains
```

Why ordered? Databases need the primary (index 0) to be healthy before replicas join. Shutting down the replica before the primary prevents split-brain.

---

## Which Applications Use Which

```mermaid
graph TD
    APP["Your Application"] --> Q1{"Does each instance<br>need its own<br>persistent data?"}
    Q1 -->|No| Q2{"Multiple instances<br>interchangeable?"}
    Q1 -->|Yes| STATEFUL["StatefulSet"]
    Q2 -->|Yes| DEPLOYMENT["Deployment + ReplicaSet"]
    Q2 -->|No singleton| SINGLETON["Deployment replicas:1<br>or StatefulSet replicas:1"]

    classDef dep fill:#3498db,stroke:#2980b9,color:#fff
    classDef sts fill:#9b59b6,stroke:#8e44ad,color:#fff
    class DEPLOYMENT dep
    class STATEFUL,SINGLETON sts
```

### Deployment (ReplicaSet) — Stateless Workloads

| Application | Why Deployment |
|-------------|---------------|
| REST API servers | All pods identical, share DB connection, any pod can handle any request |
| GraphQL / gRPC services | Stateless request handling |
| Web frontends | No per-pod data |
| Worker processes (SQS consumer) | Any worker can process any message |
| Batch processors | Jobs consume from a queue, no local state |
| ML inference servers (vLLM, TorchServe) | Model loaded in each pod's memory but no unique per-pod data to persist |
| API gateways, proxies | Pure request routing, stateless |

### StatefulSet — Stateful Workloads

| Application | Why StatefulSet | Key requirement |
|-------------|----------------|-----------------|
| **PostgreSQL** | Each replica has its own WAL + data directory | Per-pod PVC, ordered startup (primary first) |
| **MySQL / MariaDB** | Master-replica with per-node data | Stable names for replication config |
| **Redis (cluster mode)** | Each shard owns specific key slots | Stable identity for cluster topology |
| **Apache Kafka** | Each broker owns specific partitions on disk | Stable broker ID = stable pod name |
| **Zookeeper** | Quorum requires stable myid | `zoo-0`, `zoo-1`, `zoo-2` fixed identity |
| **Elasticsearch** | Each node stores specific shards | Per-pod PVC, stable cluster node names |
| **Cassandra** | Each node owns a token range | Stable gossip identity |
| **etcd** | Raft consensus requires stable peer URLs | `etcd-0.etcd` etc. |

### The Key Question to Ask

```
"If I delete this pod and a new one starts with a different name and no local data,
does the application still work correctly?"

YES → Deployment
NO  → StatefulSet
```

**Redis Standalone** (`replicas:1`, in-memory cache): Deployment — if it restarts, it starts fresh. The cache warms up again. Acceptable.

**Redis Cluster** (sharded, data must persist): StatefulSet — each node owns data, must reconnect to cluster with same identity.

**PostgreSQL primary**: StatefulSet — data on disk, WAL, per-node state. Restarting with a different name would break replication setup.

---

## Comparison Table

| Feature | Deployment (ReplicaSet) | StatefulSet |
|---------|------------------------|-------------|
| Pod names | Random (`app-abc123-xyz`) | Stable (`app-0`, `app-1`) |
| Pod DNS | Single Service (load-balanced) | Headless Service (per-pod DNS) |
| Storage | Shared PVC or no PVC | Per-pod PVC via `volumeClaimTemplates` |
| PVC on pod delete | PVC deleted with pod | **PVC survives pod deletion** |
| Scale up order | Parallel (all at once) | Sequential (0, 1, 2...) |
| Scale down order | Any order | Reverse (N, N-1, N-2...) |
| Rolling update | New RS created, old RS scaled down | Pod-by-pod, highest index first |
| Use case | Stateless APIs, workers | Databases, queues, consensus systems |



## Init Containers

Init containers run **sequentially before app containers start**. Each must exit 0 before the next runs. If any init container fails, the pod restarts.

```mermaid
sequenceDiagram
    participant K as kubelet
    participant I1 as init-container-1
    participant I2 as init-container-2
    participant APP as app container

    K->>I1: start (wait-for-db)
    Note over I1: loops until postgres:5432 is reachable
    I1-->>K: exit 0
    K->>I2: start (run-migrations)
    I2-->>K: exit 0 (migrations done)
    K->>APP: start main application
    Note over APP: DB is ready AND migrated before app starts
```

```yaml
spec:
  initContainers:
  # 1. Wait for dependency to be ready
  - name: wait-for-db
    image: busybox
    command: ['sh', '-c', 'until nc -z postgres-svc 5432; do echo waiting; sleep 2; done']

  # 2. Run DB migration before app starts
  - name: migrate
    image: my-app:v2
    command: ["/app/server", "migrate"]
    env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: url

  containers:
  - name: app
    image: my-app:v2
    # starts only after both init containers succeed
```

**Common init container patterns:**

| Pattern | Init container does | Why |
|---------|-------------------|-----|
| Wait for dependency | `nc -z svc port` loop | Prevent app crash on startup |
| DB migration | `./migrate up` | Run once before N replicas start |
| Secret injection | Fetch secret from Vault, write to emptyDir | Avoid mounting Vault agent sidecar |
| Config rendering | Render templates with env vars | App expects rendered config, not templates |
| Permission fix | `chown` shared volume | App needs specific UID on data directory |

**Init containers share volumes with app containers** — this is how they pass data:

```yaml
volumes:
- name: config
  emptyDir: {}
initContainers:
- name: render-config
  image: renderer:v1
  command: ["render", "--output", "/config/app.yaml"]
  volumeMounts:
  - name: config
    mountPath: /config
containers:
- name: app
  volumeMounts:
  - name: config
    mountPath: /etc/app   # reads rendered config written by init container
```

---

## Ephemeral Containers — Debug Running Pods

Ephemeral containers can be injected into a **running pod** without restarting it. Used for debugging when the app container has no shell (distroless, scratch).

```bash
# Inject a debug container into a running pod
kubectl debug -it my-pod \
  --image=nicolaka/netshoot \    # has tcpdump, curl, dig, netstat
  --target=app \                  # shares app container's process namespace
  -- bash

# Inside netshoot: debug the running app
ps aux              # see app processes (shared PID namespace)
netstat -tlnp       # see what ports app is listening on
curl localhost:8080/health
tcpdump -i any port 8080

# Debug with a copy of the pod (for crashlooping pods)
kubectl debug my-crashlooping-pod \
  --copy-to=debug-copy \
  --image=busybox \
  --container=app \              # override the crashing container's image
  -- sleep 3600
# Now exec into debug-copy to inspect filesystem, env vars, etc.
```

```mermaid
graph LR
    POD["Running Pod<br>(distroless — no shell)"] -->|"kubectl debug inject"| EPH["Ephemeral container<br>nicolaka/netshoot<br>shares: network NS, PID NS"]
    EPH -->|"can see"| PROC["App processes"]
    EPH -->|"can curl"| NET["App network"]
    EPH -->|"cannot modify"| POD
    NOTE["Pod is NOT restarted<br>Ephemeral container auto-removed when exited"]
```

**Ephemeral vs exec:**
- `kubectl exec` — needs a shell already in the container
- `kubectl debug` — injects a new container with tools, works on distroless images

---

## DaemonSet

Runs exactly **one pod per node** (or per matching node). When new nodes join the cluster, DaemonSet automatically schedules a pod on them.

```mermaid
graph LR
    classDef ds fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef node fill:#34495e,stroke:#2c3e50,color:#fff,rx:8

    DS["DaemonSet: fluentd-logger"]:::ds

    subgraph N1["Node 1"]
        P1["fluentd pod (auto-scheduled)"]:::ds
    end
    subgraph N2["Node 2"]
        P2["fluentd pod"]:::ds
    end
    subgraph N3["Node 3 (new node joins)"]
        P3["fluentd pod (auto-added)"]:::ds
    end

    DS --> P1 & P2 & P3
```

**Common DaemonSet use cases:** Log collectors (Fluentd, Fluent Bit), metrics agents (node-exporter), security agents (Falco), network plugins (CNI DaemonSets like aws-node), storage drivers.

DaemonSets can be constrained to specific nodes using `nodeSelector` or `affinity` — e.g., run GPU monitoring DaemonSet only on GPU nodes.

---

## Jobs and CronJobs

```mermaid
graph TD
    classDef job fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef cron fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef pod fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef done fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    subgraph JobFlow["Job: run to completion"]
        J["Job: db-migrate completions: 1 parallelism: 1"]:::job
        J --> JP["Pod created"]:::pod
        JP --> DONE["Pod exits 0 Job status: Complete"]:::done
        JP --> FAIL["Pod exits non-zero Job retries (backoffLimit: 4)"]:::job
    end

    subgraph CronFlow["CronJob: scheduled Jobs"]
        CJ["CronJob: nightly-report schedule: 0 2 * * *"]:::cron
        CJ -->|"2 AM daily"| JOB1["Job created (new Job each trigger)"]:::job
        CJ -->|"next night"| JOB2["Job created"]:::job
    end
```

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
spec:
  completions: 1       # how many successful completions needed
  parallelism: 1       # how many pods run in parallel
  backoffLimit: 4      # retry up to 4 times on failure
  activeDeadlineSeconds: 300  # kill if takes > 5 min
  template:
    spec:
      restartPolicy: Never    # Job pods must use Never or OnFailure
      containers:
        - name: migrate
          image: my-app:v2
          command: ["/app/server", "migrate"]
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid       # don't start new job if previous still running
  successfulJobsHistoryLimit: 3   # keep last 3 successful job records
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: reporter
              image: my-app:v2
              command: ["/app/server", "report"]
```
