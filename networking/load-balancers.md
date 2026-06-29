# Load Balancers — Deep Dive

Beginner to advanced reference covering L4/L7, algorithms, health checks, TLS, AWS ALB/NLB, GCP, nginx, HAProxy, and common failure modes.

---

## 1. What a Load Balancer Does

A load balancer sits between clients and backend servers and provides:

- **Traffic distribution** — spread requests across a pool of backends
- **Health checking** — remove unhealthy backends from rotation automatically
- **TLS termination** — decrypt HTTPS at the LB so backends speak plain HTTP
- **Backend topology hiding** — clients see one VIP; backend IPs are never exposed
- **Connection management** — keep persistent upstream pools, draining on deploys

---

## 2. L4 vs L7

| | L4 (Transport Layer) | L7 (Application Layer) |
|---|---|---|
| OSI layer | 4 (TCP/UDP) | 7 (HTTP/gRPC/WebSocket) |
| What it sees | IP, port, TCP flags | HTTP headers, path, host, cookies, body |
| Routing decision | IP:port only | path, host, header, query string |
| Model | NAT / DNAT — rewrites dst IP | Full proxy — two separate TCP connections |
| TLS | Passthrough or offload (opaque) | Terminate and inspect |
| Performance | Ultra-low latency, millions of conns | Higher latency, richer routing |
| State | Stateless (ECMP) or conntrack | Per-request state |
| Use when | Raw TCP, UDP, SMTP, custom protocols | HTTP APIs, WebSocket, gRPC, content routing |

### NAT vs Proxy Model

**L4 NAT/DNAT**: The LB rewrites the destination IP in each packet. The backend server's reply goes back via the LB (SNAT) or directly to the client (DSR). One TCP connection end-to-end.

**L7 Proxy**: The LB terminates the client TCP connection, parses HTTP, and opens a *new* TCP connection to the backend. Two connections exist simultaneously.

---

## 3. L4 vs L7 — Mermaid Diagram

```mermaid
graph TD
    subgraph L4_LB["L4 LB — TCP Passthrough with DNAT"]
        C1[Client] -->|TCP SYN dst 10.0.0.1:443| LB4[L4 Load Balancer]
        LB4 -->|DNAT: dst rewritten to 10.0.1.2:443| B1[Backend 1]
        LB4 -->|DNAT: dst rewritten to 10.0.1.3:443| B2[Backend 2]
    end

    subgraph L7_LB["L7 LB — Full HTTP Proxy"]
        C2[Client] -->|TCP conn 1 HTTPS| LB7[L7 Load Balancer]
        LB7 -->|TLS termination inspect HTTP headers path host| LB7
        LB7 -->|TCP conn 2 HTTP to backend| B3[Backend A]
        LB7 -->|TCP conn 2 HTTP to backend| B4[Backend B]
    end
```

---

## 4. Load Balancing Algorithms

### Round Robin
Requests sent to backends in order: 1 → 2 → 3 → 1 → 2 → 3 …

**Use when**: backends are homogeneous and requests are equal-cost.

### Weighted Round Robin
Each backend gets a weight. Backend with weight 3 gets 3× the traffic of weight 1.

**Use when**: backends have different capacity (e.g., mixing instance types).

### Least Connections
New request goes to the backend with the fewest active connections.

**Use when**: requests have variable duration (e.g., long-running uploads mixed with fast API calls).

### Least Response Time
Combines least connections + lowest measured latency.

**Use when**: latency variance across backends matters (heterogeneous hardware, cross-AZ).

### IP Hash (Sticky by IP)
Hash of client IP determines the backend. Same client always hits the same backend.

**Use when**: need session affinity without cookie support. Breaks badly behind NAT (all traffic → one backend).

### Random
Randomly pick a backend per request.

**Use when**: simple, stateless workloads where you want to avoid round-robin bias from burst patterns. "Power of two choices" (random pick of 2, take least-loaded) is better than pure random.

### Consistent Hashing
Hash the request key (IP, URL, user-id) onto a ring. Backends occupy slots on the ring. Adding/removing a backend only remaps ~1/N of keys.

**Use when**: caching layers (upstream cache hit rate), gRPC streams that must go to the same pod, Kafka-aware routing.

---

## 5. Health Checks

### Active Health Checks

The LB probes backends on a schedule, independent of real traffic.

| Type | Mechanism | Use when |
|---|---|---|
| HTTP | GET /healthz, expect 2xx | HTTP services |
| TCP connect | 3-way handshake only | Non-HTTP (DB, custom TCP) |
| gRPC | `grpc.health.v1.Health/Check` | gRPC services |

Key parameters:
- **interval** — how often to probe (e.g., 10s)
- **timeout** — how long to wait for a response (e.g., 5s)
- **unhealthy threshold** — consecutive failures before marking down (e.g., 2)
- **healthy threshold** — consecutive successes before marking up (e.g., 3)
- **grace period** — time after startup before health checks are enforced (avoids killing pods during JVM warm-up)

### Passive Health Checks (Circuit Breaker)

Watch real traffic error rates. If backend returns 5xx above threshold, eject it from the pool for a cooldown window.

**Use when**: active probing misses transient errors (a backend is up but throwing errors for a specific endpoint).

Envoy / Istio call this **outlier detection**: consecutive 5xx count → eject for `base_ejection_time` (doubles each ejection).

---

## 6. Sticky Sessions

### Cookie-Based (Preferred)

**LB-generated cookie**: LB inserts a cookie (e.g., `AWSALB`) on first response, encodes the target backend. On subsequent requests LB reads cookie → routes to same backend.

**App-generated cookie**: App sets a session cookie; LB reads it and hashes it to a backend.

### IP Hash

See §4. Unreliable behind NAT or IPv6 CGNAT.

### Why Sticky Sessions Are Problematic

- **Uneven load**: one sticky client can hammer one backend (e.g., long-running WebSocket or batch job)
- **Failover loses session**: if the sticky backend dies, the session is gone — unless app replicates session to Redis/DB
- **Defeats autoscaling**: new backends receive no traffic from existing sticky clients
- **Recommendation**: prefer stateless services + external session store (Redis/DynamoDB) over sticky sessions

---

## 7. Connection Draining / Deregistration Delay

### Why It Exists

When a backend is removed from the pool (deploy, scale-down, health failure), in-flight requests are mid-stream. Killing the connection immediately → client gets a 502/reset.

### How It Works

```mermaid
sequenceDiagram
    participant Client
    participant LB
    participant Backend

    Note over Backend: Marked for removal
    LB->>LB: Stop sending NEW requests to Backend
    Client->>LB: In-flight request (already routed)
    LB->>Backend: Forward in-flight request
    Backend->>LB: Response
    LB->>Client: Response
    Note over LB: Draining timeout expires (e.g. 30s)
    LB->>Backend: Close connection
```

1. LB marks backend as **draining** — no new requests
2. Existing in-flight requests complete normally
3. After **deregistration delay** (default 300s on ALB, tune to 30s for fast deploys), LB forcefully closes remaining connections

**Tune to**: slightly above your p99 request duration. 30s is usually enough for APIs; leave 300s for long-running uploads.

---

## 8. TLS Termination

### Terminate at LB (Most Common)

```
Client ──HTTPS──► LB (terminate) ──HTTP──► Backend
```

- LB holds the certificate
- Backends get plain HTTP → simpler backend config
- LB can inspect HTTP headers, do content routing
- Traffic on the internal network is unencrypted (acceptable inside VPC/private network with security groups)

### SSL Passthrough

```
Client ──HTTPS──► L4 LB (SNI routing only) ──HTTPS──► Backend
```

- LB never decrypts — forwards TLS bytes to backend
- Backend holds the cert
- LB cannot do L7 routing (only SNI hostname)
- Use when: compliance requires end-to-end encryption, or backend must see client cert

### SSL Bridge (Re-encrypt)

```
Client ──HTTPS──► LB (terminate + re-encrypt) ──HTTPS──► Backend
```

- LB terminates, inspects, then opens new TLS connection to backend
- Use when: internal traffic must also be encrypted (zero-trust), and L7 routing is needed

### mTLS (Service-to-Service)

Both client and server present certificates. LB validates the client cert (or forwards it as a header).

```
Service A ──mTLS──► Istio sidecar ──mTLS──► Service B sidecar
```

Used in service meshes (Istio, Linkerd) for pod-to-pod authentication without application code changes.

---

## 9. AWS ALB Deep Dive

### Architecture

```mermaid
graph LR
    Client -->|HTTPS| ALB[ALB Listener port 443]
    ALB -->|Rule: path /api/*| TG1[Target Group API pods]
    ALB -->|Rule: path /static/*| TG2[Target Group S3 Lambda]
    ALB -->|Rule: host app2.example.com| TG3[Target Group App2]
    ALB -->|Default rule| TG4[Target Group Default]
```

### Listeners, Rules, Target Groups

- **Listener**: protocol + port (HTTP:80, HTTPS:443). Each listener has ordered rules.
- **Rule conditions**: path pattern, host header, HTTP header, HTTP method, query string, source IP
- **Rule actions**: forward, redirect, fixed response, authenticate (Cognito/OIDC), weighted forward (canary)
- **Target group**: EC2 instances, IP addresses (pods), Lambda functions, ALB (nested)

### Content-Based Routing Examples

```
Rule 1: host = api.example.com AND path = /v2/* → TG_v2 (canary 10%) + TG_v1 (90%)
Rule 2: path = /health                           → fixed 200
Rule 3: header X-Beta = true                     → TG_beta
Default:                                         → TG_main
```

### Protocol Support

| Feature | Supported |
|---|---|
| HTTP/1.1 | Yes |
| HTTP/2 | Yes (between client and ALB; ALB → backend is HTTP/1.1 by default) |
| WebSocket | Yes (upgrade header preserved) |
| gRPC | Yes (set target group protocol version to gRPC) |
| Lambda | Yes (synchronous invoke, payload size limit 1MB) |
| WAF | Yes (attach AWS WAF web ACL to ALB) |

### Access Logs

Enable per-listener to S3. Fields include: client IP, timestamp, target IP, request processing time, target processing time, response time, status codes, SSL cipher, user-agent, request ID.

---

## 10. AWS NLB Deep Dive

### Key Properties

- **Layer 4** — TCP, UDP, TLS protocols
- **Static IPs per AZ** — one Elastic IP per AZ. Safe to whitelist in firewalls (ALB IPs change).
- **Preserve client IP** — unlike ALB (which replaces src IP), NLB passes the real client IP to the backend (security group must allow it)
- **Ultra-low latency** — no HTTP parsing overhead; millions of requests/second
- **TLS offload** — NLB can terminate TLS (similar to ALB), with ACM certificates
- **UDP** — useful for DNS, syslog, game servers
- **PrivateLink** — expose a service to another VPC/account via NLB without VPC peering

### NLB vs ALB Decision

```
Need content-based routing?      → ALB
Need static IP?                  → NLB
Need UDP?                        → NLB
Need PrivateLink endpoint?       → NLB
Need WAF?                        → ALB
Need Lambda target?              → ALB
Raw TCP performance matters?     → NLB
```

---

## 11. GCP Cloud Load Balancing

### Global Anycast LB

GCP's external HTTP(S) LB is **global** — a single IP is announced from all Google PoPs worldwide via Anycast BGP. Traffic is terminated at the nearest Google edge, then forwarded over Google's private backbone to backends.

```mermaid
graph TD
    UserUS[User US East] -->|Anycast 34.x.x.x| PoP_NY[Google PoP New York]
    UserEU[User EU West] -->|Anycast 34.x.x.x| PoP_AM[Google PoP Amsterdam]
    PoP_NY -->|Google backbone| BS[Backend Service us-central1]
    PoP_AM -->|Google backbone| BS2[Backend Service europe-west1]
```

### Components

| Component | Purpose |
|---|---|
| Forwarding Rule | IP:port → Target Proxy |
| Target HTTP(S) Proxy | Terminates TLS, applies URL map |
| URL Map | Host/path rules → Backend Service |
| Backend Service | Health checks + backends (instance groups / NEGs) |
| Backend Bucket | Route to GCS bucket directly |

### URL Map Example

```yaml
# host: api.example.com path: /v1/* → backend-service-v1
# host: api.example.com path: /v2/* → backend-service-v2
# default → backend-service-main
```

### NEGs — Network Endpoint Groups

NEGs decouple the LB from instance groups. Instead of routing to a VM, the LB routes to an **endpoint** (IP:port).

| NEG Type | Backends |
|---|---|
| GCE_VM_IP_PORT | GCE VM primary/secondary IPs — pod-level routing in GKE |
| Zonal GKE | Kubernetes pods via container-native LB |
| Serverless | Cloud Run, App Engine, Cloud Functions |
| Internet NEG | External hostname:port (third-party SaaS) |
| Private Service Connect | Internal services via PSC |

**Container-native LB** (GKE + zonal NEG): traffic goes directly to pods, bypassing kube-proxy iptables. Lower latency, accurate health checks at pod level.

### Premium vs Standard Tier

| | Premium | Standard |
|---|---|---|
| Routing | Google global backbone (Anycast) | Public internet from regional PoP |
| Scope | Global LB | Regional LB only |
| Latency | Lower (closest PoP → backbone) | Higher (ISP routing) |
| Cost | Higher | Lower |
| Use when | Global user base, latency-sensitive | Single-region, cost-sensitive |

---

## 12. nginx as Load Balancer

### Basic Upstream Config

```nginx
upstream backend_pool {
    least_conn;                          # algorithm: least connections
    keepalive 32;                        # idle keepalive connections to upstream

    server 10.0.1.1:8080 weight=3;
    server 10.0.1.2:8080 weight=1;
    server 10.0.1.3:8080 backup;        # only used if others are down
}

server {
    listen 80;
    worker_processes auto;              # one worker per CPU core

    location / {
        proxy_pass         http://backend_pool;
        proxy_http_version 1.1;
        proxy_set_header   Connection "";     # enable keepalive to upstream
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_connect_timeout 5s;
        proxy_read_timeout    60s;
    }
}
```

### Health Checks

nginx OSS has **passive** health checks only (marks backend down after failed proxy attempts):

```nginx
upstream backend_pool {
    server 10.0.1.1:8080 max_fails=3 fail_timeout=30s;
}
```

nginx Plus (commercial) adds active health checks:

```nginx
# nginx Plus only
upstream backend_pool {
    zone backend 64k;
    server 10.0.1.1:8080;
    health_check interval=10s fails=2 passes=3 uri=/healthz;
}
```

**Community workaround**: use `nginx_upstream_check_module` (Tengine patch) or route health check via a separate Lua block.

---

## 13. HAProxy

### Config Structure

```
global
    maxconn     50000
    nbthread    4          # one thread per CPU

defaults
    mode        http
    timeout connect 5s
    timeout client  30s
    timeout server  30s
    option      redispatch        # retry on another server if connection fails
    retries     3

frontend http_in
    bind *:80
    bind *:443 ssl crt /etc/haproxy/certs/example.pem
    acl is_api  path_beg /api/
    acl is_beta hdr(X-Beta) -i true
    use_backend api_pool  if is_api
    use_backend beta_pool if is_beta
    default_backend web_pool

backend api_pool
    balance leastconn
    option  httpchk GET /healthz
    server  api1 10.0.1.1:8080 check inter 10s fall 2 rise 3
    server  api2 10.0.1.2:8080 check inter 10s fall 2 rise 3

backend web_pool
    balance roundrobin
    cookie  SERVERID insert indirect nocache
    server  web1 10.0.2.1:8080 check cookie web1
    server  web2 10.0.2.2:8080 check cookie web2
```

### Stick Tables (Sticky Sessions without Cookies)

```haproxy
backend api_pool
    stick-table type ip size 100k expire 30m
    stick on src                  # route same src IP to same server
```

### Stats Page

```haproxy
frontend stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:secret
```

### ACLs

HAProxy ACLs are powerful pattern-matching on any request attribute:

```haproxy
acl is_mobile   hdr_sub(User-Agent) -i mobile
acl large_body  req.body_size gt 1048576
acl safe_method method GET HEAD OPTIONS
```

---

## 14. Comparison Table

| | AWS ALB | AWS NLB | GCP GLB | nginx | HAProxy |
|---|---|---|---|---|---|
| **OSI Layer** | L7 | L4 | L4+L7 | L7 (stream for L4) | L4+L7 |
| **Protocols** | HTTP/1.1, HTTP/2, WebSocket, gRPC | TCP, UDP, TLS | HTTP/1.1, HTTP/2, WebSocket, gRPC, TCP | HTTP, TCP (stream) | HTTP, TCP, UDP |
| **Static IP** | No (DNS only) | Yes (EIP per AZ) | No (Anycast VIP) | Yes (host IP) | Yes (host IP) |
| **WebSocket** | Yes | Yes (TCP passthrough) | Yes | Yes | Yes |
| **Content routing** | Yes (rich rule engine) | No | Yes (URL map) | Yes (location blocks) | Yes (ACLs) |
| **Autoscaling** | Managed, auto | Managed, auto | Managed, global | Manual / K8s HPA | Manual / K8s HPA |
| **Health checks** | HTTP, HTTPS, gRPC, TCP | TCP, HTTP, HTTPS | HTTP, HTTPS, TCP, gRPC | Passive (Plus: active) | Active (HTTP, TCP) |
| **Sticky sessions** | Cookie (AWSALB) | No | Cookie | ip_hash / sticky module | Cookie, stick-table |
| **WAF** | Yes (AWS WAF) | No | Yes (Cloud Armor) | Plus / ModSecurity | No (external) |
| **mTLS** | Yes (mutual auth) | Yes (TLS passthrough) | Yes | Yes | Yes |
| **Price model** | Hourly + LCU | Hourly + NLCU | Hourly + forwarding rules + data | Free (OSS) | Free (OSS) |
| **Best for** | AWS HTTP workloads | AWS TCP/UDP, PrivateLink | GCP global apps | On-prem, K8s ingress | On-prem, high-perf TCP |

---

## 15. Common Issues

### 502 Bad Gateway

LB received an invalid or empty response from backend.

**Causes**:
- Backend process crashed or not listening on the target port
- Backend returned a response the LB couldn't parse (protocol mismatch — e.g., backend sent HTTP/2 but LB expected HTTP/1.1)
- Backend closed the connection before sending a response (idle timeout race)
- Health check passes but app throws 502 for the specific path

**Debug**:
```bash
# Check backend is actually listening
ss -tlnp | grep :8080

# Check ALB access logs for target_status_code
aws s3 cp s3://my-alb-logs/... - | grep ' 502 '

# curl directly to backend IP bypassing LB
curl -v http://10.0.1.1:8080/api/healthz
```

### 504 Gateway Timeout

LB timed out waiting for the backend to respond.

**Causes**:
- Slow database query, external API call, or CPU-bound operation
- LB idle timeout < request processing time (ALB default: 60s)
- Backend threadpool exhausted, requests queued

**Fix**:
```bash
# Increase ALB idle timeout if request legitimately takes longer
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn arn:... \
  --attributes Key=idle_timeout.timeout_seconds,Value=120
```

### Thundering Herd on Deploy

When a new deployment starts, all LBs simultaneously shift traffic to new pods. If new pods are slow to warm up (JVM, model loading), they get overwhelmed.

**Fix**:
- Use **readiness probes** — pod not added to LB until `/readyz` returns 200
- Use **minReadySeconds** on Deployment — wait N seconds after pod Ready before counting it as available
- Use **slow start** (nginx: `slow_start=30s` per upstream server; HAProxy: `slowstart`)
- Canary deploy — send 5% traffic to new pods first

### Connection Reset on Draining

Backend removed from pool while client had an established persistent connection → `Connection reset by peer` or `ECONNRESET`.

**Fix**:
- Set `deregistration_delay` long enough for in-flight requests to complete
- Backends should handle `SIGTERM` gracefully: stop accepting new connections, finish in-flight, then exit
- Set `connection: close` header in final responses during shutdown

```go
// Go graceful shutdown
srv.Shutdown(context.WithTimeout(ctx, 30*time.Second))
```

### Asymmetric Routing with NLB

NLB passes the real client IP (src IP preserved). If the backend's response route does not go back through the NLB (e.g., backend has a default route pointing to a different gateway), TCP session breaks because the client sees an unexpected source IP for the return packet.

**Fix**:
- Ensure backend instances route traffic destined to the client *back through* the NLB or same path
- Or enable **source NAT on NLB** (NLB target group: `preserve_client_ip = false`) — but you lose the real client IP
- Use security groups that allow the NLB's IP range, not just client IPs

---

## Read Order

For networking context: [osi-model.md](./osi-model.md) → [tcp-udp.md](./tcp-udp.md) → [tls-encryption.md](./tls-encryption.md) → this file

For Kubernetes LB internals: [../kubernetes/kube-proxy-modes.md](../kubernetes/kube-proxy-modes.md) → [../kubernetes/networking.md](../kubernetes/networking.md)

For AWS-specific: [../aws/request-flow-alb-to-pod.md](../aws/request-flow-alb-to-pod.md) → [../aws/README.md](../aws/README.md)
