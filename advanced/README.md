# Advanced

Beyond the fundamentals — service mesh, eBPF, chaos engineering, disaster recovery, and specialized low-latency / FinTech infrastructure.

## Files

| File | Topics |
|------|--------|
| [service-mesh.md](./service-mesh.md) | Istio control/data plane, VirtualService, mTLS, circuit breaking, Linkerd vs Istio |
| [ebpf-observability.md](./ebpf-observability.md) | eBPF verifier, bpftrace, BCC tools, Cilium, Tetragon, Hubble |
| [chaos-engineering.md](./chaos-engineering.md) | Litmus Chaos, Chaos Mesh, game days, failure injection patterns |
| [backup-dr.md](./backup-dr.md) | RTO/RPO math, Velero, etcd backup, PITR, AWS DR patterns, 3-2-1 rule |
| [dr-zero-downtime.md](./dr-zero-downtime.md) | Zero-downtime deploys (graceful shutdown, preStop race, canary/blue-green, expand/contract DB migrations), active-active multi-region DR, sync/async/semi-sync replication RPO tradeoffs, write-blocked-on-failover mechanics + mitigation (failover-aware endpoints, retry+idempotency, degraded read-only mode) |
| [low-latency-networking.md](./low-latency-networking.md) | AWS Direct Connect, BGP tuning, Transit Gateway multicast (IGMP), DPDK kernel bypass, EFA/RDMA, CPU isolation for HFT |
| [fintech-security.md](./fintech-security.md) | SEBI CSCRF, CERT-In 6hr incident reporting, K8s audit policy for regulators, PAM/Teleport, zero-downtime secrets rotation |
| [trading-data-streaming.md](./trading-data-streaming.md) | Kafka latency-first config, broker I/O tuning, KRaft Express mode, Redis order book consistency & failover |

## Read Order

```
service-mesh           → Istio/Linkerd control & data plane
ebpf-observability     → kernel-level observability
chaos-engineering      → failure injection, game days
backup-dr              → RTO/RPO, Velero, etcd, DR patterns
dr-zero-downtime       → zero-downtime deploys + multi-region DR + replication failover
low-latency-networking → HFT/exchange connectivity, DPDK, multicast
fintech-security       → SEBI/CERT-In compliance, secrets rotation
trading-data-streaming → broker + Redis tuning for market data
```
