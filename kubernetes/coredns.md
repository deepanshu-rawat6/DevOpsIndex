# CoreDNS

CoreDNS is the cluster DNS server in every Kubernetes cluster since 1.13. It replaced kube-dns (dnsmasq + kubedns + sidecar). It runs as a Deployment in `kube-system`, fronted by a Service with a stable ClusterIP that all pods use for DNS.

Most sections below end with a quick knowledge check — track how many you've cleared as you go:

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## How Pod DNS Resolution Works

Every pod gets `/etc/resolv.conf` auto-injected by kubelet:

```
nameserver 10.96.0.10        ← CoreDNS ClusterIP
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

When a pod does `curl postgres`:

```mermaid
sequenceDiagram
    participant App as App (pod)
    participant R as libc resolver
    participant CD as CoreDNS

    App->>R: resolve "postgres"
    Note over R: ndots:5 — "postgres" has 0 dots < 5<br/>try search domains first
    R->>CD: postgres.default.svc.cluster.local?
    CD-->>R: 10.96.12.34 ✓ (if service exists)
    R-->>App: 10.96.12.34

    Note over R: If service didn't exist, it would continue:
    R->>CD: postgres.svc.cluster.local?
    CD-->>R: NXDOMAIN
    R->>CD: postgres.cluster.local?
    CD-->>R: NXDOMAIN
    R->>CD: postgres. (absolute)
    CD-->>R: NXDOMAIN
```

**Best case:** 1 DNS query (service found on first search domain).
**Worst case:** 4–5 queries for a name that doesn't exist as a K8s service.

Step through the same flow one hop at a time:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. App calls resolve("postgres").</strong> Zero dots in the name. <code>ndots:5</code> means "fewer than 5 dots → try every search domain before the name as-is."
    </div>
    <div class="stepper-panel">
      <strong>2. Try <code>postgres.default.svc.cluster.local</code>.</strong> This is the first, most specific entry in <code>/etc/resolv.conf</code>'s <code>search</code> line.
    </div>
    <div class="stepper-panel">
      <strong>3. Found?</strong> If the Service exists in this namespace, CoreDNS answers right here &mdash; <strong>1 query total</strong>, the best case.
    </div>
    <div class="stepper-panel">
      <strong>4. Not found — keep walking the search list.</strong> Next try <code>postgres.svc.cluster.local</code>, then <code>postgres.cluster.local</code>. Each miss is its own round trip to CoreDNS.
    </div>
    <div class="stepper-panel">
      <strong>5. Last resort — the absolute name.</strong> <code>postgres.</code> (trailing dot, no search) is tried last. If that also fails, the app gets NXDOMAIN &mdash; <strong>4–5 queries</strong> spent to find out the name doesn't exist anywhere.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A pod runs <code>curl postgres</code> and no <code>postgres</code> Service exists anywhere the search domains cover. How many DNS queries does CoreDNS answer before the app finally gets NXDOMAIN?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>4–5. "postgres" has 0 dots, which is fewer than <code>ndots:5</code>, so the resolver walks every search domain first &mdash; <code>default.svc.cluster.local</code>, then <code>svc.cluster.local</code>, then <code>cluster.local</code> &mdash; and only tries the bare absolute name last. Each of those is a separate round trip to CoreDNS, all before the app sees a single error.</div>
</div>

---

## The ndots:5 Problem

`ndots:5` means: if the hostname has **fewer than 5 dots**, the resolver tries all search domains before attempting the name as-is.

**Concrete example — `curl https://api.external.com/v1/data`:**
- `api.external.com` has 2 dots < 5
- Resolver tries: `api.external.com.default.svc.cluster.local` → NXDOMAIN
- Then: `api.external.com.svc.cluster.local` → NXDOMAIN
- Then: `api.external.com.cluster.local` → NXDOMAIN
- Finally: `api.external.com.` → answer

That's **4 DNS queries** for every outbound HTTPS call. At 1000 RPS this is 4000 DNS queries/sec extra load on CoreDNS.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. <code>api.external.com</code> — 2 dots.</strong> That's fewer than <code>ndots:5</code>, so the resolver assumes it could be a short cluster-local name and searches first, instead of just asking upstream directly.
    </div>
    <div class="stepper-panel">
      <strong>2. Try <code>api.external.com.default.svc.cluster.local</code>.</strong> Not a real name → NXDOMAIN.
    </div>
    <div class="stepper-panel">
      <strong>3. Try <code>api.external.com.svc.cluster.local</code>.</strong> Also NXDOMAIN.
    </div>
    <div class="stepper-panel">
      <strong>4. Try <code>api.external.com.cluster.local</code>.</strong> Also NXDOMAIN. Three wasted queries so far.
    </div>
    <div class="stepper-panel">
      <strong>5. Finally try <code>api.external.com.</code> (absolute).</strong> This one actually gets answered. 4 queries spent to resolve a name that was never going to be a cluster Service in the first place.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

### Fixes

**Fix 1 — Use FQDN (trailing dot):**
```bash
# In app config: always use FQDN for K8s services
postgres.default.svc.cluster.local.   # trailing dot = absolute, no search
```

**Fix 2 — Reduce ndots in pod spec:**
```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"   # only search if fewer than 2 dots
  # Now "postgres" still searches (0 dots < 2)
  # But "api.external.com" (2 dots) goes direct — no search domain iteration
```

**Fix 3 — Use fully qualified service names in app config:**
```
DB_HOST=postgres.default.svc.cluster.local
```

<div class="quiz-card">
  <p class="quiz-q">You apply Fix 2 and set <code>ndots: 2</code> in a pod's <code>dnsConfig</code>. Does <code>curl postgres</code> (a same-namespace Service name) still resolve correctly?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Yes. "postgres" has 0 dots, which is still fewer than the new threshold of 2, so it still walks the search domains as before. Only names with 2 or more dots &mdash; like <code>api.external.com</code> &mdash; skip straight to being queried as-is, which is exactly the case Fix 2 is meant to short-circuit.</div>
</div>

---

## Corefile — CoreDNS Configuration

CoreDNS config lives in a ConfigMap:

```bash
kubectl get configmap coredns -n kube-system -o yaml
```

Default Corefile:

```
.:53 {
    errors                        # log errors to stdout
    health {                      # /health endpoint on :8080
       lameduck 5s                # wait 5s after marking unhealthy before shutting down
    }
    ready                         # /ready endpoint on :8181 — returns 200 when all plugins ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {  # handle cluster.local DNS
       pods insecure              # enable pod DNS records (insecure = no verification)
       fallthrough in-addr.arpa ip6.arpa  # pass reverse lookups to next plugin
       ttl 30                     # TTL for cluster.local records
    }
    prometheus :9153              # expose metrics at /metrics
    forward . /etc/resolv.conf {  # forward non-cluster queries to node's resolver
       max_concurrent 1000
    }
    cache 30                      # cache all responses for 30s
    loop                          # detect forwarding loops, panic if found
    reload                        # hot-reload Corefile on ConfigMap change
    loadbalance                   # round-robin DNS (randomize A record order)
}
```

### Plugin reference

| Plugin | Purpose |
|--------|---------|
| `errors` | Log error responses |
| `health` | Liveness endpoint `/health` on :8080 |
| `ready` | Readiness endpoint `/ready` on :8181 |
| `kubernetes` | Serve DNS for cluster services/pods |
| `prometheus` | Metrics endpoint :9153 |
| `forward` | Forward upstream queries |
| `cache` | Response caching with TTL |
| `loop` | Detect + break forwarding loops |
| `reload` | Watch ConfigMap, hot-reload without restart |
| `loadbalance` | Randomize record order for basic LB |

<div class="quiz-card">
  <p class="quiz-q">What's the actual difference between the <code>health</code> and <code>ready</code> plugins on a CoreDNS pod?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>health</code> is a liveness check on :8080 &mdash; is the CoreDNS process itself alive (with a <code>lameduck</code> grace period before it actually shuts down). <code>ready</code> is a separate readiness check on :8181 that only returns 200 once every configured plugin is ready to serve. A CoreDNS pod can be alive (pass <code>health</code>) for a moment before it's actually ready to answer queries correctly.</div>
</div>

---

## Custom Forwarding

Forward a specific domain to an internal DNS server:

```
.:53 {
    errors
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    # Forward corp.example.com to internal DNS
    forward corp.example.com 10.0.1.53 {
        prefer_udp
    }
    # Forward everything else to public resolvers
    forward . 8.8.8.8 8.8.4.4 {
        max_concurrent 1000
        health_check 5s
    }
    cache 30
    loop
    reload
    loadbalance
}
```

```bash
# Apply the new ConfigMap — reload plugin picks it up automatically
kubectl apply -f coredns-configmap.yaml
# Verify reload happened:
kubectl logs -n kube-system -l k8s-app=kube-dns | grep "Reloading"
```

---

## Caching

The `cache` plugin caches all DNS responses in memory.

```
cache 30          # 30s TTL for positive responses, 15s for NXDOMAIN (half of positive)
# or
cache {
    success 9984 300 60    # max entries, max TTL, min TTL for positive
    denial 9984 300 5      # max entries, max TTL, min TTL for NXDOMAIN
    prefetch 10 1m 10%     # prefetch entries accessed >10 times before 10% of TTL remains
}
```

**Effect:** `service.namespace.svc.cluster.local` first lookup hits K8s API → cached for 30s → subsequent lookups served from memory without hitting API server.

<div class="quiz-card">
  <p class="quiz-q">With the simple form <code>cache 30</code>, are NXDOMAIN (negative) responses cached for the same 30s as successful ones?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — negative responses are cached for half the positive TTL, so 15s here. A "not found" answer expires faster than a real one, which matters during the ndots search-domain walk from earlier: each of those NXDOMAINs along the way gets cached too, just for a shorter window.</div>
</div>

---

## dnsPolicy Options

| Policy | Behaviour |
|--------|---------|
| `ClusterFirst` (default) | Use CoreDNS. Non-cluster names forwarded upstream. |
| `ClusterFirstWithHostNet` | Same as ClusterFirst but for pods using `hostNetwork: true` |
| `Default` | Use the **node's** `/etc/resolv.conf` — no cluster DNS |
| `None` | No DNS config injected — you must set `dnsConfig` manually |

Flip through what each one actually means for the pod:

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="clusterfirst" class="active state-ok">ClusterFirst</button>
    <button data-toggle-opt="hostnet" class="state-ok">ClusterFirstWithHostNet</button>
    <button data-toggle-opt="default" class="state-warn">Default</button>
    <button data-toggle-opt="none" class="state-bad">None</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="clusterfirst">
    <strong>The normal case.</strong> The pod uses CoreDNS for resolution. Anything that isn't a cluster-local Service or Pod name gets forwarded upstream by CoreDNS's own <code>forward</code> plugin. This is what almost every pod runs, whether it's set explicitly or just inherited as the default.
  </div>
  <div class="toggle-panel" data-toggle-panel="hostnet">
    <strong>Same as ClusterFirst</strong> &mdash; just the variant for pods running with <code>hostNetwork: true</code>. It exists so a host-networked pod still gets cluster DNS instead of falling back to the node's own resolver.
  </div>
  <div class="toggle-panel" data-toggle-panel="default">
    <strong>Despite the name, not the cluster default.</strong> This tells the pod to inherit the <strong>node's</strong> <code>/etc/resolv.conf</code> directly &mdash; CoreDNS is bypassed entirely. Service names like <code>postgres.default.svc.cluster.local</code> will not resolve under this policy.
  </div>
  <div class="toggle-panel" data-toggle-panel="none">
    <strong>Nothing injected at all.</strong> kubelet writes no <code>/etc/resolv.conf</code> for you. Unless the pod spec also supplies <code>dnsConfig</code> with its own <code>nameservers</code>/<code>searches</code>/<code>options</code>, the pod has no working DNS whatsoever.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Does <code>dnsPolicy: Default</code> give a pod the cluster's normal DNS behavior?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No &mdash; it's the most misleading name in the table. <code>Default</code> means "use the <strong>node's</strong> <code>/etc/resolv.conf</code>," which bypasses CoreDNS and cluster DNS completely. The policy that actually gives normal cluster DNS behavior is <code>ClusterFirst</code>, which is what nearly every pod runs whether or not it's set explicitly.</div>
</div>

```yaml
spec:
  dnsPolicy: "None"
  dnsConfig:
    nameservers:
      - 10.96.0.10
    searches:
      - svc.cluster.local
      - cluster.local
    options:
      - name: ndots
        value: "2"
      - name: timeout
        value: "2"
      - name: attempts
        value: "3"
```

---

## Scaling CoreDNS

Default: 2 replicas. Under heavy load you'll see CoreDNS CPU spike and DNS latency rise.

```bash
# Scale manually
kubectl scale deployment coredns -n kube-system --replicas=4

# Or use CoreDNS Autoscaler (proportional to nodes/cores)
kubectl get configmap coredns-autoscaler -n kube-system -o yaml
# Data: {"linear":{"coresPerReplica":256,"nodesPerReplica":16,"min":2}}
```

**Anti-affinity** (spread replicas across nodes — do not let both CoreDNS pods land on same node):
```yaml
# Already set by default in most clusters — verify:
kubectl get deployment coredns -n kube-system -o jsonpath='{.spec.template.spec.affinity}'
```

<div class="quiz-card">
  <p class="quiz-q">Why does it matter whether CoreDNS's 2 replicas land on the same node or on different nodes?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Without anti-affinity spreading them out, both replicas can land on the same node — and losing that one node takes out 100% of CoreDNS capacity at once, breaking DNS resolution cluster-wide. Spread across two different nodes, losing one node only removes half the capacity; the other replica keeps serving while the first reschedules.</div>
</div>

---

## Debugging DNS

```bash
# Test from inside a pod
kubectl run dnstest --rm -it --image=busybox --restart=Never -- sh
nslookup kubernetes                           # should resolve
nslookup my-svc.my-namespace.svc.cluster.local
nslookup google.com                           # external resolution

# Check resolv.conf
kubectl exec <pod> -- cat /etc/resolv.conf

# CoreDNS logs (set log plugin in Corefile to enable query logging)
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100

# CoreDNS metrics (if Prometheus is scraping)
# coredns_dns_requests_total
# coredns_dns_responses_total{rcode="NXDOMAIN"}
# coredns_forward_requests_duration_seconds_bucket

# Check CoreDNS pod health
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl describe pod -n kube-system -l k8s-app=kube-dns

# Validate ConfigMap syntax before applying
docker run --rm -v $(pwd)/Corefile:/Corefile coredns/coredns:1.11.1 -conf /Corefile -dryrun
```

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| 5s timeout on DNS then success | UDP packet dropped, resolver retries after 5s timeout | Check conntrack table full: `sysctl net.netfilter.nf_conntrack_max`; use TCP for DNS |
| NXDOMAIN storm | App retrying DNS in tight loop on failure | Fix app to cache NXDOMAIN, use exponential backoff |
| CoreDNS OOMKilled | Too many cached entries or high QPS | Increase memory limit; reduce cache size; scale replicas |
| `dial tcp: lookup X: no such host` | Service doesn't exist, or wrong namespace in FQDN | `kubectl get svc -A | grep X` |
| DNS works locally, fails in pod | NetworkPolicy blocks UDP/TCP 53 to kube-dns | Add egress rule: allow UDP 53 to `kube-system` namespace |

**conntrack full → 5s DNS timeout** — this is the most insidious:
```bash
# On the node:
sysctl net.netfilter.nf_conntrack_count
sysctl net.netfilter.nf_conntrack_max
# If count ≈ max: table full, new UDP flows dropped → 5s timeout

# Fix: increase nf_conntrack_max
sysctl -w net.netfilter.nf_conntrack_max=1048576
# Or: use nodeLocalDNS cache (runs on every node, uses link-local IP, bypasses conntrack)
```

**NodeLocal DNSCache** — the best fix for DNS at scale. Each node runs a DNS cache DaemonSet on a link-local IP (`169.254.20.10`); pods resolve to this local cache first, with no conntrack entry and no network hop involved. Only a cache miss actually reaches CoreDNS:

```mermaid
graph LR
    Pod["Pod"] -->|DNS query, local IP<br/>no conntrack, no network hop| Local["NodeLocal DNSCache<br/>DaemonSet on 169.254.20.10"]
    Local -->|cache hit| Pod
    Local -->|cache miss| CD["CoreDNS"]
    CD -->|answer, cached locally| Local

    style Local fill:#4f8fcf,stroke:#274b6e,color:#fff
```

Reduces CoreDNS load by ~60–80%.

<div class="quiz-card">
  <p class="quiz-q">A pod's DNS lookups intermittently take ~5 seconds before eventually succeeding. What's the most likely root cause, and why does it look like a timeout instead of an instant failure?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The node's conntrack table is full. New UDP DNS flows get silently dropped rather than rejected with an error, so the resolver has no signal to retry immediately &mdash; it just sits out its own timeout (5s) before trying again, which succeeds once the table has room. Confirm with <code>nf_conntrack_count</code> vs <code>nf_conntrack_max</code>; NodeLocal DNSCache sidesteps the problem entirely, since pod-to-local-cache traffic never touches conntrack.</div>
</div>
