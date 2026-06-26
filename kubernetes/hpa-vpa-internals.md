# HPA and VPA — Deep Internals

## HPA — Horizontal Pod Autoscaler

### Every Stage Internals

```mermaid
sequenceDiagram
    participant APP as App Pod
    participant MS as Metrics Server
    participant HPA as HPA Controller
    participant API as API Server
    participant SCHED as Scheduler
    participant KUBELET as kubelet
    participant CA as Cluster Autoscaler

    Note over APP,MS: Every 15s (scrape interval)
    APP->>MS: expose /metrics (cAdvisor on kubelet)
    MS->>MS: aggregate CPU/memory per pod

    Note over HPA: Every 15s (--horizontal-pod-autoscaler-sync-period)
    HPA->>MS: GET /apis/metrics.k8s.io/v1beta1/namespaces/default/pods
    MS-->>HPA: [{pod: api-1, cpu: 85m}, {pod: api-2, cpu: 90m}]

    HPA->>HPA: compute desired replicas
    Note over HPA: desiredReplicas = ceil(currentReplicas × (currentMetric/targetMetric))<br>= ceil(2 × (87.5/70)) = ceil(2.5) = 3

    HPA->>API: PATCH deployment/api spec.replicas=3
    API->>API: ReplicaSet controller sees 2 pods, wants 3
    API->>SCHED: new Pod created (Pending, no node assigned)

    SCHED->>API: GET nodes + pods (from cache)
    SCHED->>SCHED: Filter --> Score --> Bind
    SCHED->>API: Bind pod to node-2

    API->>KUBELET: kubelet on node-2 watches pod assigned to it
    KUBELET->>KUBELET: pull image, create sandbox, start container
    KUBELET->>API: pod status = Running

    Note over HPA: If no node has capacity:
    SCHED-->>API: pod stays Pending
    CA->>CA: detects Pending pod, provisions new EC2 node
    CA->>SCHED: new node joins, pod gets scheduled
```

### The Math

```
desiredReplicas = ceil( currentReplicas × (currentValue / targetValue) )

Example: 3 pods, CPU target 70%, current average 90%
desiredReplicas = ceil(3 × 90/70) = ceil(3.86) = 4

Scale-down: 4 pods, CPU 20%
desiredReplicas = ceil(4 × 20/70) = ceil(1.14) = 2
BUT: scale-down waits stabilizationWindowSeconds (default 300s)
to avoid flapping
```

### HPA QoS Classes and Behaviour

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0      # scale up immediately
      policies:
      - type: Pods
        value: 4                         # add at most 4 pods per 60s
        periodSeconds: 60
      - type: Percent
        value: 100                       # or double pods per 60s
        periodSeconds: 60
      selectPolicy: Max                  # use whichever is larger

    scaleDown:
      stabilizationWindowSeconds: 300    # wait 5min before scaling down
      policies:
      - type: Pods
        value: 1                         # remove at most 1 pod per 60s
        periodSeconds: 60
```

### What Happens When No Node is Available

```mermaid
flowchart TD
    HPA["HPA: scale to 5 replicas"] --> RS["ReplicaSet creates<br>new Pod object"]
    RS --> SCHED["Scheduler: Filter phase<br>no node passes all filters"]
    SCHED --> PENDING["Pod status: Pending<br>Event: FailedScheduling<br>'Insufficient cpu'"]
    PENDING --> CA["Cluster Autoscaler<br>watches Pending pods"]
    CA --> ASG["Expand ASG / Node Group<br>provision new EC2 node"]
    ASG --> NODE["New node Ready<br>registers with API Server"]
    NODE --> SCHED2["Scheduler retries<br>pod gets bound to new node"]
    SCHED2 --> KUBELET["kubelet: pull image<br>start container"]
    KUBELET --> RUNNING["Pod: Running"]
```

### Debugging HPA

```bash
# See current HPA state
kubectl get hpa -n <namespace>
# NAME   REFERENCE         TARGETS         MINPODS  MAXPODS  REPLICAS
# api    Deployment/api    85%/70%         2        20       4

# Describe for events and conditions
kubectl describe hpa api -n <namespace>
# Conditions:
#   AbleToScale    True   SucceededGetScale
#   ScalingActive  True   ValidMetricFound
#   ScalingLimited False  DesiredWithinRange

# Check metrics server is working
kubectl top pods -n <namespace>
# If this fails → HPA will show <unknown>

# Events that matter
kubectl get events -n <namespace> | grep HPA
# SuccessfulRescale: New size: 4; reason: cpu resource utilization above target
```

---

## VPA — Vertical Pod Autoscaler

### Why VPA?

HPA adds more pods. VPA makes each pod bigger (more CPU/memory). Use when:
- **Singleton workloads** — only one instance can run (leader-elected, stateful, CronJob)
- **Memory-bound** workloads — memory doesn't decrease with more replicas (ML model loaded in memory)
- **Right-sizing** — you don't know the right requests/limits; start with VPA in `Off` mode for recommendations

### VPA Architecture

```mermaid
graph TD
    VPA_ADM["VPA Admission Controller<br>(MutatingWebhook)"] -->|"inject requests on pod create"| POD["Pod<br>resources patched at creation"]
    VPA_REC["VPA Recommender<br>(reads metrics history)"] -->|"update VPA object"| VPA_OBJ["VPA Object<br>spec.updatePolicy.updateMode"]
    VPA_UPD["VPA Updater<br>(evicts pods to apply)"] -->|"evict pod if limits too low"| POD
    METRICS["Metrics Server / Prometheus"] -->|"historical CPU/mem"| VPA_REC
```

Three components:
1. **Recommender** — watches pod resource usage history, computes `lowerBound`, `target`, `upperBound`
2. **Updater** — evicts pods that are too far from target (so Admission Controller can inject new values on restart)
3. **Admission Controller** — patches `resources` on pod creation (Mutating webhook)

### VPA Update Modes

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  updatePolicy:
    updateMode: "Auto"    # Off | Initial | Recreate | Auto
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 4Gi
      controlledResources: ["cpu", "memory"]
```

| Mode | What it does |
|------|-------------|
| `Off` | Recommendations only — no changes applied. Use first to baseline. |
| `Initial` | Sets requests at pod creation, never touches running pods |
| `Recreate` | Evicts pods to apply new recommendations (causes restart) |
| `Auto` | Same as Recreate today; future: in-place update |

### VPA for Singleton Applications

```mermaid
sequenceDiagram
    participant VPA_R as VPA Recommender
    participant VPA_U as VPA Updater
    participant POD as Singleton Pod
    participant API as API Server

    Note over VPA_R: monitors CPU/mem over time
    VPA_R->>API: update VPA status: target.cpu=500m target.memory=1Gi

    Note over VPA_U: pod is using 200m CPU but limit is 100m --> throttled
    VPA_U->>POD: evict (SIGTERM)
    Note over POD: pod restarts
    VPA_ADM->>POD: on admission: inject cpu=500m memory=1Gi
    POD->>API: running with correct resources

    Note over POD: ⚠️ Singleton = downtime during eviction
    Note over POD: Mitigation: PodDisruptionBudget minAvailable=0<br>or use VPA updateMode=Initial
```

**Singleton + VPA caveat:** Every Updater eviction = restart = downtime for singleton. Mitigations:
1. Use `updateMode: Initial` — recommendations applied at next natural restart only
2. Use `updateMode: Off` + manually apply recommendations during maintenance window
3. Use `minAvailable: 0` in PDB to allow the eviction but schedule the restart yourself

### Checking VPA Recommendations

```bash
kubectl describe vpa api-vpa
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name: api
#       Lower Bound:
#         Cpu:     100m
#         Memory:  256Mi
#       Target:                  ← use this for requests
#         Cpu:     400m
#         Memory:  768Mi
#       Uncapped Target:
#         Cpu:     400m
#         Memory:  768Mi
#       Upper Bound:             ← use this for limits
#         Cpu:     2
#         Memory:  2Gi
```

### HPA + VPA: Can You Use Both?

**Not on the same metric.** If both target CPU:
- VPA increases pod CPU → pods use less CPU → HPA scales in → fewer pods → more load per pod → VPA increases again → loop

**Safe combination:**
- HPA on custom metric (RPS, queue depth) + VPA on CPU/memory
- Or: VPA in `Off` mode (recommendations only) + HPA on CPU (you apply VPA recommendations manually)
