# Networking

Core networking concepts for backend engineers and platform engineers — from physical bits to application protocols.

## Files

| File | Topics |
|------|--------|
| [osi-model.md](./osi-model.md) | 7 OSI layers, full HTTPS request flow (curl google.com), encapsulation/decapsulation, debugging by layer |
| [tcp-udp.md](./tcp-udp.md) | TCP 3-way handshake, 4-way teardown, state machine, flow control, congestion control (CUBIC/BBR), TIME_WAIT, UDP, when to use each |
| [tls-encryption.md](./tls-encryption.md) | Symmetric vs asymmetric, SSL history, TLS 1.2 (2 RTT), TLS 1.3 (1 RTT), certificate chain, certificate validation, debugging with openssl |
| [http-versions.md](./http-versions.md) | HTTP/1.0 → HTTP/3, HOL blocking, binary framing, status codes, methods, important headers, caching (ETag), CORS |
| [grpc-graphql.md](./grpc-graphql.md) | gRPC architecture, Protobuf encoding, 4 streaming modes, connection flow, status codes; GraphQL SDL, query vs REST, N+1, DataLoader |

## Read Order

```
osi-model.md    → understand the full picture
tcp-udp.md      → understand the transport layer (TCP state machine, TIME_WAIT)
tls-encryption.md → understand TLS 1.2 vs 1.3, certificate validation
http-versions.md  → HTTP/2 multiplexing, status codes, headers
grpc-graphql.md   → modern API protocols built on top
```
| [linux-networking.md](./linux-networking.md) | Linux packet RX/TX path, netfilter hooks, conntrack, network namespaces, veth pairs, SO_REUSEPORT, debugging commands |
