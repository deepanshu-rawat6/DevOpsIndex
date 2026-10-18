# Cilium: eBPF-Powered Networking for Kubernetes

Cilium is a CNCF graduated project that replaces kube-proxy and provides an eBPF-based CNI (Container Network Interface) for Kubernetes. It performs L4 load balancing at the kernel level, enforces network policies based on workload identity (not IP addresses), and provides deep network observability through Hubble — all without iptables.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Why Cilium Replaced kube-proxy

kube-proxy implements Kubernetes Service load balancing by programming iptables rules. The problem: iptables is a sequential rule table. Every packet traverses every rule until it matches — O(n) complexity, where n is the number of rules.

**The scale problem:**
- Each Kubernetes Service creates ~10 iptables rules (one for each endpoint + NAT rules)
- A cluster with 10,000 Services and 5 endpoints each = 50,000+ iptables rules
- A rule table of this size adds ~10ms of latency per packet traversal
- Adding or removing a Service requires locking and rewriting the entire iptables ruleset — causing brief traffic disruption

**Cilium's approach:**
- Implements Service load balancing with eBPF programs attached to the TC hook
- Uses a BPF hash map: `Service IP:Port → list of backend IPs` — O(1) lookup regardless of cluster size
- Updates are atomic map operations, not full ruleset rewrites — no traffic disruption
- The XDP hook can process packets even before the kernel allocates a socket buffer — the lowest-latency interception point

```mermaid
graph TD
    classDef pod fill:#4f8cff,stroke:#2563eb,color:#fff
    classDef ebpf fill:#34d399,stroke:#059669,color:#000
    classDef table fill:#a78bfa,stroke:#7c3aed,color:#fff

    POD["Pod sends packet\nto Service IP"]:::pod
    TC["TC eBPF program\n(Cilium)"]:::ebpf
    MAP["BPF Hash Map\nService → Backends"]:::table
    BACKEND["Backend Pod"]:::pod

    POD --> TC
    TC -->|"lookup in O(1)"| MAP
    MAP -->|"DNAT to backend IP"| BACKEND
```

<div class="quiz-card">
  <p class="quiz-q">A cluster grows from 500 to 5,000 Services overnight after a migration. Engineers using kube-proxy observe a 15ms increase in p99 service-to-service latency. Engineers on an identical cluster using Cilium with kube-proxy replacement observe no change. Explain the root cause of the kube-proxy regression and why Cilium is unaffected.</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>kube-proxy root cause: 5,000 Services × ~10 rules each = ~50,000 iptables rules. iptables evaluates rules sequentially — a packet destined for a Service near the end of the table traverses nearly all 50,000 rules before matching. At 5,000 Services, even fast rule evaluation adds measurable latency per packet. Additionally, updating iptables for new or changed Services locks the netfilter table and rewrites all rules atomically — this write lock briefly pauses all packet processing on that node, causing microsecond spikes visible in p99. Cilium is unaffected because it uses a BPF hash map for Service → endpoint lookup. A hash map lookup is O(1) — the lookup time is identical whether the map has 500 or 500,000 entries. Map updates are atomic single-entry operations, not table rewrites, so there is no write lock affecting other packets. The migration from kube-proxy to Cilium specifically at scale is one of the primary motivations enterprises cite for adopting Cilium.</div>
</div>

---

## 2. Cilium as CNI

**Installation with Helm (kube-proxy replacement mode):**

```bash
helm repo add cilium https://helm.cilium.io/

helm install cilium cilium/cilium \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_IP> \
  --set k8sServicePort=6443 \
  --set ipam.mode=kubernetes \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

**Verifying the installation:**

```bash
# Install the Cilium CLI
cilium install --version 1.15.0

# Check status — all agents must be running and all checks green
cilium status
# ✅ cilium            OK       Cilium is installed and up-to-date
# ✅ hubble-relay      OK       Hubble Relay is installed and up-to-date
# ✅ kube-proxy        OK       kube-proxy is not installed — using eBPF socket-level LB

# Run the built-in connectivity test (deploys test pods and verifies end-to-end)
cilium connectivity test
```

**Verifying kube-proxy is replaced:**

```bash
# Should return nothing — kube-proxy DaemonSet should not exist
kubectl get daemonset -n kube-system kube-proxy

# Verify Cilium is handling Service load balancing
kubectl exec -n kube-system ds/cilium -- cilium service list
```

---

## 3. Hubble: Flow Observability

Hubble is Cilium's built-in observability layer. It uses eBPF to capture every network flow between pods — source, destination, protocol, verdict (forwarded/dropped), and HTTP method/path for L7 flows — with zero application changes.

**CLI usage:**

```bash
# Install the Hubble CLI
cilium hubble port-forward &

# Watch all flows in real-time
hubble observe

# Filter: flows to the payments service on port 5432
hubble observe --namespace payments --port 5432

# Show dropped flows (network policy violations)
hubble observe --verdict DROPPED

# Show HTTP flows with response codes
hubble observe --protocol http --http-status-code 500

# JSON output for parsing
hubble observe --namespace payments --output json | jq '.flow | {src: .source.namespace, dst: .destination.namespace, verdict: .verdict}'
```

**Hubble UI** provides a real-time service map — nodes are services, edges are flows, colors indicate health (green = forwarded, red = dropped). This makes it trivial to see which services a new deployment communicates with and whether any communications are being blocked by network policies.

---

## 4. Cilium NetworkPolicy: Identity-Based

Standard Kubernetes NetworkPolicy selects traffic by IP address. IPs are ephemeral in Kubernetes — a pod restart gets a new IP. Cilium's NetworkPolicy uses **Cilium identities** — a hash of a pod's labels — which remain stable across restarts.

**CiliumNetworkPolicy vs standard NetworkPolicy:**

```yaml
# Standard NetworkPolicy (IP-based — the "from: podSelector" is resolved to IPs by kube-proxy)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend
spec:
  podSelector:
    matchLabels:
      app: payments-api
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
```

```yaml
# CiliumNetworkPolicy — identity-based, more expressive, L7-capable
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-frontend-http
spec:
  endpointSelector:
    matchLabels:
      app: payments-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/.*"
              - method: "POST"
                path: "/api/v1/payments"
```

The L7 rule above enforces at the HTTP level: frontend pods can make GET requests to any `/api/v1/` path and POST to `/api/v1/payments` only. A POST to `/api/v1/admin` is dropped. Standard NetworkPolicy cannot do this — it only operates at L4 (IP + port).

<div class="quiz-card">
  <p class="quiz-q">A CiliumNetworkPolicy allows the `frontend` service to make GET requests to `payments-api` on port 8080. A developer adds a POST endpoint to the payments-api and the frontend needs to call it. What breaks, what can be observed in Hubble, and what change is needed?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The POST request is blocked by the L7 CiliumNetworkPolicy rule, which only allows `method: "GET"`. The connection is established (L4 allows port 8080 from frontend), but Cilium's HTTP filter returns a `403 Forbidden` before the request reaches the payments-api pod. In Hubble: `hubble observe --namespace payments --verdict DROPPED --protocol http` shows the rejected flows with HTTP method `POST` and a `POLICY_DENY` verdict — this makes the debugging immediate rather than requiring `tcpdump` on both pods. The fix: add a new `http` rule entry: `- method: "POST" path: "/api/v1/new-endpoint"`. Keeping the L7 policy tight (exact method + path) is intentional — a CiliumNetworkPolicy that allows all methods (`method: ".*"`) at the L7 level provides no more protection than a plain L4 NetworkPolicy. The value of L7 policies is precisely this level of granularity.</div>
</div>

---

## 5. Cilium ClusterMesh

ClusterMesh connects multiple Kubernetes clusters at the network level, enabling direct pod-to-pod communication across cluster boundaries without VPN tunnels or extra hops.

**Use cases:**
- **Active-active multi-region**: identical deployments in us-east-1 and eu-west-1; a client connects to either and the request is served locally
- **Database failover**: primary PostgreSQL in cluster-A, replica in cluster-B; if cluster-A goes down, cluster-B promotes and services in both clusters transparently fail over
- **Shared services**: a centralized monitoring or secrets management service in a dedicated cluster, accessed by workloads in multiple application clusters

**GlobalService** — a Kubernetes Service that spans clusters:

```yaml
# In both clusters — the annotation makes it global
apiVersion: v1
kind: Service
metadata:
  name: payments-api
  namespace: payments
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"   # expose this cluster's endpoints to others
spec:
  selector:
    app: payments-api
  ports:
    - port: 8080
```

With `global: true`, Cilium's control plane merges the endpoint lists from all clusters. A pod making a request to `payments-api:8080` in cluster-A gets load-balanced across pods in both cluster-A and cluster-B. Set `service.cilium.io/affinity: local` to prefer local-cluster endpoints and only cross clusters if all local endpoints are unhealthy.

**Setting up ClusterMesh:**

```bash
cilium clustermesh enable --service-type LoadBalancer
cilium clustermesh connect --destination-context cluster-b-kubeconfig
cilium clustermesh status --wait   # verifies connectivity between clusters
```

---

## 6. Hubble Deep Dive

Hubble is Cilium's built-in network observability layer — a per-node ring buffer of all flows processed by Cilium, queryable in real time without any application changes.

**Architecture:**
- **Hubble Observer** (per-node DaemonSet): reads Cilium's eBPF flow ring buffer, exposes a gRPC API
- **Hubble Relay**: aggregates flows from all nodes into a single endpoint
- **Hubble UI**: service map with live RED metrics per service pair

**Enable:**
```bash
helm upgrade cilium cilium/cilium \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

**Useful CLI queries:**
```bash
# All flows in the payments namespace
hubble observe --namespace payments --protocol tcp

# Show only dropped flows (policy violations)
hubble observe --verdict DROPPED --last 100

# Trace flows between specific pods
hubble observe --from-pod payments/checkout --to-pod payments/db

# HTTP flows with method + path
hubble observe --http-method POST --http-path /checkout

# JSON for scripting
hubble observe --verdict DROPPED --output json | jq '.flow.source.namespace'
```

**Hubble UI service map:** nodes = services, edges = live flows; click any edge to drill into individual flows with HTTP method, status code, and latency p99. Makes it immediately visible which services are communicating and whether any flows are policy-denied.

**Multi-cluster:** Hubble Relay aggregates across all clusters in a ClusterMesh — one `hubble observe` query spans all clusters.

---

## 7. CiliumNetworkPolicy Deep-Dive

Three policy layers, each more powerful than what standard K8s NetworkPolicy provides:

- **L3:** CIDR ranges (`toCIDR`), entity-based (`toEntity: world/cluster/host`), label-based
- **L4:** port + protocol under `toPorts`
- **L7:** HTTP method/path, DNS FQDN via `toFQDNs`

**Example — DNS-aware egress policy:**
```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: payments-egress
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: checkout
  egress:
  - toFQDNs:
    - matchName: "api.stripe.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      rules:
        http:
        - method: POST
          path: "/v1/charges"
  - toEndpoints:
    - matchLabels:
        app: postgres
    toPorts:
    - ports:
      - port: "5432"
        protocol: TCP
```

`CiliumClusterwideNetworkPolicy` — non-namespaced version, applies across all namespaces. Use for baseline deny-all + allow-DNS rules.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="k8s-np" class="active">K8s NetworkPolicy</button>
    <button data-tab="cilium-np">CiliumNetworkPolicy</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="k8s-np">
      <p><strong>Layers:</strong> L3/L4 only (IP + port)</p>
      <p><strong>Selection:</strong> label-based pod selectors, namespace selectors, CIDR</p>
      <p><strong>DNS:</strong> Not supported — cannot allow traffic to a DNS name</p>
      <p><strong>HTTP:</strong> Not supported — cannot enforce method or path</p>
      <p><strong>Scope:</strong> Namespaced only</p>
      <p><strong>Implemented by:</strong> whichever CNI is installed (Cilium, Calico, Flannel with policy add-on)</p>
    </div>
    <div class="tab-panel" data-tab-panel="cilium-np">
      <p><strong>Layers:</strong> L3/L4/L7 (HTTP method/path, gRPC, Kafka topic)</p>
      <p><strong>Selection:</strong> labels, CIDR, entity (world/cluster/host/init), DNS FQDN</p>
      <p><strong>DNS:</strong> <code>toFQDNs</code> intercepts DNS responses and pins the resolved IPs</p>
      <p><strong>HTTP:</strong> Enforce specific methods and path regexes at the policy layer</p>
      <p><strong>Scope:</strong> Namespaced (<code>CiliumNetworkPolicy</code>) or cluster-wide (<code>CiliumClusterwideNetworkPolicy</code>)</p>
      <p><strong>Requires:</strong> Cilium as CNI</p>
    </div>
  </div>
</div>

---

## 8. BGP Control Plane

For on-prem bare-metal clusters where pods need to be reachable from the broader network — a direct replacement for MetalLB.

**`CiliumBGPPeeringPolicy` CRD:**
```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: rack1-peering
spec:
  nodeSelector:
    matchLabels:
      rack: rack1
  virtualRouters:
  - localASN: 65001
    exportPodCIDR: true
    neighbors:
    - peerAddress: "10.0.0.1/32"
      peerASN: 65000
      gracefulRestart:
        enabled: true
        restartTimeSeconds: 120
```

Cilium advertises Pod CIDRs directly to TOR (top-of-rack) switches — no SNAT needed for pod-to-external traffic, pods are directly routable from the DC network.

**Check BGP session state:**
```bash
cilium bgp peers
# NAME          PEER-ADDRESS  PEER-ASN  SESSION-STATE  UPTIME
# rack1-peering  10.0.0.1      65000     Established    2d3h
```

**LB-IPAM:** Cilium allocates `LoadBalancer` IPs from a `CiliumLoadBalancerIPPool` and advertises them via BGP — true MetalLB replacement with no separate controller.

---

## 9. Gateway API Integration

Cilium implements the Kubernetes Gateway API (GA since v1.0) natively — no separate ingress controller needed.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: main-gateway
  namespace: default
spec:
  gatewayClassName: cilium
  listeners:
  - name: http
    port: 80
    protocol: HTTP
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-canary
spec:
  parentRefs:
  - name: main-gateway
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/payments
    backendRefs:
    - name: payments-svc
      port: 8080
      weight: 90
    - name: payments-svc-canary
      port: 8080
      weight: 10
```

Traffic splitting via `weight` in `backendRefs` — 10% to canary, 90% to stable. Cilium handles Ingress + Gateway API + L7 network policy in one CNI, no extra controllers.

---

## 10. Datapath Modes and kube-proxy Replacement

| Mode | iptables used | Performance | kube-proxy needed |
|---|---|---|---|
| veth (default) | Yes | Good | Optional (can replace) |
| ipvlan | Reduced | Better | Optional |
| eBPF host routing | **No** | **Best** | No |

**Enable full kube-proxy replacement + eBPF host routing:**
```yaml
# Helm values.yaml
kubeProxyReplacement: "strict"
routingMode: "native"
autoDirectNodeRoutes: true
bpf:
  masquerade: true
```

Verify: `cilium status | grep "KubeProxy replacement"` → `Strict`

With `routingMode: native`, Cilium intercepts NodePort traffic at the XDP or TC layer before packets hit netfilter — no conntrack overhead, O(1) BPF map lookup regardless of cluster size.

---

## 11. Troubleshooting

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active"><strong>Step 1. List endpoints.</strong><p><code>cilium endpoint list</code> — shows identity ID, policy enforcement status (enabled/disabled), and IP for every pod on the node. Confirm the source and destination pods have the expected identity labels.</p></div>
    <div class="stepper-panel"><strong>Step 2. Find dropped flows.</strong><p><code>hubble observe --verdict DROPPED --namespace &lt;ns&gt;</code> — shows source pod, destination pod, port, and drop reason (<code>POLICY_DENY</code>, <code>UNKNOWN_CONNECTION</code>). This is the fastest way to identify which policy is blocking traffic.</p></div>
    <div class="stepper-panel"><strong>Step 3. Simulate policy evaluation.</strong><p><code>cilium policy trace --src-endpoint &lt;id&gt; --dst-endpoint &lt;id&gt; --dport 5432</code> — simulates exactly what the policy engine decides for a specific flow. Shows the matching rule or explains why traffic is allowed/denied without needing to send real traffic.</p></div>
    <div class="stepper-panel"><strong>Step 4. Check identities.</strong><p><code>cilium identity list</code> — lists all Cilium identities and their label sets. Verify that source and destination pods produce the identity IDs your policy references. A mismatch here (wrong labels on a pod) is a common cause of unexpected policy behavior.</p></div>
    <div class="stepper-panel"><strong>Step 5. Debug IPAM.</strong><p><code>cilium node list</code> — shows per-node Pod CIDR allocations. IPAM pool exhaustion (no free CIDRs for new pods) causes pod scheduling failures unrelated to policy. Increase <code>clusterPoolIPv4PodCIDRList</code> in Helm values if exhausted.</p></div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Common issues:**
- **"Identity allocation failed"** — identity label set is too large (>32 labels); simplify pod labels or use `--labels` to filter which labels contribute to identity
- **"IPAM pool exhausted"** — add a node CIDR pool or increase `clusterPoolIPv4PodCIDRList`
- **"kube-proxy replacement strict but iptables rules exist"** — old kube-proxy DaemonSet still running: `kubectl delete ds kube-proxy -n kube-system`
- **DNS policy not working** — verify Cilium DNS proxy is running: `cilium monitor --type drop | grep dns`; `toFQDNs` requires Cilium to intercept DNS responses, so UDP/53 must be allowed to the cluster DNS

<div class="quiz-card"><p class="quiz-q">You want to allow your checkout service to make HTTPS calls to api.stripe.com but block all other external traffic. Which Cilium feature handles this, and why can't standard K8s NetworkPolicy do it?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>Use <code>toFQDNs</code> in a <code>CiliumNetworkPolicy</code>. Cilium's DNS proxy intercepts DNS responses, learns the resolved IPs for <code>api.stripe.com</code>, and allows only those IPs on port 443. Standard K8s NetworkPolicy operates only on static IP/CIDR/label selectors — it has no concept of DNS names. You'd either need to manually enumerate all of Stripe's IPs (which change) or allow all of <code>world</code> (which defeats the purpose). <code>toFQDNs</code> handles IP rotation automatically by tracking each DNS response.</div></div>

<div class="quiz-card"><p class="quiz-q">Why does Cilium's kube-proxy replacement improve performance compared to standard iptables-based kube-proxy at scale?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>kube-proxy builds iptables DNAT rules for every Service endpoint — iptables is evaluated linearly (O(n)), so performance degrades as rule count grows. A cluster with 10,000 Services and 5 endpoints each has 50,000+ rules; every packet traverses the list until it matches. Updating any Service requires locking and rewriting the entire ruleset, causing brief packet-processing pauses. Cilium's eBPF replacement uses BPF hash maps — O(1) lookup regardless of the number of Services. Map updates are atomic single-entry operations with no global lock. The performance gap becomes measurable in p99 latency at clusters with more than ~2,000 Services.</div></div>

<div class="quiz-card"><p class="quiz-q"><code>hubble observe --verdict DROPPED</code> shows flows from pod A to pod B being dropped. What is your next debugging step?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>Run <code>cilium policy trace --src-endpoint &lt;A-id&gt; --dst-endpoint &lt;B-id&gt; --dport &lt;port&gt;</code> to simulate exactly what the policy engine decides for that flow. This shows which rule (or missing rule) causes the drop faster than reading raw CiliumNetworkPolicy YAML. Then run <code>cilium endpoint list</code> to verify A and B have the expected identity labels — a wrong label on either pod means your policy selectors don't match, even if the YAML looks correct.</div></div>
