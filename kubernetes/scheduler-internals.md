# Kubernetes Scheduler — Deep Internals

## How the Scheduler Works

The scheduler has one job: assign a `nodeName` to a Pod that has none. It runs a two-phase algorithm for every unscheduled pod.

```mermaid
flowchart TD
    WATCH["Scheduler watches API Server<br>for pods with nodeName=''"] --> QUEUE
    QUEUE["Priority Queue<br>(sorted by PriorityClass)"] --> FILTER
    FILTER["Phase 1: Filter (Predicates)<br>eliminate nodes that CANNOT run the pod"] --> SCORE
    SCORE["Phase 2: Score (Priorities)<br>rank remaining nodes 0-100"] --> BEST
    BEST["Select highest-scoring node<br>(tie-break: random)"] --> BIND
    BIND["Bind: write nodeName to pod<br>via API Server"] --> KUBELET
    KUBELET["kubelet on that node<br>watches for its pods, starts container"]
```

---

## Phase 1: Filter Plugins

Every filter plugin runs for every node. A node is eliminated if **any** filter returns false.

```mermaid
graph LR
    NODE["Candidate Node"] --> F1["NodeUnschedulable<br>cordon check"]
    F1 --> F2["NodeResourcesFit<br>enough CPU/mem?"]
    F2 --> F3["NodeAffinity<br>nodeSelector / affinity rules"]
    F3 --> F4["TaintToleration<br>pod tolerates node taints?"]
    F4 --> F5["PodTopologySpread<br>spread constraints"]
    F5 --> F6["VolumeBinding<br>PVC can be bound here?"]
    F6 --> PASS["Node passes --> enters Score phase"]
    F1 & F2 & F3 & F4 & F5 & F6 -->|"any fail"| REJECT["Node eliminated"]
```

Key filter plugins:

| Plugin | What it checks |
|--------|---------------|
| `NodeResourcesFit` | Node has enough `Allocatable - requested` CPU/memory |
| `NodeAffinity` | Pod's `nodeSelector` and `affinity.nodeAffinity` match node labels |
| `TaintToleration` | Pod's `tolerations` cover all node `taints` with `NoSchedule`/`NoExecute` |
| `PodTopologySpread` | `topologySpreadConstraints` — spread pods across zones/nodes |
| `VolumeBinding` | PVC's storageClass zone matches node's zone |
| `NodeUnschedulable` | Node is not cordoned |

---

## Phase 2: Score Plugins

Remaining nodes are scored 0-100 by each plugin. Final score = weighted sum.

```mermaid
graph LR
    NODES["Filtered nodes<br>[node-1, node-2, node-3]"] --> S1["LeastAllocated<br>prefer node with most free CPU/mem"]
    S1 --> S2["NodeAffinity<br>preferred rules add score"]
    S2 --> S3["InterPodAffinity<br>co-locate with preferred pods"]
    S3 --> S4["ImageLocality<br>node already has the image? +score"]
    S4 --> FINAL["Final scores:<br>node-1: 72<br>node-2: 85 ← winner<br>node-3: 61"]
```

| Plugin | Goal |
|--------|------|
| `LeastAllocated` | Spread load — pick the least-used node |
| `MostAllocated` | Bin-pack — fill nodes before using new ones (saves cost) |
| `NodeAffinity` | Honour preferred affinity rules |
| `ImageLocality` | Prefer nodes that already pulled the image (faster start) |
| `TaintToleration` | Nodes with matching tolerations get higher score |

---

## What Happens When No Node Passes Filter

```mermaid
sequenceDiagram
    participant SCHED as Scheduler
    participant API as API Server
    participant POD as Pod

    SCHED->>SCHED: Filter: 0 nodes pass
    SCHED->>API: add Event to pod:<br>"FailedScheduling: 0/3 nodes available:<br>3 Insufficient cpu"
    Note over POD: Pod stays Pending indefinitely
    Note over POD: Scheduler retries every ~1s (backoff)

    Note over SCHED: If Cluster Autoscaler present:
    SCHED->>API: Node expander watches Pending pods
    API->>CA: new EC2 node provisioned
    CA->>API: node registers as Ready
    SCHED->>SCHED: retry scheduling --> node passes Filter
    SCHED->>API: Bind pod to new node
```

### FailedScheduling events — what they mean

```bash
kubectl describe pod <pod> -n <namespace>
# Events:
#   Warning  FailedScheduling  0/3 nodes available:
#     3 Insufficient cpu                    → raise CPU requests or add nodes
#     3 node(s) had untolerated taint       → add toleration to pod
#     3 node(s) didn't match node affinity  → fix nodeSelector/affinity
#     1 pod has unbound PVC                 → PVC not bound, check StorageClass
#     3 node(s) didn't match topology       → spread constraints impossible
```

---

## Full Flow: Pod Scheduled to a Node

```mermaid
sequenceDiagram
    participant USER as kubectl apply
    participant API as API Server (etcd)
    participant SCHED as kube-scheduler
    participant KUBELET as kubelet (node)
    participant CRI as containerd (CRI)
    participant CNI as CNI plugin
    participant POD as Pod

    USER->>API: POST /pods (Pod spec, nodeName='')
    API->>API: store in etcd, status=Pending

    SCHED->>API: watch: new pod with no nodeName
    SCHED->>SCHED: Filter + Score --> node-2 wins
    SCHED->>API: POST /pods/binding --> nodeName=node-2

    API->>KUBELET: kubelet on node-2 watches its pods
    KUBELET->>CRI: RunPodSandbox (create pause container)
    CRI->>CNI: ADD (setup network namespace, assign IP)
    CNI-->>CRI: pod IP = 10.0.1.15
    KUBELET->>CRI: PullImage (if not cached)
    KUBELET->>CRI: CreateContainer + StartContainer
    KUBELET->>API: pod status = Running, podIP = 10.0.1.15

    API->>ENDPOINT: EndpointSlice updated with new pod IP
    API->>KPROXY: kube-proxy updates iptables rules
    Note over POD: traffic now routes to this pod
```

---

## Taints, Tolerations, and Affinity

### Taints — repel pods from nodes

```bash
# Taint a node (no GPU pods without toleration)
kubectl taint node gpu-node-1 nvidia.com/gpu=present:NoSchedule
#                             key=value:effect
# Effects: NoSchedule | PreferNoSchedule | NoExecute
```

### Tolerations — allow pods onto tainted nodes

```yaml
spec:
  tolerations:
  - key: "nvidia.com/gpu"
    operator: "Exists"
    effect: "NoSchedule"
```

### Node Affinity — attract pods to nodes

```yaml
spec:
  affinity:
    nodeAffinity:
      # Hard rule: pod MUST land on a node with this label
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: topology.kubernetes.io/zone
            operator: In
            values: ["us-east-1a", "us-east-1b"]

      # Soft rule: prefer nodes with this label, but not required
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
          - key: node.kubernetes.io/instance-type
            operator: In
            values: ["m5.2xlarge"]
```

### Topology Spread Constraints — spread across zones

```yaml
spec:
  topologySpreadConstraints:
  - maxSkew: 1                          # max diff in pod count between zones
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule   # or ScheduleAnyway
    labelSelector:
      matchLabels:
        app: api
```
