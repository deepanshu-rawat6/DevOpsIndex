# Kubernetes Cost Optimization

Right-sizing workloads, identifying waste, and using Spot instances are the three highest-leverage levers for cutting Kubernetes infrastructure costs without sacrificing reliability.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Resource Request Accuracy — VPA and Goldilocks

The root cause of Kubernetes overspend is almost always inaccurate resource requests. Requests determine scheduling and bin-packing: if every pod requests 2 CPU but uses 0.2, you need 10× more nodes than necessary.

**Vertical Pod Autoscaler (VPA)** in recommendation mode observes actual CPU and memory usage and suggests right-sized values without changing anything:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payments-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payments-service
  updatePolicy:
    updateMode: "Off"   # recommendation only — never auto-evict
```

Read recommendations:

```bash
kubectl describe vpa payments-vpa -n payments
# Recommendation:
#   Container Recommendations:
#     Container Name: payments
#       Lower Bound:  cpu: 50m,  memory: 64Mi
#       Target:       cpu: 120m, memory: 128Mi
#       Upper Bound:  cpu: 500m, memory: 512Mi
```

**Goldilocks** wraps VPA across every namespace and adds a dashboard:

```bash
# Install Goldilocks + VPA
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa --namespace vpa --create-namespace
helm install goldilocks fairwinds-stable/goldilocks --namespace goldilocks --create-namespace

# Enable per namespace
kubectl label namespace payments goldilocks.fairwinds.com/enabled=true

# Port-forward the dashboard
kubectl port-forward svc/goldilocks-dashboard 8080:80 -n goldilocks
```

The dashboard shows each workload's current request vs VPA's recommendation in a table, with a diff you can copy directly into your Helm values.

**LimitRange** — set safe defaults so new workloads without explicit requests don't get scheduled as if they need zero resources:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: payments
spec:
  limits:
  - type: Container
    default:           # applied when limits are missing
      cpu: 500m
      memory: 256Mi
    defaultRequest:    # applied when requests are missing
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "4"
      memory: 4Gi
```

<div class="quiz-card">
  <p class="quiz-q">VPA is installed in recommendation mode and suggests `cpu: 120m` for a pod that currently requests `cpu: 1000m`. Will anything change automatically?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. `updateMode: "Off"` means VPA only records recommendations — it never evicts or mutates pods. You read the recommendation and manually update your Deployment's resource requests (or Helm values), then roll out. This is the safe default: auto-eviction (`updateMode: Auto`) causes unexpected restarts and should only be enabled if you're prepared for pods to be restarted on VPA's schedule.</div>
</div>

---

## Kubecost — Cost Attribution and Waste Detection

**Kubecost** prices every pod, namespace, and cluster using your actual cloud billing data (or on-demand list prices as a fallback).

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost --create-namespace \
  --set kubecostToken="<your-token>" \
  --set prometheus.enabled=true \
  --set global.prometheus.enabled=true

kubectl port-forward svc/kubecost-cost-analyzer 9090 -n kubecost
```

**Key views:**

| View | What it shows |
|------|---------------|
| **Allocations** | Cost per namespace/label/team; shows CPU, memory, network, PV cost separately |
| **Savings** | Abandoned workloads, over-provisioned pods, PVCs without pods, right-sizing recommendations |
| **Assets** | Per-node cost breakdown (instance type, reserved vs on-demand) |
| **Cluster health** | % of cluster capacity that is idle (unscheduled) |

**Allocation API** — query cost programmatically:

```bash
# Cost by namespace, last 7 days
curl "http://localhost:9090/model/allocation?window=7d&aggregate=namespace&accumulate=true"
```

**Showback vs chargeback:**
- **Showback**: teams can see their costs but are not billed internally. Use this first — visibility alone reduces waste by 20–30%.
- **Chargeback**: costs are actually transferred to team budgets. Requires stable labeling conventions and buy-in from finance.

Label every workload for clean allocation:

```yaml
metadata:
  labels:
    team: payments
    cost-center: "123"
    env: production
```

---

## Spot Instance Node Pools — Karpenter

Spot instances (AWS) or preemptible VMs (GCP) cost 60–90% less than on-demand. The trade-off: 2-minute interruption warning, then the node terminates.

**Karpenter NodePool with Spot fallback:**

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]   # prefer spot, fall back to on-demand
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: node.kubernetes.io/instance-type
          operator: In
          values: ["m5.xlarge", "m5.2xlarge", "m6i.xlarge", "m6i.2xlarge"]
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
    - nodes: "10%"    # max 10% of nodes disrupted at once
```

Karpenter automatically places new nodes on Spot first. If no Spot capacity is available in any of the listed instance types, it falls back to on-demand.

**EKS managed node group with mixed instance policy (without Karpenter):**

```yaml
# eksctl cluster config
managedNodeGroups:
  - name: mixed-ng
    instanceTypes: ["m5.xlarge", "m5.2xlarge", "m6i.xlarge"]
    spot: true
    minSize: 2
    maxSize: 10
    desiredCapacity: 4
```

**PodDisruptionBudget — graceful Spot interruption:**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payments-pdb
  namespace: payments
spec:
  minAvailable: 2      # always keep 2 replicas up during voluntary disruptions
  selector:
    matchLabels:
      app: payments-service
```

When Karpenter or the Spot 2-minute warning triggers a drain, the PDB ensures at least 2 replicas stay running during the eviction sequence.

**Workloads NOT suitable for Spot:**
- Single-replica stateful sets (etcd, databases)
- Long-running batch jobs with no checkpointing
- Services with very tight SLOs and no replica redundancy

---

## Idle Resource Detection

**Abandoned workloads** — Deployments/StatefulSets with 0 replicas or stuck Jobs:

```bash
# Deployments with 0 ready replicas
kubectl get deployments --all-namespaces \
  -o jsonpath='{range .items[?(@.status.readyReplicas==0)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'

# Completed Jobs older than 7 days still in the cluster
kubectl get jobs --all-namespaces \
  -o jsonpath='{range .items[?(@.status.completionTime)]}{.metadata.namespace}/{.metadata.name} {.status.completionTime}{"\n"}{end}'
```

**Orphaned PVCs** — PersistentVolumeClaims not mounted by any pod (still billing you for the disk):

```bash
# List PVCs not referenced by any pod
kubectl get pvc --all-namespaces -o json | jq -r '
  .items[] |
  select(.status.phase == "Bound") |
  "\(.metadata.namespace)/\(.metadata.name) \(.spec.volumeName)"
' | while read pvc vol; do
  ns=$(echo $pvc | cut -d/ -f1)
  name=$(echo $pvc | cut -d/ -f2)
  # check if any pod mounts this PVC
  count=$(kubectl get pods -n $ns -o json | jq "[.items[].spec.volumes[]?.persistentVolumeClaim.claimName | select(. == \"$name\")] | length")
  [ "$count" -eq 0 ] && echo "ORPHANED: $pvc"
done
```

**Node utilization** — nodes that are mostly idle waste money even when the pods are healthy:

```bash
kubectl top nodes
# NAME         CPU(cores)  CPU%  MEMORY(bytes)  MEMORY%
# node-abc123  120m        3%    1024Mi         13%
# node-def456  3800m       95%   12Gi           78%
# node-ghi789  80m         2%    512Mi          7%
# → node-abc123 and node-ghi789 are candidates for consolidation
```

Karpenter's `consolidationPolicy: WhenUnderutilized` handles this automatically — it drains and terminates under-used nodes after `consolidateAfter` seconds.

---

## Bin-Packing vs Spreading — Scheduler Tuning

The default Kubernetes scheduler uses `LeastAllocated` scoring — it prefers nodes with more free capacity, which **spreads** pods across nodes. This improves resilience but wastes money when spot/on-demand costs vary.

For cost optimization, you can switch to `MostAllocated` to pack pods more tightly:

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    pluginConfig:
    - name: NodeResourcesFit
      args:
        scoringStrategy:
          type: MostAllocated   # pack tightly; default is LeastAllocated
          resources:
          - name: cpu
            weight: 1
          - name: memory
            weight: 1
```

**Descheduler** — rebalances pods after new (cheaper) nodes join the cluster:

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="0 */6 * * *"  # run every 6 hours
```

The Descheduler evicts pods from over-utilized nodes so they reschedule onto the newly added cheaper nodes. It respects PodDisruptionBudgets.

```yaml
# descheduler policy — evict pods from nodes with > 80% CPU utilization
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
  - name: default
    plugins:
      balance:
        enabled:
        - name: HighNodeUtilization
    pluginConfig:
    - name: HighNodeUtilization
      args:
        thresholds:
          cpu: 20
          memory: 20
        targetThresholds:
          cpu: 80
          memory: 80
```

<div class="quiz-card">
  <p class="quiz-q">You switch the scheduler to `MostAllocated` to pack pods more tightly. A node reaches 85% CPU. What risk does this create and how should you mitigate it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Tight packing leaves little headroom for traffic spikes. If a packed node's pods burst beyond their limits, they'll be throttled (CPU) or OOM-killed (memory). Mitigate with: (1) accurate resource limits on every pod so burst capacity is capped, (2) HPA to add replicas before the node saturates, (3) a Descheduler targetThreshold below 80% so the scheduler rebalances before saturation, and (4) maintaining PodDisruptionBudgets so node drains don't cause outages during the rebalance.</div>
</div>

---

## Cost Optimization Checklist

- [ ] VPA installed in `Off` mode for all production namespaces — generating recommendations
- [ ] Goldilocks dashboard reviewed monthly; top 10 over-requested workloads right-sized
- [ ] LimitRange applied to every namespace with sensible defaults
- [ ] Kubecost (or equivalent) installed and emitting cost-by-namespace metrics
- [ ] Showback reports sent to team leads weekly
- [ ] Every workload labeled with `team`, `env`, `cost-center`
- [ ] Karpenter NodePool configured with `["spot", "on-demand"]` capacity types
- [ ] Instance type list includes at least 3–5 families to reduce Spot unavailability risk
- [ ] PodDisruptionBudget present for every production Deployment with > 1 replica
- [ ] Orphaned PVC audit run monthly — unattached volumes deleted or snapshotted and deleted
- [ ] Abandoned Deployments (0 ready replicas for > 7 days) cleaned up
- [ ] Descheduler running on a schedule to rebalance after scale-in events
- [ ] Node utilization dashboard checked weekly — idle nodes consolidated
- [ ] Reserved Instances or Savings Plans covering baseline (non-Spot) node capacity
