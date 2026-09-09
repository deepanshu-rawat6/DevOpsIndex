# Networking

Core networking concepts for backend engineers and platform engineers — from physical bits to application protocols.

## Files

| File | Topics |
|------|--------|
| [osi-model.md](./osi-model.md) | 7 OSI layers, full HTTPS request flow (curl google.com), encapsulation/decapsulation, debugging by layer |
| [tcp-udp.md](./tcp-udp.md) | TCP 3-way handshake, 4-way teardown, state machine, flow control, congestion control (CUBIC/BBR), TIME_WAIT, UDP, when to use each |
| [tls-encryption.md](./tls-encryption.md) | Symmetric vs asymmetric, SSL history, TLS 1.2 (2 RTT), TLS 1.3 (1 RTT), certificate chain, certificate validation, debugging with openssl |
| [acme-certificate-automation.md](./acme-certificate-automation.md) | PEM file format, ACME protocol (RFC 8555) lifecycle, HTTP-01 vs DNS-01, wildcard certs, acme.sh/certbot/lego/cert-manager, ECC vs RSA, Google Trust Services/EAB |
| [http-versions.md](./http-versions.md) | HTTP/1.0 → HTTP/3, HOL blocking, binary framing, status codes, methods, important headers, caching (ETag), CORS, QUIC wire-level mechanics, WebSocket upgrade handshake/frame format |
| [grpc-graphql.md](./grpc-graphql.md) | gRPC architecture, Protobuf encoding, 4 streaming modes, connection flow, status codes; GraphQL SDL, query vs REST, N+1, DataLoader |
| [grpc-deep-dive.md](./grpc-deep-dive.md) | Protobuf wire format internals, all 4 streaming modes with full code, interceptors, deadline propagation, health checking, client-side load balancing, gRPC-Web, error code mapping |
| [linux-networking.md](./linux-networking.md) | Linux packet RX/TX path, netfilter hooks, conntrack, network namespaces, veth pairs, SO_REUSEPORT, debugging commands |
| [bgp-routing.md](./bgp-routing.md) | Autonomous systems, path-vector routing and path selection (LOCAL_PREF/AS-PATH/MED), why anycast works, route leaks/hijacks, RPKI |
| [load-balancers.md](./load-balancers.md) | L4 vs L7, algorithms, health checks, sticky sessions, TLS termination, AWS ALB/NLB, LCU/NLCU, GCP GLB, nginx, HAProxy, common issues |
| [cdn.md](./cdn.md) | CDN internals, edge PoPs, cache hierarchy, Cache-Control headers, CloudFront, Cloudflare, GCP CDN, WAF, debugging |
| [nslookup-vs-curl.md](./nslookup-vs-curl.md) | DNS resolution vs HTTP request path, when nslookup succeeds but curl fails, layered debugging |
| [zero-trust.md](./zero-trust.md) | Zero Trust vs perimeter security, BeyondCorp model, GCP Identity-Aware Proxy (IAP), mTLS + Istio AuthorizationPolicy, PSC + IAP + mTLS composition, debugging |
| [dns-internals.md](./dns-internals.md) | Full recursive resolution walk, all record types, DNSSEC chain of trust, split-horizon, CoreDNS + ndots in Kubernetes |
| [overlay-networks.md](./overlay-networks.md) | VXLAN (VNI/VTEP/BUM), GENEVE extensible headers, WireGuard Noise protocol + cryptokey routing, CNI overlay comparison, MTU/PMTUD |
| [ipvs-and-cni.md](./ipvs-and-cni.md) | IPVS O(1) vs iptables O(n), kube-proxy modes, CNI spec ADD/DEL/CHECK, Calico Felix+BIRD, Cilium eBPF identity model, NetworkPolicy walkthrough |
| [service-mesh.md](./service-mesh.md) | Istio istiod + xDS API, Envoy sidecar injection, SPIFFE mTLS, VirtualService/DestinationRule canary, retries/circuit breaking/fault injection, Linkerd comparison |
| [quic-http3.md](./quic-http3.md) | QUIC vs TCP HoL blocking, connection IDs, 1-RTT/0-RTT, QUIC streams, QPACK, nginx QUIC config, qvis debugging |

## Read Order

```
osi-model.md                    → understand the full picture
tcp-udp.md                      → transport layer (TCP state machine, TIME_WAIT)
tls-encryption.md               → TLS 1.2 vs 1.3, certificate validation, mTLS
acme-certificate-automation.md  → ACME protocol, DNS-01/HTTP-01, acme.sh/certbot/lego, EAB
http-versions.md                → HTTP/2 multiplexing, status codes, headers, QUIC, WebSocket
grpc-graphql.md                 → modern API protocols built on top
grpc-deep-dive.md               → gRPC wire-level internals and production concerns
linux-networking.md             → kernel packet path, netfilter, conntrack, namespaces
bgp-routing.md                  → how networks actually route between each other
load-balancers.md               → L4/L7, algorithms, AWS ALB/NLB, GCP, nginx, HAProxy
cdn.md                          → edge PoPs, caching, CloudFront/Cloudflare/GCP CDN
nslookup-vs-curl.md             → layered debugging when DNS works but HTTP fails
zero-trust.md                   → ZTNA, BeyondCorp, IAP, mTLS + PSC composition
dns-internals.md                → full resolution chain, DNSSEC, CoreDNS + ndots
overlay-networks.md             → VXLAN, GENEVE, WireGuard, CNI overlays, MTU
ipvs-and-cni.md                 → IPVS vs iptables at scale, CNI spec, Calico, Cilium
service-mesh.md                 → Istio, Envoy xDS, SPIFFE mTLS, traffic management, Linkerd
quic-http3.md                   → QUIC protocol internals, HTTP/3, 0-RTT, deployment
```
