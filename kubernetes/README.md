# Kubernetes Architecture & Internals

| File | Topics |
|------|--------|
| [README.md](./README.md) | Architecture, kubectl apply flow, scheduler, taints/affinity |
| [networking.md](./networking.md) | Services, ClusterIP internals, DNS, Ingress, NetworkPolicy |
| [workloads.md](./workloads.md) | Pod lifecycle, probes, QoS, rolling updates, StatefulSet, DaemonSet, Jobs |
| [storage.md](./storage.md) | PV/PVC/StorageClass, dynamic provisioning, CSI, volume snapshots |
| [autoscaling.md](./autoscaling.md) | HPA, VPA, KEDA, Cluster Autoscaler |
| [rbac.md](./rbac.md) | ServiceAccount, Role/ClusterRole, RoleBinding, auth chain |
| [eks-architecture.md](./eks-architecture.md) | EKS managed control plane, VPC CNI, IRSA, node groups |
| [resource-limits.md](./resource-limits.md) | Requests vs limits, CFS throttling, QoS classes, LimitRange, ResourceQuota, node allocatable chain |
| [coredns.md](./coredns.md) | Corefile plugins, ndots:5 problem, forwarding, caching, debugging, NodeLocal DNSCache |
| [pod-lifecycle.md](./pod-lifecycle.md) | Startup sequence (sandbox→CNI→image→probes), admission controller chain, server-side apply, termination race |
| [kube-proxy-modes.md](./kube-proxy-modes.md) | iptables O(n) problem, IPVS O(1) + LB algorithms, Cilium/eBPF socket-level LB, comparison table |
| [cross-node-networking.md](./cross-node-networking.md) | Same-node packet walk, VXLAN overlay, Calico BGP direct routing, AWS VPC CNI flat network, MTU |
| [node-shutdown.md](./node-shutdown.md) | Graceful shutdown (systemd inhibitor), pod eviction ordering, node drain, non-graceful shutdown, lifecycle taints |

---

## Architecture

Kubernetes has two logical planes: the **Control Plane** (the brain — decides what should happen) and the **Data Plane / Worker Nodes** (the muscle — makes it happen).

```mermaid
graph TD
    classDef cp fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef etcd fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef node fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef pod fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef client fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph ControlPlane["Control Plane"]
        KUBECTL["kubectl / CI / API Clients"]:::client -->|HTTPS REST| APISERVER
        APISERVER["API Server (kube-apiserver)"]:::cp <-->|read/write cluster state| ETCD[("etcd: distributed KV, source of truth")]:::etcd
        APISERVER -->|watches for unscheduled pods| SCHEDULER["Scheduler (kube-scheduler)"]:::cp
        APISERVER -->|watches resource objects| CM["Controller Manager (kube-controller-manager)"]:::cp
        APISERVER -->|cloud-specific reconciliation| CCM["Cloud Controller Manager"]:::cp
    end

    subgraph NodeA["Node A"]
        KUBELET_A["kubelet"]:::node -->|CRI gRPC| CRI_A["Container Runtime (containerd/CRI-O)"]:::node
        KUBELET_A -->|CNI plugin call| CNI_A["CNI Plugin (flannel/calico/cilium)"]:::node
        KUBELET_A -->|CSI plugin call| CSI_A["CSI Driver (ebs/nfs/ceph)"]:::node
        KPROXY_A["kube-proxy (iptables/IPVS rules)"]:::node
        CRI_A --> POD_A1["Pod: app-1"]:::pod
        CRI_A --> POD_A2["Pod: app-2"]:::pod
    end

    subgraph NodeB["Node B"]
        KUBELET_B["kubelet"]:::node -->|CRI gRPC| CRI_B["Container Runtime"]:::node
        CRI_B --> POD_B1["Pod: app-3"]:::pod
        KPROXY_B["kube-proxy"]:::node
    end

    APISERVER -->|assigned pod spec| KUBELET_A
    APISERVER -->|assigned pod spec| KUBELET_B
    APISERVER -->|service/endpoint updates| KPROXY_A
    APISERVER -->|service/endpoint updates| KPROXY_B
```

**Control Plane components and what they do:**

| Component | Role |
|-----------|------|
| **API Server** | Only component that reads/writes etcd. Every other component communicates through it. Runs AuthN → AuthZ → Admission → Validation on every request. |
| **etcd** | Raft-based distributed KV store. Stores all cluster state: nodes, pods, secrets, RBAC, endpoint slices. Keys are at `/registry/<type>/<namespace>/<name>`. |
| **Scheduler** | Watches for pods with `nodeName=""`. Runs Filter → Score → Bind. Writes `spec.nodeName` back to the pod via API Server. |
| **Controller Manager** | 50+ reconciliation loops in one binary. Deployment controller, ReplicaSet controller, Node controller, Job controller, EndpointSlice controller. |
| **Cloud Controller Manager** | Cloud-specific logic decoupled from core K8s. Provisions cloud LBs for `LoadBalancer` services, manages VPC routes for pod CIDRs. |

**Node components and what they do:**

| Component | Role |
|-----------|------|
| **kubelet** | Agent on every node. Watches pods assigned to this node. Calls CRI/CNI/CSI, runs probes, reports status back to API Server. |
| **kube-proxy** | Programs iptables/IPVS rules for Service ClusterIP routing. Does NOT proxy traffic itself — only sets up kernel NAT rules. |
| **Container Runtime (CRI)** | `containerd` or `CRI-O`. Pulls images, creates containers via `runc`, manages cgroups and namespaces. |
| **CNI Plugin** | Called by kubelet on pod creation. Sets up veth pair, assigns pod IP, configures routes. |
| **CSI Driver** | Called by kubelet to attach/mount persistent volumes into pod filesystem. |

---

## `kubectl apply -f deployment.yaml` — End-to-End Flow

What actually happens when you run this command? Here is every step, every component:

```mermaid
sequenceDiagram
    participant K as kubectl
    participant API as API Server
    participant E as etcd
    participant DC as Deployment Controller
    participant RC as ReplicaSet Controller
    participant S as Scheduler
    participant KL as kubelet (Node)
    participant CR as Container Runtime

    K->>API: 1. PATCH deployment/my-app (server-side apply)
    API->>API: 2. AuthN, AuthZ (RBAC), Admission Controllers
    API->>E: 3. Write Deployment object to etcd
    API-->>K: 200 OK

    Note over DC: Controller Manager watches Deployment objects
    DC->>API: 4. Watch event: Deployment created/updated
    DC->>API: 5. Create or update ReplicaSet (hash of pod template)
    API->>E: 6. Write ReplicaSet to etcd

    Note over RC: ReplicaSet controller watches ReplicaSet objects
    RC->>API: 7. Watch event: ReplicaSet needs 3 pods, 0 exist
    RC->>API: 8. Create 3 Pod objects with nodeName empty
    API->>E: 9. Write 3 Pod objects to etcd

    Note over S: Scheduler watches Pods with nodeName=""
    S->>API: 10. Watch event: unscheduled pod detected
    S->>S: 11. Run Filter phase - eliminate infeasible nodes
    S->>S: 12. Run Score phase - rank remaining nodes
    S->>API: 13. Bind: write pod.spec.nodeName = node-2
    API->>E: 14. Update Pod object with nodeName

    Note over KL: kubelet on node-2 watches its assigned pods
    KL->>API: 15. Watch event: pod assigned to this node
    KL->>CR: 16. CRI: PullImage
    CR-->>KL: Image pulled
    KL->>CR: 17. CRI: CreateContainer + StartContainer
    CR->>CR: 18. runc: create namespaces, cgroups, rootfs
    CR-->>KL: Container running
    KL->>API: 19. PATCH pod status: phase=Running, ready=false
    KL->>KL: 20. Run readiness probe (HTTP GET /readyz)
    KL->>API: 21. PATCH pod status: ready=true
    Note over API,E: EndpointSlice controller adds pod IP to Service endpoints
```

Key insights:
- `kubectl apply` uses **server-side apply** — the server tracks field ownership per manager, enabling safe multi-actor management
- Deployment controller never creates Pods directly — it creates ReplicaSets. ReplicaSet controller creates Pods. This is why rollback works: just point the Deployment at an older ReplicaSet
- Scheduler only writes `spec.nodeName` — it does not start containers. kubelet is the one that actually runs the container
- **Nothing communicates directly** — every component watches the API Server and reacts to state changes. This is the level-triggered reconciliation model

---

## Scheduler Internals

The scheduler's job: given an unscheduled pod, find the best node. It runs a **two-phase pipeline** implemented as a plugin framework.

```mermaid
graph TD
    WATCH["Scheduler watches for pods with nodeName empty"] --> QUEUE["Priority Queue: pods sorted by priority class"]
    QUEUE --> FILTER

    subgraph FilterPhase["Phase 1: Filter - eliminate infeasible nodes"]
        FILTER["NodeUnschedulable: reject cordoned nodes"] --> FILTER2["NodeResourcesFit: pod requests fit node free capacity"]
        FILTER2 --> FILTER3["TaintToleration: pod tolerates all node taints"]
        FILTER3 --> FILTER4["NodeAffinity: required rules match node labels"]
        FILTER4 --> FILTER5["PodTopologySpread: topologySpreadConstraints satisfied"]
        FILTER5 --> FILTER6["PodAntiAffinity: no hard anti-affinity violations"]
        FILTER6 --> FEASIBLE["Feasible Nodes"]
    end

    FEASIBLE --> SCORE

    subgraph ScorePhase["Phase 2: Score - rank feasible nodes 0-100"]
        SCORE["LeastRequestedPriority: more free capacity = higher score"] --> SCORE2["BalancedResourceAllocation: penalize CPU/memory imbalance"]
        SCORE2 --> SCORE3["ImageLocality: bonus if image already cached on node"]
        SCORE3 --> SCORE4["NodeAffinity preferred: weighted bonus for preferred labels"]
        SCORE4 --> SCORE5["InterPodAffinity: bonus for co-locating with preferred pods"]
        SCORE5 --> WINNER["Highest score wins"]
    end

    WINNER --> BIND["Scheduler writes pod.spec.nodeName via API Server"]
```

### Filter Phase (Predicates)

| Plugin | What it checks |
|--------|---------------|
| `NodeUnschedulable` | Rejects nodes with `spec.unschedulable: true` (cordoned nodes) |
| `NodeResourcesFit` | Pod `requests` must fit: `node.allocatable - Σ(running pod requests) ≥ pod requests` |
| `TaintToleration` | Every `NoSchedule`/`NoExecute` taint on the node must have a matching toleration in the pod |
| `NodeAffinity` | `requiredDuringSchedulingIgnoredDuringExecution` rules must match node labels |
| `PodTopologySpread` | Enforces `topologySpreadConstraints` with `whenUnsatisfiable: DoNotSchedule` |
| `PodAntiAffinity` | Rejects nodes that violate hard (`required`) pod anti-affinity rules |
| `VolumeBinding` | Node must have access to all volumes the pod requests (zone matching for PVs) |

After filtering, if zero nodes remain → pod goes `Pending`. Events will show `FailedScheduling`.

### Score Phase (Priorities)

Each remaining node gets a score 0–100 from each plugin. Final score = weighted sum.

**LeastRequestedPriority** (most important for bin-packing vs spreading):

```
cpuScore  = (node.allocatable.cpu - Σ requests.cpu) / node.allocatable.cpu * 100
memScore  = (node.allocatable.mem - Σ requests.mem) / node.allocatable.mem * 100
nodeScore = (cpuScore + memScore) / 2
```

A node with MORE free resources scores HIGHER. This spreads pods across nodes.

**BalancedResourceAllocation**: penalizes nodes where CPU and memory utilization are imbalanced (e.g., 90% CPU but 10% memory used). Encourages balanced consumption.

**ImageLocality**: adds a small bonus if the container image is already cached on the node, reducing pull latency.

---

## Scheduler Worked Example

**Setup:**
- Node Alpha: 4 CPU allocatable, 8 GB allocatable. Currently running pods consuming 1 CPU, 2 GB.
- Node Beta: 8 CPU allocatable, 16 GB allocatable. Currently running pods consuming 1 CPU, 2 GB.
- New pod: `requests: {cpu: "1", memory: "4Gi"}`, `limits: {cpu: "2", memory: "6Gi"}`

> **Important:** The scheduler uses `requests` for placement decisions, not `limits`. Limits are enforced by the kernel (cgroups) at runtime, not by the scheduler.

### Filter Phase

| Check | Node Alpha | Node Beta |
|-------|-----------|----------|
| NodeResourcesFit (CPU) | Free: 4-1=3 CPU. Need: 1. ✅ | Free: 8-1=7 CPU. Need: 1. ✅ |
| NodeResourcesFit (Memory) | Free: 8-2=6 GB. Need: 4 GB. ✅ | Free: 16-2=14 GB. Need: 4 GB. ✅ |

Both nodes pass. Proceed to scoring.

### Score Phase — LeastRequestedPriority

**Node Alpha:**
```
cpuFraction  = (4 - 1 - 1) / 4   = 2/4   = 0.50
memFraction  = (8 - 2 - 4) / 8   = 2/8   = 0.25
score        = (0.50 + 0.25) / 2 * 100 = 37.5
```

**Node Beta:**
```
cpuFraction  = (8 - 1 - 1) / 8   = 6/8   = 0.75
memFraction  = (16 - 2 - 4) / 16 = 10/16 = 0.625
score        = (0.75 + 0.625) / 2 * 100 = 68.75
```

**Winner: Node Beta** with score ~68.75 vs Alpha's ~37.5.

### Q&A: Why does Node Beta win even though the pod fits on both?

**Q:** We have Node Alpha (4 CPU / 8 GB) and Node Beta (8 CPU / 16 GB). Our pod requests 1 CPU and 4 GB memory (limits: 2 CPU / 6 GB). Both nodes have enough room. Which node does the scheduler pick?

**A:** The scheduler picks **Node Beta**, and here's the exact reasoning:

The `LeastRequestedPriority` plugin scores nodes by how much free capacity they'd have *after* placing the pod. More free capacity = higher score. This **spreads** pods across nodes rather than packing them — leaving headroom for spikes, avoiding noisy-neighbor effects, and preserving rolling-update capacity.

Node Alpha after placement: 2/4 CPU used (50%), 6/8 GB used (75%). Low remaining fraction → low score (~37.5).
Node Beta after placement: 2/8 CPU used (25%), 6/16 GB used (37.5%). High remaining fraction → high score (~68.75).

**Critical detail about limits:** The `limits` (2 CPU / 6 GB) are irrelevant to scheduling. They are enforced by cgroups at runtime — if the container tries to use more than 2 CPU it gets throttled; if it exceeds 6 GB memory the kernel OOM-kills it. The scheduler only cares about `requests` because that is the reserved capacity on the node.

If you need the pod to land on Node Alpha instead, use `nodeSelector`, `nodeAffinity`, or a `PodTopologySpread` constraint with `maxSkew`.

---

## etcd — The Brain's Memory

Everything in Kubernetes is stored in etcd. The API server is the only component that reads/writes etcd directly. Every other component (scheduler, controller manager, kubelet) talks to the API server — never etcd directly.

```mermaid
graph TD
    subgraph "What etcd stores"
        PODS["All Pod specs and status"]
        NODES["Node objects and conditions"]
        SECRETS["Secrets and ConfigMaps"]
        RBAC["RBAC Roles and Bindings"]
        LEASES["Leader election Leases<br>(scheduler, controller-manager)"]
        EVENTS["Kubernetes Events"]
        CRD["Custom Resource instances"]
    end
    API["API Server<br>(ONLY component with etcd access)"] --> etcd[("etcd cluster<br>Raft consensus")]
    etcd --> PODS & NODES & SECRETS & RBAC & LEASES & EVENTS & CRD
```

### What Happens When etcd is Slow

```mermaid
graph LR
    SLOW["etcd WAL fsync slow<br>(disk I/O bottleneck)"] --> TIMEOUT
    TIMEOUT["API server requests timeout<br>deadline exceeded errors"] --> KUBELET
    KUBELET["kubelet can't update pod status<br>pods appear stuck in Terminating"] --> SCHED
    SCHED["Scheduler can't read nodes<br>pods stuck Pending"] --> CHAOS["Cluster appears broken<br>but workloads still running!"]
    NOTE["Running pods keep running<br>kubelet operates independently<br>Only control plane is affected"]
```

**Key insight:** Running workloads continue even when etcd is down. The cluster can't be changed (no new pods, no reschedules), but existing pods keep running.

### etcd Capacity — What Fills It Up

```bash
# Check etcd DB size
etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
  --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
  endpoint status --write-out=table
# ENDPOINT    ID    VERSION  DB SIZE  IS LEADER  RAFT TERM  RAFT INDEX

# Default quota: 2GB. If exceeded → etcd goes read-only → cluster broken
# Increase quota in kube-apiserver:
# --etcd-args="--quota-backend-bytes=8589934592"  # 8GB

# What fills etcd:
# 1. Old revisions (every write creates a new revision)
# 2. Events (high-frequency cluster = thousands of events/minute)
# 3. Large Secrets/ConfigMaps
# 4. Many CRD instances

# Compact old revisions (frees space within DB file)
etcdctl compact $(etcdctl endpoint status --write-out=json | jq '.[0].Status.header.revision')

# Defragment (actually shrinks the file on disk)
etcdctl defrag --endpoints=https://127.0.0.1:2379

# Run compaction + defrag as a CronJob (weekly)
```

### etcd Backup and Restore

```bash
# Snapshot (backup)
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify snapshot
etcdctl snapshot status /backup/etcd-2024-01-15.db
# Hash: abc123  Revision: 12345  Total Keys: 1567  Total Size: 4.2 MB

# Restore (stop all control plane components first)
etcdctl snapshot restore /backup/etcd-2024-01-15.db \
  --data-dir /var/lib/etcd-restored \
  --name master-1 \
  --initial-cluster master-1=https://10.0.0.1:2380 \
  --initial-cluster-token cluster-token-1 \
  --initial-advertise-peer-urls https://10.0.0.1:2380
# Then update etcd manifest to point to /var/lib/etcd-restored
```

### etcd HA — Raft Quorum

etcd uses Raft consensus. A cluster needs a **majority** (quorum) of nodes available to function:

| Cluster size | Quorum | Tolerated failures |
|-------------|--------|-------------------|
| 1 | 1 | 0 |
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

**Always run 3 or 5 etcd nodes in production.** Odd numbers minimize wasted fault tolerance. 4 nodes tolerate only 1 failure (same as 3) but has higher write latency.

---

## Taints, Tolerations & Node Affinity

These three mechanisms control which pods can/prefer to run on which nodes.

### Taints (node-side repellent)

A **taint** on a node says: "Don't schedule pods here unless the pod explicitly tolerates this."

| Effect | Meaning |
|--------|---------|
| `NoSchedule` | New pods without a matching toleration will NOT be scheduled here. Existing pods stay. |
| `PreferNoSchedule` | Scheduler tries to avoid placing pods here, but will if no other node fits. |
| `NoExecute` | New pods rejected AND existing pods without toleration are evicted (after optional `tolerationSeconds`). |

```bash
kubectl taint nodes gpu-node-1 hardware=gpu:NoSchedule
kubectl taint nodes gpu-node-1 hardware=gpu:NoSchedule-   # remove taint
```

### Tolerations (pod-side permission slip)

A **toleration** says: "I can tolerate this taint — don't block me because of it." It removes the barrier but does NOT attract the pod to that node.

```yaml
spec:
  tolerations:
    - key: "hardware"
      operator: "Equal"
      value: "gpu"
      effect: "NoSchedule"
```

### nodeSelector (simplest node targeting)

`nodeSelector` is the original, simple way to constrain a pod to nodes with specific labels. It's a hard requirement — no match, no schedule.

```yaml
spec:
  nodeSelector:
    hardware: gpu          # pod only schedules on nodes with this exact label
    zone: us-east-1a       # AND this label (all keys must match)
```

```bash
kubectl label node gpu-node-1 hardware=gpu zone=us-east-1a
```

**Limitation:** AND-only logic, no OR, no `NotIn`, no expressions. That's why `nodeAffinity` exists.

---

### Node Affinity (pod-side attraction)

`nodeAffinity` is `nodeSelector` with full expression power. Two modes:

| Mode | Keyword | Behavior |
|------|---------|----------|
| **Hard** | `requiredDuringSchedulingIgnoredDuringExecution` | Pod won't schedule if no node matches. Like `nodeSelector` but with expressions. |
| **Soft** | `preferredDuringSchedulingIgnoredDuringExecution` | Scheduler *tries* to match, places elsewhere if needed. Uses a weight (1–100). |

`IgnoredDuringExecution` — if the node's labels change after the pod is running, the pod is **not** evicted.

#### Hard affinity (must match)

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: hardware
          operator: In          # In | NotIn | Exists | DoesNotExist | Gt | Lt
          values: ["gpu", "gpu-high"]
        - key: zone
          operator: In
          values: ["us-east-1a", "us-east-1b"]
```

Multiple `matchExpressions` in the same term = AND. Multiple `nodeSelectorTerms` = OR (any term can match).

#### Soft affinity (prefer, but not required)

```yaml
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 80              # higher weight = stronger preference (1-100)
      preference:
        matchExpressions:
        - key: zone
          operator: In
          values: ["us-east-1a"]   # prefer AZ-a
    - weight: 20
      preference:
        matchExpressions:
        - key: hardware
          operator: In
          values: ["ssd"]          # also prefer SSD nodes, but less important
```

The scheduler adds the weights of matching preferences to a node's score. The highest-scoring node wins — but any node can still be chosen if none match.

#### Combining hard + soft

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:   # MUST be on gpu nodes
      nodeSelectorTerms:
      - matchExpressions:
        - key: hardware
          operator: In
          values: ["gpu"]
    preferredDuringSchedulingIgnoredDuringExecution:  # PREFER AZ-a within gpu nodes
    - weight: 100
      preference:
        matchExpressions:
        - key: topology.kubernetes.io/zone
          operator: In
          values: ["us-east-1a"]
```

---

### nodeSelector vs nodeAffinity

| | `nodeSelector` | `nodeAffinity` |
|--|---------------|---------------|
| **Logic** | AND only, exact match | AND / OR, full expressions |
| **Operators** | `=` only | `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt` |
| **Soft preference** | No | Yes (`preferred...`) |
| **Multiple terms (OR)** | No | Yes (multiple `nodeSelectorTerms`) |
| **Future-proof** | Being deprecated eventually | Recommended |

Use `nodeSelector` only for simple single-label targeting. Use `nodeAffinity` for everything else.

---

### DaemonSet: run on all nodes despite taints

There is **no global taint**. Taints are per-node. If you have multiple node groups each with different taints, the DaemonSet needs a toleration for each — or use the wildcard:

```yaml
spec:
  tolerations:
  - operator: "Exists"    # matches ALL keys, values, and effects — tolerate everything
```

This is what system DaemonSets (kube-proxy, CNI, node-exporter) use to guarantee they run on every node.

**Note on `NoExecute`:** The wildcard also tolerates `NoExecute` without a `tolerationSeconds`, so the pod is never evicted. Fine for infrastructure DaemonSets, but be intentional about it.

### DaemonSet: exclude specific nodes

Since DaemonSets target all nodes by default, exclusion is done by **not scheduling**, not by taint:

```yaml
# Option 1: opt-in label — only schedule on nodes that have the label
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: daemonset/my-agent
                operator: Exists   # label must exist (any value)
```

```bash
# Only label the nodes you want the DaemonSet on
kubectl label node node-1 node-2 daemonset/my-agent=enabled
# node-3 has no label → DaemonSet pod never scheduled there
```

```yaml
# Option 2: add a dedicated taint to nodes to exclude, don't tolerate it
# (don't add this taint to the DaemonSet tolerations)
kubectl taint node node-3 skip-my-agent=true:NoSchedule
```

---

---

## Pod Affinity & Pod Anti-Affinity

While `nodeAffinity` attracts/repels pods to/from **nodes**, `podAffinity` and `podAntiAffinity` attract/repel pods relative to **other pods** — based on what's already running on a node (or in a topology zone).

The scheduler checks the labels of **existing pods** on nodes to decide placement.

### podAffinity — co-locate with other pods

**Use case:** Place a caching sidecar or a latency-sensitive service on the same node as the pods it serves.

```yaml
affinity:
  podAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:   # hard
    - labelSelector:
        matchExpressions:
        - key: app
          operator: In
          values: ["redis"]
      topologyKey: "kubernetes.io/hostname"   # "same node"
```

`topologyKey` defines what "together" means:
| `topologyKey` | Meaning |
|--------------|---------|
| `kubernetes.io/hostname` | Same node |
| `topology.kubernetes.io/zone` | Same AZ |
| `topology.kubernetes.io/region` | Same region |

### podAntiAffinity — spread away from other pods

**Use case:** Ensure replicas of the same app land on different nodes (or AZs) for HA.

#### Hard anti-affinity (guaranteed spread)

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchExpressions:
        - key: app
          operator: In
          values: ["api-server"]
      topologyKey: "kubernetes.io/hostname"   # no two api-server pods on same node
```

Pod stays **Pending** if the only available nodes already have a matching pod. Use with caution on small clusters.

#### Soft anti-affinity (prefer spread, allow stacking if necessary)

```yaml
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values: ["api-server"]
        topologyKey: "topology.kubernetes.io/zone"   # prefer different AZs
```

If no other AZ is available, pods still schedule — no Pending.

### Hard vs Soft summary

| | Hard (`required...`) | Soft (`preferred...`) |
|--|---------------------|----------------------|
| **Affinity** | Must co-locate, else Pending | Prefer co-location, not required |
| **AntiAffinity** | Must spread, else Pending | Prefer spread, stacking allowed |
| **Risk** | Pods stuck Pending if unsatisfiable | Safe fallback |
| **Use for** | Security isolation, strict HA | Best-effort AZ spread, latency opt |

### Common patterns

```yaml
# Pattern 1: spread replicas across nodes (hard) — HA guarantee
podAntiAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
  - labelSelector:
      matchLabels:
        app: my-service
    topologyKey: "kubernetes.io/hostname"

# Pattern 2: prefer different AZs (soft) — safe for small clusters
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
  - weight: 100
    podAffinityTerm:
      labelSelector:
        matchLabels:
          app: my-service
      topologyKey: "topology.kubernetes.io/zone"

# Pattern 3: co-locate app with its cache (hard)
podAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
  - labelSelector:
      matchLabels:
        app: redis-cache
    topologyKey: "kubernetes.io/hostname"
```

### Real-world Examples

#### Example 1 — `nodeSelector`: run only on SSD nodes

```yaml
# kubectl label node node-1 node-2 disk=ssd
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      nodeSelector:
        disk: ssd
      containers:
      - name: postgres
        image: postgres:16
```

#### Example 2 — `nodeAffinity` hard: restrict to specific AZs

```yaml
# Scenario: data residency — must stay in us-east-1a or us-east-1b
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: topology.kubernetes.io/zone
            operator: In
            values: [us-east-1a, us-east-1b]
  containers:
  - name: api
    image: my-org/api:v2
```

#### Example 3 — `nodeAffinity` soft: prefer spot, fall back to on-demand

```yaml
# kubectl label node spot-node-{1..5} node-lifecycle=spot
# kubectl label node od-node-{1..3}   node-lifecycle=on-demand
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 80
        preference:
          matchExpressions:
          - key: node-lifecycle
            operator: In
            values: [spot]
      - weight: 20
        preference:
          matchExpressions:
          - key: node-lifecycle
            operator: In
            values: [on-demand]
  containers:
  - name: worker
    image: my-org/worker:v1
```

#### Example 4 — `podAntiAffinity` hard: one replica per node

```yaml
# Scenario: 3 replicas, guaranteed on different nodes
# ⚠️ Needs at least 3 nodes — 4th replica goes Pending if only 3 exist
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: api-server
            topologyKey: kubernetes.io/hostname
      containers:
      - name: api
        image: my-org/api:v2
        ports:
        - containerPort: 8080
```

#### Example 5 — `podAntiAffinity` soft: prefer different AZs

```yaml
# Scenario: 6 replicas, prefer spread across AZs but don't block
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: payment-service
              topologyKey: topology.kubernetes.io/zone
      containers:
      - name: payment
        image: my-org/payment:v3
```

#### Example 6 — `podAffinity` hard: co-locate app with its local cache

```yaml
# Scenario: app must land on same node as redis-cache DaemonSet pod
apiVersion: apps/v1
kind: Deployment
metadata:
  name: realtime-processor
spec:
  replicas: 3
  selector:
    matchLabels:
      app: realtime-processor
  template:
    metadata:
      labels:
        app: realtime-processor
    spec:
      affinity:
        podAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: redis-cache
            topologyKey: kubernetes.io/hostname
      containers:
      - name: processor
        image: my-org/processor:v1
```

#### Example 7 — DaemonSet on ALL nodes (multiple tainted node groups)

```yaml
# Scenario: Fluentd must run everywhere
# Node groups: team=gpu:NoSchedule, team=spot:NoSchedule, dedicated=infra:NoSchedule
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentd
spec:
  selector:
    matchLabels:
      app: fluentd
  template:
    metadata:
      labels:
        app: fluentd
    spec:
      tolerations:
      - operator: Exists        # tolerate ALL taints on ALL nodes
      containers:
      - name: fluentd
        image: fluent/fluentd-kubernetes-daemonset:v1
        volumeMounts:
        - name: varlog
          mountPath: /var/log
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
```

#### Example 8 — DaemonSet on SOME nodes (opt-in label)

```yaml
# Scenario: GPU metrics exporter — only on gpu nodes
# kubectl label node gpu-node-{1..3} collect-gpu-metrics=true
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gpu-metrics-exporter
spec:
  selector:
    matchLabels:
      app: gpu-metrics-exporter
  template:
    metadata:
      labels:
        app: gpu-metrics-exporter
    spec:
      tolerations:
      - key: hardware
        operator: Equal
        value: gpu
        effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: collect-gpu-metrics
                operator: Exists
      containers:
      - name: exporter
        image: nvidia/dcgm-exporter:3.1.7
```

#### Example 9 — everything combined: ML training job

```yaml
# Must: land on gpu nodes (hard nodeAffinity + toleration)
# Prefer: AZ-a for cheaper inter-node bandwidth (soft nodeAffinity)
# Must: no two training pods on same node (hard podAntiAffinity)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ml-training
spec:
  replicas: 4
  selector:
    matchLabels:
      app: ml-training
  template:
    metadata:
      labels:
        app: ml-training
    spec:
      tolerations:
      - key: hardware
        operator: Equal
        value: gpu
        effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: hardware
                operator: In
                values: [gpu]
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 60
            preference:
              matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: [us-east-1a]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: ml-training
            topologyKey: kubernetes.io/hostname
      containers:
      - name: trainer
        image: my-org/ml-trainer:v2
        resources:
          limits:
            nvidia.com/gpu: "1"
            memory: 16Gi
```

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8

    POD["Pod to schedule"]:::blue

    NODE["Node"]:::green
    TAINT["Taint on node<br/>NoSchedule / NoExecute"]:::red
    NODELABEL["Node labels"]:::orange

    OTHERPOD["Other pods on node"]:::teal

    TAINT -->|"blocked unless pod has matching Toleration"| POD
    NODELABEL -->|"nodeSelector: exact match"| POD
    NODELABEL -->|"nodeAffinity required: hard rule"| POD
    NODELABEL -->|"nodeAffinity preferred: soft score"| POD
    OTHERPOD -->|"podAffinity: attract to nodes with these pods"| POD
    OTHERPOD -->|"podAntiAffinity required: repel hard"| POD
    OTHERPOD -->|"podAntiAffinity preferred: repel soft"| POD
```

## GPU Node Group Scenario

**Objective:** `cpu-pool` nodes for general workloads, `gpu-pool` nodes for ML training only. ML pods must land only on GPU nodes; GPU nodes must not run regular workloads.

**Strategy:** Taint GPU nodes + add toleration to ML pod + add required node affinity to ML pod. All three are needed:
- Taint alone → blocks regular pods from GPU nodes ✅ but ML pod still might land on CPU nodes
- Toleration alone → removes the barrier but doesn't attract ✅
- Node affinity → actively forces ML pod onto GPU nodes ✅

**Step 1: Label and taint GPU nodes**

```bash
kubectl label nodes gpu-node-1 gpu-node-2 hardware=gpu
kubectl taint nodes gpu-node-1 gpu-node-2 hardware=gpu:NoSchedule
```

**Step 2: ML pod spec**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ml-training
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ml-training
  template:
    metadata:
      labels:
        app: ml-training
    spec:
      tolerations:
        - key: "hardware"
          operator: "Equal"
          value: "gpu"
          effect: "NoSchedule"
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: hardware
                    operator: In
                    values:
                      - gpu
      containers:
        - name: trainer
          image: my-org/ml-trainer:v1
          resources:
            limits:
              nvidia.com/gpu: 1
              memory: "16Gi"
              cpu: "4"
            requests:
              nvidia.com/gpu: 1
              memory: "16Gi"
              cpu: "4"
```

```mermaid
graph TD
    subgraph CpuPool["cpu-pool nodes"]
        CPU1["cpu-node-1: no taint, label hardware=cpu"]
        CPU2["cpu-node-2: no taint"]
    end

    subgraph GpuPool["gpu-pool nodes"]
        GPU1["gpu-node-1: taint hardware=gpu:NoSchedule, label hardware=gpu"]
        GPU2["gpu-node-2: taint hardware=gpu:NoSchedule, label hardware=gpu"]
    end

    REG["Regular Pod: no toleration, no affinity"] --> CPU1
    REG --> CPU2
    REG -->|"TaintToleration filter: BLOCKED"| GPU1

    ML["ML Training Pod: toleration=gpu, affinity required hardware=gpu"] -->|"NodeAffinity filter: BLOCKED on cpu nodes"| XCPU["cpu-pool rejected"]
    ML -->|"Toleration passes, Affinity matches"| GPU1
    ML --> GPU2
```
