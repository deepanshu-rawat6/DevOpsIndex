# Resource Requests and Limits

## 1. Requests vs Limits

```mermaid
flowchart TD
    REQ[requests<br/>guaranteed reservation] --> SCHED[Scheduler uses<br/>requests for bin-packing]
    LIM[limits<br/>hard ceiling] --> CPU[CPU: throttled<br/>via CFS quota]
    LIM --> MEM[Memory: OOMKilled<br/>if exceeded]

    subgraph QoS Classes
        G[Guaranteed<br/>req == limit]
        B[Burstable<br/>req &lt; limit]
        BE[BestEffort<br/>no req/limit]
    end

    REQ --> G
    REQ --> B
    BE --> EVICT[Evicted first<br/>under pressure]
```

```yaml
resources:
  requests:
    cpu: "250m"       # scheduler guarantee
    memory: "256Mi"
  limits:
    cpu: "1"          # throttled above this
    memory: "512Mi"   # OOMKilled above this
```

---

## 2. CPU Throttling (CFS Quota)

The Linux CFS (Completely Fair Scheduler) enforces CPU limits via two cgroup knobs:

```
cpu.cfs_period_us = 100000   (100ms period)
cpu.cfs_quota_us  = 200000   (2 CPU × 100ms = 200ms of CPU per period)
```

**Throttle formula:**
```
throttle% = throttled_periods / total_periods × 100
```

**Why 2 CPU limit spikes p99 latency on a 0.1 CPU avg app:**

```mermaid
flowchart TD
    BG[Bursty request arrives] --> UQ[Uses full 2 CPU quota<br/>in first 10ms of period]
    UQ --> EQ[Quota exhausted<br/>for remaining 90ms]
    EQ --> WAIT[Thread stalled —<br/>kernel won't schedule]
    WAIT --> P99[p99 latency spike<br/>up to ~100ms added]
    P99 --> NP[Next 100ms period<br/>quota refilled]
```

The average CPU is low (0.1 CPU), but a single burst can consume the entire quota in a fraction of the 100ms window, stalling all threads until the next period refills the quota. This is why **CPU limits cause latency spikes even when average utilization is low**.

**How to inspect throttling:**
```bash
# Check throttle stats in a running container
kubectl exec <pod> -- cat \
  /sys/fs/cgroup/cpu/cpu.stat
# look for: throttled_time, nr_throttled

# Prometheus metric (requires cAdvisor)
container_cpu_cfs_throttled_periods_total
container_cpu_cfs_periods_total
```

---

## 3. Memory Eviction Hierarchy

```mermaid
flowchart TD
    USE[Container uses memory] --> CHK{Exceeds limit?}
    CHK -->|yes| OOM[OOMKilled<br/>container restarted]
    CHK -->|no| NODE{Node under<br/>memory pressure?}
    NODE -->|no| OK[Running normally]
    NODE -->|yes| EV1[Evict BestEffort<br/>pods first]
    EV1 --> EV2[Evict Burstable pods<br/>exceeding requests]
    EV2 --> EV3[Evict Guaranteed pods<br/>last resort]
    EV3 --> NE[Node eviction<br/>kubelet drains node]
```

**OOMKilled** = container-level, only that container restarts.  
**Node eviction** = pod-level, entire pod rescheduled elsewhere.

Eviction thresholds configured in kubelet:
```yaml
# kubelet config
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
evictionSoft:
  memory.available: "500Mi"
evictionSoftGracePeriod:
  memory.available: "30s"
```

---

## 4. QoS Classes

```mermaid
flowchart TD
    G[Guaranteed<br/>req == limit for all containers] -->|evicted last| EO
    B[Burstable<br/>at least one req set,<br/>req &lt; limit] -->|evicted second| EO
    BE[BestEffort<br/>no requests or limits set] -->|evicted first| EO[Eviction Order<br/>under pressure]

    style G fill:#2d6a2d,color:#fff
    style B fill:#7a5c00,color:#fff
    style BE fill:#7a1a1a,color:#fff
```

| QoS Class | Condition | OOM Score Adj | Eviction Priority |
|---|---|---|---|
| Guaranteed | `requests == limits` for every container | -998 (last to be killed) | Last |
| Burstable | Any `requests` set, `requests < limits` | 2–999 (proportional to usage) | Middle |
| BestEffort | No `requests` or `limits` set | 1000 (first to be killed) | First |

```yaml
# Guaranteed example
resources:
  requests:
    cpu: "500m"
    memory: "256Mi"
  limits:
    cpu: "500m"      # must equal request
    memory: "256Mi"  # must equal request
```

---

## 5. LimitRange — Namespace Defaults

LimitRange sets per-pod/container defaults and constraints within a namespace.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: my-app
spec:
  limits:
    - type: Container
      default:           # applied if limits not set
        cpu: "500m"
        memory: "256Mi"
      defaultRequest:    # applied if requests not set
        cpu: "100m"
        memory: "128Mi"
      max:               # hard ceiling per container
        cpu: "2"
        memory: "1Gi"
      min:               # floor per container
        cpu: "50m"
        memory: "64Mi"
    - type: Pod
      max:
        cpu: "4"
        memory: "2Gi"
    - type: PersistentVolumeClaim
      max:
        storage: "50Gi"
```

---

## 6. ResourceQuota — Namespace Caps

ResourceQuota sets aggregate limits across all resources in a namespace.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ns-quota
  namespace: my-app
spec:
  hard:
    # Compute
    requests.cpu: "10"
    requests.memory: "20Gi"
    limits.cpu: "20"
    limits.memory: "40Gi"
    # Object counts
    pods: "50"
    services: "20"
    persistentvolumeclaims: "10"
    secrets: "50"
    configmaps: "50"
    # Storage
    requests.storage: "100Gi"
    storageclass.storage.k8s.io/fast.requests.storage: "50Gi"
```

```bash
kubectl describe resourcequota ns-quota -n my-app
# shows: hard limit vs current usage
```

---

## 7. Vertical Pod Autoscaler (VPA)

VPA automatically adjusts `requests` (and optionally `limits`) based on historical usage.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"   # Off | Initial | Recreate | Auto
  resourcePolicy:
    containerPolicies:
      - containerName: myapp
        minAllowed:
          cpu: "100m"
          memory: "128Mi"
        maxAllowed:
          cpu: "4"
          memory: "4Gi"
        controlledResources: ["cpu", "memory"]
```

| Mode | Behaviour |
|---|---|
| `Off` | Recommendations only, no changes |
| `Initial` | Sets requests at pod creation, never updates live pods |
| `Recreate` | Evicts and recreates pods to apply new recommendations |
| `Auto` | Same as Recreate today; in-place update when K8s supports it |

**VPA + HPA conflict:** Don't use both targeting CPU/memory on the same deployment. Use VPA for right-sizing, HPA on custom metrics (RPS, queue depth).

---

## 8. Node Allocatable Chain

Not all node capacity is available to pods. The chain from raw capacity to schedulable capacity:

```
Node Capacity (total hardware)
  └─ kube-reserved  (CPU/memory reserved for kubelet, container runtime)
  └─ system-reserved (CPU/memory reserved for OS processes)
  └─ eviction-threshold (kubelet won't schedule here — kept as safety buffer)
  └─ Allocatable (what the scheduler sees — what your pod requests count against)
```

```mermaid
flowchart TD
    CAP["Node Capacity<br>e.g. 16 CPU, 64Gi RAM"] --> KR
    KR["- kube-reserved<br>e.g. 200m CPU, 1Gi RAM"] --> SR
    SR["- system-reserved<br>e.g. 200m CPU, 512Mi RAM"] --> ET
    ET["- eviction threshold<br>e.g. 200Mi RAM"] --> ALLOC
    ALLOC["= Allocatable<br>what scheduler uses for bin-packing<br>e.g. 15.6 CPU, 62.3Gi RAM"]
```

```bash
# Check allocatable vs capacity on a node
kubectl describe node <node> | grep -A6 "Capacity:" 
kubectl describe node <node> | grep -A6 "Allocatable:"

# Example output:
# Capacity:
#   cpu:                16
#   memory:             65536Mi
# Allocatable:
#   cpu:                15600m     ← 400m reserved
#   memory:             63897Mi    ← ~1.6Gi reserved

# Check how much is currently requested
kubectl describe node <node> | grep -A10 "Allocated resources"
# Requests    Limits
# cpu         8200m (52%)    16000m (100%)
# memory      24Gi (38%)     32Gi (50%)
```

**Why pods go Pending even when `kubectl top nodes` shows free capacity:**
`top` shows actual usage. Scheduler uses **requests** for bin-packing. A node can be 10% utilized but 100% requested → new pods pend.

```bash
# See real picture: requested vs allocatable
kubectl get nodes -o custom-columns=\
"NAME:.metadata.name,\
ALLOC-CPU:.status.allocatable.cpu,\
ALLOC-MEM:.status.allocatable.memory"
```

**Configure reserved resources (kubelet config):**
```yaml
# /var/lib/kubelet/config.yaml
kubeReserved:
  cpu: "200m"
  memory: "1Gi"
  ephemeral-storage: "1Gi"
systemReserved:
  cpu: "200m"
  memory: "512Mi"
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
```

---

## 9. Recommendations

```
✅ Always set requests — scheduler needs them for bin-packing
✅ Always set memory limits — prevents runaway containers OOMKilling neighbours
⚠️  Be careful with CPU limits — causes throttling even at low avg usage
✅ Prefer no CPU limit for latency-sensitive services (set request only)
✅ Match Guaranteed QoS for critical workloads (requests == limits)
✅ Use LimitRange to enforce defaults so new pods aren't BestEffort by accident
✅ Monitor container_cpu_cfs_throttled_periods_total in Prometheus
✅ Use VPA in Off mode first — check recommendations before enabling Auto
```

**Safe pattern for latency-sensitive service:**
```yaml
resources:
  requests:
    cpu: "500m"      # guaranteed reservation
    memory: "512Mi"
  limits:
    # no cpu limit — avoids CFS throttling
    memory: "512Mi"  # must have memory limit
```

**Safe pattern for batch / background job:**
```yaml
resources:
  requests:
    cpu: "100m"
    memory: "256Mi"
  limits:
    cpu: "2"         # OK to throttle batch jobs
    memory: "512Mi"
```
