# Chaos Engineering — Hands-On Exercises

Runnable exercises that build on [chaos-engineering.md](./chaos-engineering.md). Requires a working K8s cluster (kind/minikube/EKS) with `kubectl` and `helm` configured. Each exercise is self-contained: prerequisites → commands → expected output → pass/fail bar → cleanup.

---

## Exercise 1 — Litmus Chaos: Pod Delete on nginx Deployment

**Tests:** does the Deployment controller reschedule a killed pod fast enough to avoid a service-level outage.

### Prerequisites

```bash
kubectl create namespace litmus
kubectl create namespace chaos-target

# Install Litmus Chaos operator via Helm
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update
helm install litmus litmuschaos/litmus --namespace litmus

# Verify operator is running
kubectl get pods -n litmus
# litmus-litmus-frontend-...      Running
# litmus-litmus-server-...        Running
# litmus-litmus-chaos-operator-...   Running

# Deploy target: nginx with 3 replicas + a Service
kubectl create deployment nginx --image=nginx:1.25 --replicas=3 -n chaos-target
kubectl expose deployment nginx --port=80 -n chaos-target
kubectl get pods -n chaos-target -o wide
```

### Step 1 — Install the pod-delete experiment CR

```bash
kubectl apply -f https://hub.litmuschaos.io/api/chaos/3.5.0?file=charts/generic/pod-delete/experiment.yaml -n chaos-target

# Create the service account + RBAC Litmus needs to act in this namespace
kubectl apply -f https://hub.litmuschaos.io/api/chaos/3.5.0?file=charts/generic/rbac.yaml -n chaos-target
```

### Step 2 — ChaosEngine YAML

```yaml
# pod-delete-engine.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: nginx-pod-delete
  namespace: chaos-target
spec:
  appinfo:
    appns: chaos-target
    applabel: "app=nginx"
    appkind: deployment
  engineState: active
  chaosServiceAccount: litmus-admin
  annotationCheck: "false"
  jobCleanUpPolicy: retain      # keep pods around for post-run inspection
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: "30"        # seconds
            - name: CHAOS_INTERVAL
              value: "10"        # kill a pod every 10s
            - name: FORCE
              value: "false"     # graceful delete, not SIGKILL
            - name: PODS_AFFECTED_PERC
              value: "33"        # ~1 of 3 replicas per kill cycle
```

```bash
kubectl apply -f pod-delete-engine.yaml
```

### Step 3 — Observe in real time

```bash
# Terminal 1: watch pods getting killed and rescheduled
kubectl get pods -n chaos-target -w

# Terminal 2: watch the chaos runner + experiment pod logs
kubectl get pods -n chaos-target -l name=nginx-pod-delete-runner
kubectl logs -n chaos-target -l name=nginx-pod-delete -f

# Terminal 3: hit the service continuously to check for dropped requests
kubectl run loadgen --rm -it --image=busybox -n chaos-target -- \
  sh -c 'while true; do wget -q -O- http://nginx 2>&1 | head -c1; sleep 0.5; done'
```

### Step 4 — Check the result

```bash
kubectl get chaosresult nginx-pod-delete-pod-delete -n chaos-target -o yaml
```

Expected output (trimmed):

```yaml
status:
  experimentStatus:
    phase: Completed
    verdict: Pass
    probeSuccessPercentage: "100"
```

### Pass vs Fail

| Signal | Pass | Fail |
|---|---|---|
| `verdict` field | `Pass` | `Fail` or `Awaited` (stuck) |
| Service availability during test | 0% dropped requests in loadgen loop | Any `wget` timeout/refused |
| Pod count | Returns to 3/3 Ready within `CHAOS_INTERVAL` | Pods stuck `Pending`/`CrashLoopBackOff` |
| Replica recovery time | < 5s per killed pod | > 15s (image pull, scheduling delay) |

### Cleanup

```bash
kubectl delete chaosengine nginx-pod-delete -n chaos-target
kubectl delete chaosresult nginx-pod-delete-pod-delete -n chaos-target
kubectl delete deployment nginx -n chaos-target
kubectl delete service nginx -n chaos-target
kubectl delete namespace chaos-target litmus
```

---

## Exercise 2 — Chaos Mesh: Network Partition (Service → Database)

**Tests:** whether the app's DB client handles connection loss gracefully (retries/circuit breaker) instead of cascading into a full outage.

### Prerequisites

```bash
# Install Chaos Mesh (kind/minikube: use --set chaosDaemon.runtime=containerd as needed)
curl -sSL https://mirrors.chaos-mesh.org/v2.6.3/install.sh | bash

kubectl get pods -n chaos-mesh
# chaos-controller-manager-...   Running
# chaos-daemon-...                Running (one per node)
# chaos-dashboard-...              Running

# Deploy a target app + a fake "database" pod, both labeled for selection
kubectl create namespace demo
kubectl run app --image=nginx:1.25 -n demo --labels="role=app"
kubectl run db  --image=nginx:1.25 -n demo --labels="role=db"
kubectl expose pod db --port=80 --name=db-svc -n demo
```

### Step 1 — Confirm baseline connectivity

```bash
kubectl exec -n demo app -- curl -s -o /dev/null -w "%{http_code}\n" http://db-svc
# 200
```

### Step 2 — NetworkChaos YAML (partition app from db)

```yaml
# network-partition.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: app-db-partition
  namespace: demo
spec:
  action: partition
  mode: all
  selector:
    namespaces: [demo]
    labelSelectors:
      role: app
  direction: to
  target:
    mode: all
    selector:
      namespaces: [demo]
      labelSelectors:
        role: db
  duration: "60s"
```

```bash
kubectl apply -f network-partition.yaml
```

### Step 3 — Verify the partition takes effect

```bash
# From the app pod, requests to db-svc should now fail/timeout
kubectl exec -n demo app -- curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://db-svc
# curl: (28) Connection timed out after 3000 milliseconds  -> exit code 28, no HTTP code printed

# Confirm the chaos object is actively injected
kubectl get networkchaos app-db-partition -n demo -o jsonpath='{.status.conditions}'
```

### Step 4 — Wait for auto-recovery and verify restoration

```bash
sleep 65   # duration was 60s
kubectl exec -n demo app -- curl -s -o /dev/null -w "%{http_code}\n" http://db-svc
# 200  -> connectivity restored automatically once the NetworkChaos duration expires
```

### Pass vs Fail

| Signal | Pass | Fail |
|---|---|---|
| During partition | App returns cached data / circuit-breaker error (e.g. 503 with clear message) | App hangs indefinitely or crashes (panic, OOM from retry storm) |
| Retry behavior | Bounded retries with backoff visible in app logs | Unbounded retry loop hammering the network daemon |
| After partition ends | Connectivity restored within 1 poll interval, no manual restart needed | App pod stuck in a broken state requiring restart |
| curl exit code during test | `28` (timeout) — expected/injected | `0` (200 OK) — chaos didn't actually apply, check selectors |

### Cleanup

```bash
kubectl delete networkchaos app-db-partition -n demo
kubectl delete pod app db -n demo
kubectl delete service db-svc -n demo
kubectl delete namespace demo
# Optional full removal of Chaos Mesh itself:
curl -sSL https://mirrors.chaos-mesh.org/v2.6.3/install.sh | bash -s -- --template | kubectl delete -f -
```

---

## Exercise 3 — Chaos Mesh: CPU Stress to Validate HPA Scaling

**Tests:** whether HPA detects CPU pressure and scales out within its polling interval, and scales back in once load stops.

### Prerequisites

```bash
kubectl create namespace hpa-demo

# metrics-server must be running for HPA to read CPU% (kind users: install with --kubelet-insecure-tls)
kubectl get deployment metrics-server -n kube-system

# Deploy a CPU-bound target with requests/limits set (HPA needs `requests` to compute %)
kubectl create deployment stress-app --image=vish/stress -n hpa-demo -- -cpus 1
kubectl set resources deployment stress-app -n hpa-demo \
  --requests=cpu=100m,memory=64Mi --limits=cpu=500m,memory=128Mi

kubectl autoscale deployment stress-app -n hpa-demo \
  --cpu-percent=50 --min=1 --max=5

kubectl get hpa -n hpa-demo -w
```

### Step 1 — Baseline: confirm 1 replica, low CPU%

```bash
kubectl get hpa stress-app -n hpa-demo
# NAME          REFERENCE                TARGETS   MINPODS   MAXPODS   REPLICAS
# stress-app    Deployment/stress-app    3%/50%    1         5         1
```

### Step 2 — PodChaos CPU stress YAML

```yaml
# cpu-stress.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: stress-app-cpu
  namespace: hpa-demo
spec:
  action: pod-kill      # placeholder — actual stressor uses StressChaos, see below
```

> Note: CPU load injection uses the `StressChaos` kind, not `PodChaos` — use this instead:

```yaml
# cpu-stress.yaml (correct kind)
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: stress-app-cpu
  namespace: hpa-demo
spec:
  mode: all
  selector:
    namespaces: [hpa-demo]
    labelSelectors:
      app: stress-app
  stressors:
    cpu:
      workers: 2
      load: 100          # % load per worker
  duration: "180s"
```

```bash
kubectl apply -f cpu-stress.yaml
```

### Step 3 — Watch HPA react in real time

```bash
# Terminal 1
kubectl get hpa stress-app -n hpa-demo -w

# Terminal 2 — raw metrics feed
watch -n 5 'kubectl top pods -n hpa-demo'

# Terminal 3 — scale events as they happen
kubectl get events -n hpa-demo --field-selector reason=SuccessfulRescale -w
```

Expected progression (default HPA sync period ~15s, scale-up is fast, scale-down has a 5-min stabilization window by default):

```
TARGETS      REPLICAS
3%/50%       1
94%/50%      1     <- stress starts, CPU spikes immediately
94%/50%      2     <- HPA reacts within ~15-30s
91%/50%      4     <- continues scaling toward max
88%/50%      5     <- hits max=5, holds
[stress ends at 180s]
22%/50%      5     <- CPU drops but replicas held (stabilization window)
22%/50%      1     <- scales back down after ~5 min
```

### Pass vs Fail

| Signal | Pass | Fail |
|---|---|---|
| Scale-up latency | New replicas Running within ~30-60s of CPU% exceeding target | No scale-up after 2+ minutes — check metrics-server, `resources.requests` set |
| Max replicas respected | Caps at `--max=5`, never exceeds | Unbounded scaling (misconfigured HPA) |
| Scale-down | Returns toward `min=1` after stabilization window post-stress | Stuck at max replicas indefinitely — check `behavior.scaleDown` config |
| `kubectl top pods` during stress | Each pod near its CPU limit (500m) | Pods show near-zero CPU — stressor not actually applied, check selector labels |

### Cleanup

```bash
kubectl delete stresschaos stress-app-cpu -n hpa-demo
kubectl delete hpa stress-app -n hpa-demo
kubectl delete deployment stress-app -n hpa-demo
kubectl delete namespace hpa-demo
```

---

## Exercise 4 — Game Day: Simulated Full AZ Failure (EKS)

**Tests:** organizational readiness — pod rescheduling speed, PDB enforcement, and whether the service stays available while an entire AZ's worth of nodes goes away. This is a manual, scripted game day, not a CRD-driven fault injection.

### Prerequisites

```bash
# Identify node-to-AZ mapping
kubectl get nodes -L topology.kubernetes.io/zone

# Example output:
# NAME                          STATUS   ZONE
# ip-10-0-1-23.ec2.internal     Ready    us-east-1a
# ip-10-0-2-45.ec2.internal     Ready    us-east-1b
# ip-10-0-3-67.ec2.internal     Ready    us-east-1c

# Deploy a realistic multi-AZ app with a PodDisruptionBudget and anti-affinity
kubectl create namespace gameday
```

```yaml
# app-with-pdb.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: gameday
spec:
  replicas: 6
  selector:
    matchLabels: {app: web}
  template:
    metadata:
      labels: {app: web}
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels: {app: web}
              topologyKey: topology.kubernetes.io/zone
      containers:
      - name: web
        image: nginx:1.25
        resources:
          requests: {cpu: 100m, memory: 64Mi}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
  namespace: gameday
spec:
  minAvailable: 4        # tolerate losing at most 2 of 6 at once
  selector:
    matchLabels: {app: web}
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: gameday
spec:
  selector: {app: web}
  ports:
  - port: 80
```

```bash
kubectl apply -f app-with-pdb.yaml
kubectl get pods -n gameday -o wide -L topology.kubernetes.io/zone
```

### Step 1 — Establish steady state and start continuous availability probe

```bash
# Terminal 1: hit the service every 500ms, log failures with timestamps
kubectl run loadgen --rm -it --image=busybox -n gameday -- sh -c \
  'while true; do
     code=$(wget -q -O- --timeout=2 http://web 2>&1 >/dev/null; echo $?)
     echo "$(date +%T) exit=$code"
     sleep 0.5
   done'
```

### Step 2 — Pick target AZ and cordon its nodes (stop new scheduling)

```bash
TARGET_ZONE=us-east-1a

for node in $(kubectl get nodes -l topology.kubernetes.io/zone=$TARGET_ZONE -o name); do
  kubectl cordon "$node"
done

kubectl get nodes -L topology.kubernetes.io/zone
# Confirm SchedulingDisabled on the targeted AZ's nodes only
```

### Step 3 — Drain nodes in that AZ (simulates AZ becoming unreachable)

```bash
for node in $(kubectl get nodes -l topology.kubernetes.io/zone=$TARGET_ZONE -o name); do
  kubectl drain "$node" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=120s
done
```

### Step 4 — Observe during the drain (run these while drain is in progress)

```bash
# Watch pod rescheduling live
kubectl get pods -n gameday -o wide -w

# Watch PDB — eviction should be blocked once minAvailable would be violated
kubectl get pdb web-pdb -n gameday -w

# Watch drain-triggered events for eviction blocks
kubectl get events -n gameday --field-selector reason=FailedEviction -w

# Time to full rescheduling
date; kubectl get pods -n gameday -o wide
```

### Checklist — what to observe

| Item | What "good" looks like |
|---|---|
| **Pod rescheduling time** | Evicted pods reach `Running` in another AZ within ~30-60s (image already cached; longer if pulling fresh) |
| **PDB behavior** | `kubectl drain` pauses/retries evictions once `minAvailable: 4` would be breached — drain should NOT force through and violate the budget |
| **Service availability** | `loadgen` shows zero or near-zero failed requests throughout — anti-affinity + PDB + surplus replicas absorb the loss |
| **Node status** | Drained nodes show `Ready,SchedulingDisabled`, zero non-DaemonSet pods remaining |
| **Pod distribution post-drain** | Remaining 6 pods redistributed only across the 2 healthy AZs |
| **kube-scheduler decisions** | `kubectl describe pod <new-pod>` shows scheduling reason avoiding the cordoned zone |

### Pass vs Fail

| Signal | Pass | Fail |
|---|---|---|
| Availability during drain | 0 failed requests, or brief sub-second blip only | Sustained failures / 5xx for more than one probe interval |
| PDB enforcement | Drain respects `minAvailable`, throttles eviction pace | Drain forces evictions below `minAvailable` (PDB misconfigured or `--disable-eviction` used) |
| Recovery | All 6 replicas `Running` and `Ready` in remaining AZs within a few minutes | Pods stuck `Pending` — insufficient capacity in remaining AZs (a real finding, not a test failure) |
| Node state | Cleanly cordoned+drained, no stuck pods needing `--force` | Pods stuck due to local storage / missing PDB tolerance requiring `--force` (data loss risk) |

### Cleanup / Rollback

```bash
# Uncordon the AZ's nodes to restore scheduling (does NOT auto-move pods back)
for node in $(kubectl get nodes -l topology.kubernetes.io/zone=$TARGET_ZONE -o name); do
  kubectl uncordon "$node"
done

# Optional: rebalance pods back across all AZs now that nodes are schedulable
kubectl rollout restart deployment web -n gameday

# Teardown
kubectl delete namespace gameday
```

**Rollback if something goes wrong mid-drain:** `kubectl uncordon` immediately re-enables scheduling on the target nodes; already-evicted pods will not automatically move back, but new pods can land there again. If nodes were terminated (real AZ failure test on EKS via ASG desired-count changes rather than drain), scale the ASG back to its original desired count instead.

---

## Chaos Engineering Maturity Checklist (Crawl / Walk / Run)

Use this to assess where a team actually is — most teams overestimate their stage.

### Crawl (getting started)

- [ ] Chaos experiments run **only in staging/dev**, never prod
- [ ] Steady-state metrics (error rate, p99 latency) are defined and dashboarded *before* any experiment
- [ ] Single blast radius: one pod, one deployment — never namespace-wide
- [ ] Every experiment has a documented rollback command copy-pasted and tested beforehand
- [ ] Experiments run during business hours with a human watching, never unattended
- [ ] Post-experiment write-up for every run, even successful ones (what was learned)
- [ ] Tooling installed (Litmus/Chaos Mesh) but no automation — everything triggered manually

### Walk (building confidence)

- [ ] Chaos experiments run in **production**, but only for services with a defined owner and on-call
- [ ] Blast radius expanded to a full deployment/service, still within one namespace
- [ ] Experiments run on a **schedule** (e.g., weekly game day) rather than ad hoc
- [ ] Steady-state checks are automated as pre/post probes in the ChaosEngine itself, not eyeballed
- [ ] PDBs, resource limits, and HPA exist and are exercised as part of experiments (not just pod-kill)
- [ ] Findings feed into a tracked backlog (tickets), not just a doc nobody reopens
- [ ] Game days include cross-team participants (not just the platform team)
- [ ] Alerting is validated as part of the experiment — if a fault doesn't page anyone, that's a finding

### Run (mature practice)

- [ ] Chaos experiments are **triggered automatically in CI/CD** against staging before promoting a release
- [ ] Continuous, low-grade chaos runs in production in the background (e.g., Netflix-style random pod termination)
- [ ] Multi-fault experiments combine failures (network partition + CPU stress simultaneously) to test compounding failure modes
- [ ] AZ/region-level failure is tested on a **regular cadence**, not just once
- [ ] Auto-remediation exists for the most common findings (see [sre/self-healing-aiops.md](../sre/self-healing-aiops.md)) and is itself chaos-tested
- [ ] Chaos experiment results feed SLO error-budget tracking directly
- [ ] New services must pass a defined chaos test suite before being marked production-ready ("chaos gate" in the release process)
- [ ] Game days simulate realistic multi-service cascading failures, not single-component faults

**Rule of thumb progression:** don't move to the next stage until every unchecked box in the current one is checked and stable for at least a full quarter. Skipping straight to "Run" without Crawl/Walk discipline is how chaos engineering causes the outage it was meant to prevent.
