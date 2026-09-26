# DevOps Reference

Kubernetes, Linux, Docker, AWS, GCP, CI/CD, IaC, Monitoring, Git, and SRE — ordered from foundation to advanced.

## Read it interactively

Most guides here also render as a live site — click-to-reveal knowledge checks, tabbed comparisons, step-through walkthroughs, and Mermaid diagrams instead of static ASCII art. See [`website/`](./website) (Astro + Tailwind; deployable to Vercel).

```bash
cd website && npm install && npm run dev   # http://localhost:4321
```

A few guides go a step further with **live, manipulable simulators** — not just a diagram, an actual data structure or system you can insert/delete/search/fail into and watch reshape in real time, tested against the real algorithm before being shipped:

| Where | What you can do to it |
|---|---|
| [coding-practice/btree.md](./coding-practice/btree.md) | Insert/delete keys in a real order-4 B+tree — watch it split, borrow, merge |
| [coding-practice/skip-list.md](./coding-practice/skip-list.md) | Insert/search/delete with real randomized level generation |
| [coding-practice/lru-cache.md](./coding-practice/lru-cache.md) | Get/Put against a capacity-3 cache, watch eviction happen |
| [coding-practice/consistent-hashing.md](./coding-practice/consistent-hashing.md) | Add/remove nodes on an actual circular hash ring |
| [coding-practice/bloom-filter.md](./coding-practice/bloom-filter.md) | Insert words, trigger a real false positive on a 16-bit array |
| [coding-practice/rate-limiter-implementations.md](./coding-practice/rate-limiter-implementations.md) | A token bucket refilling on the real clock — burst it, watch it throttle |
| [databases/replication.md](./databases/replication.md) | Kill a Raft leader, watch an election resolve |
| [databases/redis-internals.md](./databases/redis-internals.md) | Insert keys past the load factor, watch incremental rehashing |
| [databases/clickhouse-internals.md](./databases/clickhouse-internals.md) | Insert rows, flush a memtable, trigger a background merge |
| [databases/elasticsearch-internals.md](./databases/elasticsearch-internals.md) | Index/delete documents, watch an inverted index's postings update |
| [databases/postgres-internals.md](./databases/postgres-internals.md) | Run concurrent transactions, see MVCC visibility (xmin/xmax) live |
| [databases/kafka-internals.md](./databases/kafka-internals.md) | Add/remove consumers, watch partitions reassign |
| [system-design/geospatial-services.md](./system-design/geospatial-services.md) | Insert points, watch a quadtree subdivide, run a radius query |
| [kubernetes/scheduler-internals.md](./kubernetes/scheduler-internals.md) | Add pods, watch Filter/Score bind them or land in Pending |

Contributing a new guide or retrofitting an old one? [`website/COMPONENTS.md`](./website/COMPONENTS.md) documents the interactive-component syntax (quiz cards, tabs, steppers, toggles, and the live-simulator pattern above), and the `/interactive-docs` Claude Code skill (`.claude/skills/interactive-docs/`) applies that pattern consistently for you.

---

## Recommended Order

```
1.  Linux fundamentals       → understand what everything runs on
2.  Networking               → TCP, TLS, HTTP, gRPC — how data moves
3.  Docker                   → containers before orchestration
4.  Kubernetes               → orchestration, networking, security
5.  Go                       → concurrency/language fluency for infra tooling and coding rounds
6.  CI/CD                    → build and deploy pipelines
7.  IaC                      → Terraform, Pulumi, Helm, CloudFormation
8.  AWS                      → cloud infrastructure
9.  GCP                      → GCP equivalents + BigQuery, Bigtable, GKE
10. Monitoring               → Prometheus, Grafana, OTel, Loki
11. Git                      → internals, workflows, fixing mistakes
12. Advanced                 → service mesh, eBPF, chaos, DR, trading systems, fintech compliance
13. AI Infrastructure        → GPU scheduling, KubeRay, vLLM, LLMOps
14. MLOps                    → experiment tracking, pipelines, drift detection
15. Database Internals       → WAL, MVCC, indexes, replication internals
16. Databases on K8s         → running Postgres, Kafka, Redis on GKE
17. System Design            → scaling, CAP/PACELC, rate limiting, async patterns
18. SRE & Debugging          → production incident runbooks, on-call tooling
19. Coding Practice          → DSA implementations in Go & Python (B-trees, skip lists, LRU cache, rate limiter, etc.)
20. Platform Engineering     → IDP concepts, Backstage, Crossplane, self-service, multi-tenancy, DORA metrics, cost attribution, workflow automation (n8n, Temporal), AI SRE agents (k8sgpt, Robusta, OpenSRE)
21. Security Engineering     → Container security, supply chain (SLSA/Sigstore), secrets management (Vault/ESO), SAST/DAST, Kubernetes security (OPA/Kyverno/Falco)
22. eBPF                     → BPF fundamentals, Cilium CNI, Tetragon runtime security, bpftrace production debugging
```

---

## 1. Linux

| File | Topics | Level |
|------|--------|-------|
| [linux/README.md](./linux/README.md) | Process model, memory, filesystem, signals, load average | SDE-1 |
| [linux/commands.md](./linux/commands.md) | grep, awk, sed, find, ps, ss, curl, disk management; top-N slow requests from logs (awk vs grep numeric field filtering) | SDE-1 |
| [linux/boot.md](./linux/boot.md) | BIOS → GRUB → kernel → initramfs → systemd | SDE-1 |
| [linux/systemd.md](./linux/systemd.md) | Unit files, service lifecycle, timers, journalctl, systemd-analyze | SDE-1 |
| [linux/networking.md](./linux/networking.md) | TCP/IP stack, sockets, iptables, netfilter, TIME_WAIT | SDE-1 |
| [linux/network-tools.md](./linux/network-tools.md) | ss, tcpdump, curl -v, nc, iperf3, mtr, dig, ip, tcp tuning | SDE-1 |
| [linux/io-models.md](./linux/io-models.md) | Blocking, non-blocking, select/poll/epoll, io_uring | SDE-2 |
| [linux/scheduler.md](./linux/scheduler.md) | CFS, nice values, cgroups, context switches, GMP model | SDE-2 |
| [linux/security.md](./linux/security.md) | Capabilities, seccomp, AppArmor, SELinux, namespaces | SDE-2 |
| [linux/memory-tuning.md](./linux/memory-tuning.md) | /proc/meminfo, swap, OOM killer, dirty pages, huge pages, cgroups v2 | SDE-2 |
| [linux/strace-perf.md](./linux/strace-perf.md) | strace, perf stat/top/record, flame graphs, Brendan Gregg methodology | SDE-2 |
| [linux/containers-evolution.md](./linux/containers-evolution.md) | chroot → LXC → Docker → OCI. Image size optimization. | SDE-1 |
| [linux/cgroup-v2.md](./linux/cgroup-v2.md) | cgroup v2 hierarchy, cpu.max/weight, memory.high, PSI pressure files, I/O limits, K8s mapping | SDE-2 |
| [linux/proc-internals.md](./linux/proc-internals.md) | /proc/maps, /proc/smaps (RSS/PSS/Private_Dirty), /proc/status, /proc/fd, signal masks | SDE-2 |
| [linux/ebpf-bpftrace.md](./linux/ebpf-bpftrace.md) | eBPF hooks, bpftrace one-liners for CPU/memory/network/disk, BCC tools, overhead comparison | SDE-2 |
| [linux/signals.md](./linux/signals.md) | SIGTERM vs SIGKILL internals, signal delivery, signal masks, SIGCHLD/zombies, Go graceful shutdown; PID 1 problem, shell vs exec form, tini/dumb-init, STOPSIGNAL, graceful shutdown checklist | SDE-1/2 |

**Read order:** README → commands → boot → systemd → networking → network-tools → io-models → scheduler → security → memory-tuning → strace-perf → containers-evolution → cgroup-v2 → proc-internals → ebpf-bpftrace → signals

---

## 2. Networking

| File | Topics | Level |
|------|--------|-------|
| [networking/README.md](./networking/README.md) | Index and read order | — |
| [networking/osi-model.md](./networking/osi-model.md) | 7 OSI layers, full HTTPS request flow layer-by-layer (curl google.com), encapsulation, debug by layer | SDE-1 |
| [networking/tcp-udp.md](./networking/tcp-udp.md) | TCP 3-way handshake, 4-way teardown, state machine, flow/congestion control, TIME_WAIT, UDP, when to use each | SDE-1/2 |
| [networking/tls-encryption.md](./networking/tls-encryption.md) | Symmetric vs asymmetric, TLS 1.2 vs 1.3 handshake (RTT comparison), certificate chain, validation steps, openssl debugging | SDE-1/2 |
| [networking/acme-certificate-automation.md](./networking/acme-certificate-automation.md) | PEM file format, ACME protocol (RFC 8555), HTTP-01 vs DNS-01, wildcard certs, acme.sh/certbot/lego/cert-manager, ECC vs RSA, Google Trust Services/EAB | SDE-1/2 |
| [networking/http-versions.md](./networking/http-versions.md) | HTTP/1.1 vs HTTP/2 vs HTTP/3, HOL blocking, binary framing, status codes, methods, caching (ETag), CORS, QUIC wire-level mechanics (independent congestion control, integrated TLS 1.3 handshake, connection migration), WebSocket upgrade handshake/frame format/masking | SDE-1/2 |
| [networking/linux-networking.md](./networking/linux-networking.md) | Linux packet RX/TX path, netfilter hooks, conntrack, network namespaces, veth pairs, SO_REUSEPORT | SDE-2 |
| [networking/grpc-graphql.md](./networking/grpc-graphql.md) | gRPC on HTTP/2, Protobuf encoding, 4 streaming modes, connection flow; GraphQL SDL, N+1 problem, DataLoader | SDE-1/2 |
| [networking/grpc-deep-dive.md](./networking/grpc-deep-dive.md) | Protobuf wire format internals, all 4 streaming modes with full code, interceptors (auth/metrics), deadline propagation, health checking protocol, client-side load balancing, gRPC-Web, error code mapping | SDE-2 |
| [networking/bgp-routing.md](./networking/bgp-routing.md) | Autonomous systems, path-vector routing, path selection (LOCAL_PREF/AS-PATH/MED), why anycast actually works, route leaks/hijacks, RPKI | SDE-2 |
| [networking/load-balancers.md](./networking/load-balancers.md) | L4 vs L7, algorithms, health checks, sticky sessions, connection draining, AWS ALB/NLB, LCU/NLCU capacity units + pricing, GCP GLB, nginx, HAProxy | SDE-1/2 |
| [networking/cdn.md](./networking/cdn.md) | CDN internals, edge PoPs, cache hierarchy, CloudFront vs Cloudflare vs GCP CDN, cache invalidation, TLS at edge | SDE-1/2 |
| [networking/nslookup-vs-curl.md](./networking/nslookup-vs-curl.md) | DNS resolution vs HTTP request path, when nslookup succeeds but curl fails, layered debugging | SDE-1 |
| [networking/zero-trust.md](./networking/zero-trust.md) | Zero Trust vs perimeter security, BeyondCorp model, GCP Identity-Aware Proxy (IAP), mTLS + Istio AuthorizationPolicy, PSC + IAP + mTLS composition | SDE-2 |

**Read order:** osi-model → tcp-udp → tls-encryption → acme-certificate-automation → http-versions → grpc-graphql → grpc-deep-dive → linux-networking → bgp-routing → load-balancers → cdn → nslookup-vs-curl → zero-trust

---

## 3. Docker

| File | Topics | Level |
|------|--------|-------|
| [docker/README.md](./docker/README.md) | Architecture (dockerd→containerd→runc), image layers COW, commands, Dockerfile, Compose, runtime flags, storage drivers, build cache, health checks | SDE-1 |
| [docker/networking.md](./docker/networking.md) | bridge/host/overlay/macvlan/none, iptables NAT, container DNS, port publishing internals, deep mode comparison | SDE-1/2 |
| [docker/buildkit.md](./docker/buildkit.md) | Parallel stages, cache mounts, secret mounts, SSH agent, multi-platform buildx, inline cache | SDE-1/2 |
| [docker/docker-security.md](./docker/docker-security.md) | Rootless Docker, docker.sock danger, image scanning, cosign/Sigstore, cap-drop, BuildKit secrets | SDE-2 |
| [docker/internals.md](./docker/internals.md) | Image layers CoW, Linux namespaces, cgroups, containerd-shim, image optimization | SDE-1/2 |
| [docker/debugging.md](./docker/debugging.md) | 10 scenarios with Prevention: exit codes, OOM, port issues, networking, build cache, image size, volumes, compose, disk | SDE-1 |

**Read order:** README → networking → buildkit → docker-security → debugging

---

## 4. Kubernetes

| File | Topics | Level |
|------|--------|-------|
| [kubernetes/README.md](./kubernetes/README.md) | Architecture, kubectl apply flow, scheduler internals, taints, nodeAffinity, podAffinity/anti-affinity, GPU scenarios | SDE-1/2 |
| [kubernetes/kubectl-cheatsheet.md](./kubernetes/kubectl-cheatsheet.md) | Context switching, pod/deployment/debug operations, one-liners, jsonpath | SDE-1 |
| [kubernetes/workloads.md](./kubernetes/workloads.md) | Pod lifecycle, probes, QoS, Deployments, StatefulSets, DaemonSets, Jobs | SDE-1 |
| [kubernetes/networking.md](./kubernetes/networking.md) | Services, ClusterIP/iptables, DNS, Ingress, NetworkPolicy, CNI, per-node virtual networks; AND vs OR selectors, deny-all templates, egress to K8s API, Istio AuthorizationPolicy, CNI enforcement matrix | SDE-1/2 |
| [kubernetes/resource-limits.md](./kubernetes/resource-limits.md) | Requests vs limits, CPU throttling math, OOMKill, QoS classes, LimitRange, ResourceQuota, node allocatable chain, VPA | SDE-1/2 |
| [kubernetes/storage.md](./kubernetes/storage.md) | PV/PVC/StorageClass, dynamic provisioning, CSI, volume snapshots | SDE-1 |
| [kubernetes/autoscaling.md](./kubernetes/autoscaling.md) | HPA, VPA, KEDA, Cluster Autoscaler, Karpenter | SDE-2 |
| [kubernetes/rbac.md](./kubernetes/rbac.md) | ServiceAccount, Role/ClusterRole, RoleBinding, auth chain; IRSA, EKS aws-auth/Access Entries, token projection, aggregated roles, RBAC audit one-liners | SDE-1/2 |
| [kubernetes/helm.md](./kubernetes/helm.md) | Chart structure, templating, hooks, library charts, Helmfile, debugging | SDE-1/2 |
| [kubernetes/eks-architecture.md](./kubernetes/eks-architecture.md) | EKS managed control plane, VPC CNI, IRSA, node groups, Fargate | SDE-1/2 |
| [kubernetes/coredns.md](./kubernetes/coredns.md) | Corefile plugins, ndots:5 problem + fix, forwarding, caching, dnsPolicy options, debugging, NodeLocal DNSCache | SDE-1/2 |
| [kubernetes/pod-lifecycle.md](./kubernetes/pod-lifecycle.md) | Startup sequence (sandbox→CNI→image→probes→Endpoints), admission controller chain, server-side apply, termination race + preStop fix; why pod won't die: finalizers, PDB, PID 1, node partition, force delete, webhook blocking | SDE-2 |
| [kubernetes/controller-pattern.md](./kubernetes/controller-pattern.md) | Informers, Reflector/Indexer local cache, SharedInformer, workqueue key-dedup, level-triggered vs edge-triggered reconcile, resync period, leader election (Lease mechanics, failover) | SDE-2 |
| [kubernetes/custom-resources-operators.md](./kubernetes/custom-resources-operators.md) | CRD registration (apiextensions-apiserver), OpenAPI v3 schema validation, versions/conversion strategies, status/scale subresources, aggregation layer vs CRDs, ownerReferences/GC, finalizers, cert-manager/Prometheus Operator/ArgoCD examples | SDE-2 |
| [kubernetes/kubeadm-bootstrap.md](./kubernetes/kubeadm-bootstrap.md) | Self-hosted cluster bootstrap: PKI/CA generation, static pods (chicken-and-egg problem, mirror pods), bootstrap tokens/TLS bootstrapping, stacked vs external etcd HA topology, contrast with managed control planes | SDE-2 |
| [kubernetes/kube-proxy-modes.md](./kubernetes/kube-proxy-modes.md) | iptables O(n) + conntrack, IPVS O(1) + LB algorithms, Cilium/eBPF socket-level LB (no DNAT), comparison | SDE-2 |
| [kubernetes/cross-node-networking.md](./kubernetes/cross-node-networking.md) | Same-node veth/bridge, VXLAN overlay, Calico BGP direct routing, AWS VPC CNI flat network, MTU table | SDE-2 |
| [kubernetes/hpa-vpa-internals.md](./kubernetes/hpa-vpa-internals.md) | HPA internals every stage, VPA components, singleton VPA, HPA+VPA conflict | SDE-1/2 |
| [kubernetes/scheduler-internals.md](./kubernetes/scheduler-internals.md) | Filter+Score plugins, FailedScheduling events, full pod scheduling sequence | SDE-1/2 |
| [kubernetes/policy-security.md](./kubernetes/policy-security.md) | OPA/Gatekeeper, Kyverno (validate/mutate/generate), multi-tenancy, ResourceQuota, NetworkPolicy isolation, PSA, seccomp, AppArmor | SDE-2 |
| [kubernetes/node-shutdown.md](./kubernetes/node-shutdown.md) | Graceful shutdown (systemd inhibitor), pod eviction ordering, node drain, non-graceful shutdown + out-of-service taint, lifecycle taints | SDE-2 |

**Read order:** kubectl-cheatsheet → README → workloads → resource-limits → networking → coredns → storage → rbac → autoscaling → helm → eks-architecture → pod-lifecycle → controller-pattern → custom-resources-operators → kubeadm-bootstrap → kube-proxy-modes → cross-node-networking → node-shutdown

---

## 5. Go

Language and concurrency fluency for infra tooling, backend services, and coding-round interviews.

| File | Topics | Level |
|------|--------|-------|
| [go/README.md](./go/README.md) | Why Go for infra tooling, goroutine/channel/select fundamentals, error handling idioms, read order | SDE-1 |
| [go/concurrency.md](./go/concurrency.md) | Goroutine leaks + pprof detection, worker pool, fan-out/fan-in, pipeline pattern, done-channel cancellation, race detection (`-race`) | SDE-1/2 |
| [go/context.md](./go/context.md) | context tree/propagation, WithCancel/WithTimeout/WithDeadline, errgroup fan-out with early cancellation, HTTP request cancellation, common mistakes | SDE-1/2 |
| [go/sync-primitives.md](./go/sync-primitives.md) | Mutex vs RWMutex, sync.Once, sync.Pool, WaitGroup, errgroup, sync.Map, atomic package, Mutex vs Channel decision framework | SDE-1/2 |
| [go/runtime-scheduler.md](./go/runtime-scheduler.md) | GMP scheduler internals, scheduling loop, work stealing, async preemption (Go 1.14), netpoller, GOMAXPROCS | SDE-2/3 |

**Read order:** README → concurrency → context → sync-primitives → runtime-scheduler

---

## 6. CI/CD

| File | Topics | Level |
|------|--------|-------|
| [cicd/README.md](./cicd/README.md) | CI vs CD vs GitOps, pipeline patterns, deployment strategies, secrets | SDE-1 |
| [cicd/github-actions/README.md](./cicd/github-actions/README.md) | Workflows, OIDC to AWS, matrix builds, caching, reusable workflows | SDE-1 |
| [cicd/jenkins/README.md](./cicd/jenkins/README.md) | Declarative pipeline, shared libraries, master-agent architecture | SDE-1 |
| [cicd/jenkins/ecs-agents.md](./cicd/jenkins/ecs-agents.md) | Dynamic Jenkins agents on ECS Fargate, cost optimization | SDE-2 |
| [cicd/jenkins/plugin-development.md](./cicd/jenkins/plugin-development.md) | Extension points (@Extension, Builder/SimpleBuildStep/Publisher), Descriptor pattern, Stapler data-binding, credential handling, AsyncPeriodicWork, OSS security review findings (SSRF/XSS/CSRF), JenkinsRule testing, Update Center publishing | SDE-2 |
| [cicd/argocd/README.md](./cicd/argocd/README.md) | GitOps, Application CRD, sync waves, multi-cluster with ApplicationSet, RBAC, Projects, SSO | SDE-1/2 |
| [cicd/gitops-secrets.md](./cicd/gitops-secrets.md) | Sealed Secrets vs ESO, EKS/IRSA pattern, secret rotation, decision framework | SDE-2 |
| [cicd/pipeline-design.md](./cicd/pipeline-design.md) | Java CI end-to-end, CD to 2 clusters, ArgoCD vs GHA deploy, Helm create/install/upgrade, SDE-1 vs SDE-2 classification | SDE-1/2 |
| [cicd/argo-rollouts.md](./cicd/argo-rollouts.md) | Canary (steps + Prometheus analysis + ALB), blue-green, kubectl plugin, ArgoCD integration | SDE-2 |

**Read order:** README → github-actions → jenkins → jenkins/ecs-agents → jenkins/plugin-development → argocd → gitops-secrets → pipeline-design → argo-rollouts

---

## 7. Infrastructure as Code

| File | Topics | Level |
|------|--------|-------|
| [iac/README.md](./iac/README.md) | IaC overview, Terraform vs CloudFormation, state, drift | SDE-1 |
| [iac/terraform/README.md](./iac/terraform/README.md) | HCL, state, modules, workspaces deep-dive, Terragrunt, remote backend (S3+DynamoDB), import, moved block, check block, terraform test framework | SDE-1/2 |
| [iac/cloudformation/README.md](./iac/cloudformation/README.md) | Templates, stacks, change sets, nested stacks, StackSets, custom resources | SDE-1 |
| [iac/pulumi/README.md](./iac/pulumi/README.md) | Pulumi vs Terraform architecture, Output<T> model, Pulumi Cloud vs self-managed state backend, component resources, secrets encryption, testing with mocks, decision framework | SDE-1/2 |
| [iac/ansible/README.md](./iac/ansible/README.md) | Architecture, how Ansible works, SSH internals, agentless push model, ansible.cfg | SDE-1 |
| [iac/ansible/core-concepts.md](./iac/ansible/core-concepts.md) | Inventory, playbooks, modules, tasks, handlers, variables (precedence), facts, Jinja2 templates | SDE-1 |
| [iac/ansible/cloud-integration.md](./iac/ansible/cloud-integration.md) | AWS SSM (no port 22), GCP OS Login + IAP tunnel, dynamic inventory, cloud modules | SDE-1/2 |
| [iac/ansible/advanced.md](./iac/ansible/advanced.md) | Roles, collections, Ansible Vault, AWX/Tower, performance (forks/pipelining), Molecule testing | SDE-2 |

**Read order:** README → terraform → cloudformation → pulumi → ansible → ansible/core-concepts → ansible/cloud-integration → ansible/advanced

---

## 8. AWS

| File | Topics | Level |
|------|--------|-------|
| [aws/README.md](./aws/README.md) | VPC, subnets, SGs vs NACLs, NAT GW, IGW, VPC Peering, Transit Gateway; route table deep-dive: local entry, longest-prefix match, VPC endpoint routes, TGW/VGW routes, blackhole routes, per-AZ NAT | SDE-1/2 |
| [aws/ecs-fargate.md](./aws/ecs-fargate.md) | ECS Fargate task definition, networking, rolling updates, auto scaling, debugging | SDE-1/2 |
| [aws/request-flow-alb-to-pod.md](./aws/request-flow-alb-to-pod.md) | Route53→ALB→TargetGroup→Pod full flow, ALB vs NLB, L4 vs L7, debug commands | SDE-1/2 |
| [aws/services-overview.md](./aws/services-overview.md) | IAM, ALB/NLB, Route 53, ECS vs EKS, TLS/mTLS | SDE-1 |
| [aws/storage-databases.md](./aws/storage-databases.md) | S3, RDS, Aurora, ElastiCache, DynamoDB, EBS vs EFS | SDE-1 |
| [aws/databases-deep-dive.md](./aws/databases-deep-dive.md) | Aurora internals, DocumentDB, DynamoDB single-table design, DAX, 8 scenarios | SDE-2 |
| [aws/messaging-serverless-observability.md](./aws/messaging-serverless-observability.md) | SQS, SNS, EventBridge, Lambda, CloudWatch, Secrets Manager, multi-account, cost | SDE-1/2 |

**Read order:** README → services-overview → ecs-fargate → request-flow-alb-to-pod → storage-databases → databases-deep-dive → messaging-serverless-observability

---

## 9. GCP

| File | Topics | Level |
|------|--------|-------|
| [gcp/from-aws.md](./gcp/from-aws.md) | Mental model shifts for AWS engineers, resource hierarchy (Org/Folder/Project), additive IAM, global VPC, pricing quirks, gcloud vs aws CLI cheatsheet | SDE-1/2 |
| [gcp/README.md](./gcp/README.md) | Global VPC, subnets, firewall rules, Cloud NAT, VPC Peering, Shared VPC, Private Google Access, Private Service Connect | SDE-1/2 |
| [gcp/services-overview.md](./gcp/services-overview.md) | IAM, Workload Identity, Cloud LB, Cloud DNS, Cloud Run vs GKE | SDE-1/2 |
| [gcp/security-compliance.md](./gcp/security-compliance.md) | VPC Service Controls, Cloud KMS/CMEK, Secret Manager, Binary Authorization, Security Command Center, IAM Deny policies, IAM Conditions, Org Policy constraints | SDE-2 |
| [gcp/compute.md](./gcp/compute.md) | GCE vs EC2, machine families, custom machine types, disk types, Preemptible/Spot VMs, Managed vs Unmanaged Instance Groups, auto-healing/scaling, rolling updates, serial ports 1–4, live migration, IAP SSH | SDE-1/2 |
| [gcp/gke.md](./gcp/gke.md) | GKE Standard vs Autopilot, Workload Identity, VPC-native networking, container-native LB (NEG), GPU pools, upgrade channels | SDE-2 |
| [gcp/request-flow-glb-to-pod.md](./gcp/request-flow-glb-to-pod.md) | End-to-end request walkthrough: Cloud DNS → Global External LB → Cloud Armor → NEG → GKE pod, LB-type tradeoffs, traffic-not-reaching-pod debugging flowchart | SDE-2 |
| [gcp/storage.md](./gcp/storage.md) | GCS vs S3 (storage classes, Autoclass, lifecycle, versioning), Persistent Disk, Local SSD, Filestore (NFS), Storage Transfer Service | SDE-1/2 |
| [gcp/databases.md](./gcp/databases.md) | Cloud SQL, AlloyDB, Cloud Spanner (TrueTime), Firestore, Memorystore (Redis), database selection guide | SDE-1/2 |
| [gcp/bigquery.md](./gcp/bigquery.md) | Columnar storage, partitioning, clustering, slots, streaming vs batch, external tables, time travel, cost optimization | SDE-1/2 |
| [gcp/bigtable.md](./gcp/bigtable.md) | Wide-column model, row key design (hotspot prevention), LSM tree, HBase API, monitoring | SDE-2 |
| [gcp/data-pipelines.md](./gcp/data-pipelines.md) | Dataflow (Apache Beam), Dataproc (managed Spark/Hadoop), Cloud Composer vs Workflows, Data Fusion, pipeline-tool decision guide | SDE-2 |
| [gcp/serverless.md](./gcp/serverless.md) | Cloud Run (concurrency, traffic splitting, VPC, triggers), Cloud Functions Gen2, Cloud Run Jobs, Cloud Scheduler, Secret Manager | SDE-1/2 |
| [gcp/messaging.md](./gcp/messaging.md) | Pub/Sub (topic/subscription, DLQ, Lite), Cloud Tasks (rate-limited queues), Eventarc (event routing), service selection guide | SDE-1/2 |
| [gcp/reliability-dr.md](./gcp/reliability-dr.md) | RTO/RPO-driven design, Google's 4 DR patterns, multi-zone vs multi-region, multi-region failover walkthrough | SDE-2 |
| [gcp/cost-optimization.md](./gcp/cost-optimization.md) | CUD vs SUD, Recommender/Active Assist, BigQuery pricing models, FinOps toolchain, hidden network-egress costs | SDE-2 |
| [gcp/migration-methodology.md](./gcp/migration-methodology.md) | Migration strategy taxonomy, Migrate to Virtual Machines, Database Migration Service, BigQuery Migration Service, Storage Transfer Service/Transfer Appliance, Anthos hybrid migration | SDE-2 |
| [gcp/observability.md](./gcp/observability.md) | Cloud Monitoring, Cloud Logging (LQL, sinks, retention), Cloud Trace, Cloud Audit Logs, Error Reporting, Profiler | SDE-1/2 |
| [gcp/cicd.md](./gcp/cicd.md) | Cloud Build (cloudbuild.yaml, triggers, caching), Artifact Registry (Docker/Helm, scanning), Cloud Deploy (canary, approval gates), GitHub Actions + Workload Identity Federation | SDE-1/2 |
| [gcp/gcp-vs-aws.md](./gcp/gcp-vs-aws.md) | Full service mapping, global VPC vs regional VPC, BigQuery vs Redshift, GKE vs EKS, TPUs, when to choose | SDE-1/2 |
| [gcp/scenarios.md](./gcp/scenarios.md) | 10 scenarios with Prevention: Workload Identity 403, autoscaler stuck, BigQuery cost spike, Cloud Run cold start, Spanner hotspot, Pub/Sub backlog, GCS 403, Cloud SQL connection exhaustion, AlloyDB/Cloud SQL failover DNS caching, Bigtable hot row key | SDE-1/2 |

**Read order:** from-aws → README → services-overview → security-compliance → compute → gke → request-flow-glb-to-pod → storage → databases → bigquery → bigtable → data-pipelines → serverless → messaging → reliability-dr → cost-optimization → migration-methodology → observability → cicd → gcp-vs-aws → scenarios

---

## 10. Monitoring & Observability

| File | Topics | Level |
|------|--------|-------|
| [monitoring/prometheus.md](./monitoring/prometheus.md) | Architecture, data model (4 types + math), TSDB internals, 12+ PromQL queries, scrape config, recording rules, 5 production alerts, scenarios | SDE-1/2 |
| [monitoring/alertmanager.md](./monitoring/alertmanager.md) | Routing tree, grouping, inhibition, silences, complete config, debugging | SDE-1/2 |
| [monitoring/grafana.md](./monitoring/grafana.md) | Panel types, variables, USE/RED/SLO dashboards, provisioning as code | SDE-1/2 |
| [monitoring/opentelemetry.md](./monitoring/opentelemetry.md) | Three pillars (traces/metrics/logs), OTEL Collector, Go SDK, auto-instrumentation | SDE-2 |
| [monitoring/loki.md](./monitoring/loki.md) | Architecture, labels vs content, LogQL, Promtail config, trace correlation; Fluent Bit zero-loss ELK: filesystem buffer, Retry_Limit False, Kafka buffer, DLQ/S3 fallback, Prometheus alerts | SDE-1/2 |
| [monitoring/performance-debugging.md](./monitoring/performance-debugging.md) | USE method, RED method, 60-second checklist, Go pprof, bpftrace one-liners | SDE-2 |
| [monitoring/monitoring-scenarios.md](./monitoring/monitoring-scenarios.md) | 12 scenarios with Prevention: target DOWN, missing metrics, Prometheus OOM, slow PromQL, alert not notifying, alert storm, Grafana no data, Loki missing logs, no OTEL traces, K8s scrape issues | SDE-1/2 |
| [monitoring/slo-sli.md](./monitoring/slo-sli.md) | SLI/SLO/Error Budget math, multi-window multi-burn-rate alerts, recording rules, Grafana SLO dashboard, decision framework | SDE-2 |
| [monitoring/alerting-philosophy.md](./monitoring/alerting-philosophy.md) | Four Golden Signals + PromQL, symptoms vs causes, alert fatigue, urgency tiers, runbook structure, USE vs RED vs Golden Signals | SDE-1/2 |
| [monitoring/thanos-mimir.md](./monitoring/thanos-mimir.md) | Thanos components (sidecar/querier/store/compactor), Mimir distributed TSDB, long-term S3 storage, deduplication, downsampling, when to use each | SDE-2 |

> Database-specific monitoring (Prometheus + Grafana for PostgreSQL, MySQL, Redis, MongoDB) lives in [sre/db-monitoring.md](./sre/db-monitoring.md).

**Read order:** prometheus → alertmanager → grafana → alerting-philosophy → opentelemetry → loki → performance-debugging → slo-sli → thanos-mimir → monitoring-scenarios

---

## 11. Git

| File | Topics | Level |
|------|--------|-------|
| [git/git-internals.md](./git/git-internals.md) | Object model (blob/tree/commit/tag), refs, pack files, merge vs rebase internals, reflog | SDE-1/2 |
| [git/git-workflows.md](./git/git-workflows.md) | Trunk-based vs GitFlow vs GitHub Flow, monorepo, branch protection, conventional commits | SDE-1 |
| [git/git-fixes.md](./git/git-fixes.md) | reset modes, amend, reflog recovery, interactive rebase, bisect, detached HEAD, secrets removal | SDE-1 |

**Read order:** git-internals → git-workflows → git-fixes

---

## 12. Advanced

| File | Topics | Level |
|------|--------|-------|
| [advanced/service-mesh.md](./advanced/service-mesh.md) | Istio control/data plane, VirtualService, mTLS, circuit breaking, Linkerd vs Istio | SDE-2 |
| [advanced/ebpf-observability.md](./advanced/ebpf-observability.md) | eBPF verifier, bpftrace, BCC tools, Cilium, Tetragon, Hubble | SDE-2 |
| [advanced/chaos-engineering.md](./advanced/chaos-engineering.md) | Litmus Chaos, Chaos Mesh, game days, failure injection patterns | SDE-2 |
| [advanced/chaos-engineering-handson.md](./advanced/chaos-engineering-handson.md) | Runnable exercises: Litmus pod-delete, Chaos Mesh network partition + CPU stress vs HPA, manual EKS AZ-failure game day, chaos maturity checklist | SDE-2 |
| [advanced/backup-dr.md](./advanced/backup-dr.md) | RTO/RPO math, Velero, etcd backup, PITR, AWS DR patterns, 3-2-1 rule | SDE-2 |
| [advanced/dr-zero-downtime.md](./advanced/dr-zero-downtime.md) | Zero-downtime deploys for mission-critical services: graceful shutdown/preStop race, canary vs blue-green, expand/contract DB migrations, active-active multi-region DR, sync/async/semi-sync replication RPO tradeoffs, write-blocked-on-failover mechanics + mitigation | SDE-2 |
| [advanced/low-latency-networking.md](./advanced/low-latency-networking.md) | AWS Direct Connect, BGP tuning, Transit Gateway multicast (IGMP), DPDK kernel bypass, EFA/RDMA, CPU isolation for HFT | SDE-2 |
| [advanced/fintech-security.md](./advanced/fintech-security.md) | SEBI CSCRF, CERT-In 6hr incident reporting, K8s audit policy for regulators, PAM/Teleport, zero-downtime secrets rotation with Vault dynamic secrets and AWS Secrets Manager | SDE-2 |
| [advanced/fintech-compliance.md](./advanced/fintech-compliance.md) | SEBI CSCRF 5 pillars, VAPT/SOC requirements, CERT-In 6hr reporting automation, PCI-DSS 12 requirements + tokenization vs encryption, RBI data localization/outsourcing guidelines, compliance-ready K8s audit policy | SDE-2 |
| [advanced/trading-systems.md](./advanced/trading-systems.md) | OMS order lifecycle state machine, matching engine/order book fundamentals, market data feed handling (snapshot/incremental, gap detection), FIX protocol basics, exchange gateway failover, idempotent order submission, infra concerns for market-open spikes | SDE-2 |
| [advanced/trading-data-streaming.md](./advanced/trading-data-streaming.md) | Kafka latency-first config (linger.ms=0, acks=1), broker I/O tuning, KRaft Express mode, Redis order book (AOF always, min-replicas-to-write, CP vs AP partition choice) | SDE-2 |

**Read order:** README → service-mesh → ebpf-observability → chaos-engineering → chaos-engineering-handson → backup-dr → dr-zero-downtime → low-latency-networking → fintech-security → fintech-compliance → trading-systems → trading-data-streaming

---

## 13. AI Infrastructure & LLMOps

The natural extension of K8s/Linux expertise into AI/ML platform engineering.

| File | Topics | Level |
|------|--------|-------|
| [ai-infra/README.md](./ai-infra/README.md) | Index, learning path (Phase 1-3), AI vs standard K8s workload differences | SDE-2 |
| [ai-infra/gpu-scheduling.md](./ai-infra/gpu-scheduling.md) | NVIDIA Device Plugin, extended resources, Dynamic Resource Allocation (ResourceClaim/DeviceClass), MIG slicing, GPU Operator, DCGM metrics, gang scheduling, taints/tolerations for GPU nodes | SDE-2 |
| [ai-infra/kuberay.md](./ai-infra/kuberay.md) | KubeRay operator, RayCluster CRD, RayJob, RayService, autoscaling to zero, observability | SDE-2 |
| [ai-infra/model-serving.md](./ai-infra/model-serving.md) | KServe InferenceService, vLLM continuous batching, PagedAttention, KV cache, canary rollouts, KEDA scaling | SDE-2 |
| [ai-infra/llmops.md](./ai-infra/llmops.md) | RAG pipeline, pgvector/Milvus, LangSmith/OpenLLMetry tracing, NeMo guardrails, cost optimization, drift detection | SDE-2 |
| [ai-infra/networking.md](./ai-infra/networking.md) | NVLink/NVSwitch, InfiniBand, RoCE, AWS EFA, NCCL AllReduce, Cilium for inference, fat-tree topology | SDE-2 |

**Read order:** gpu-scheduling → kuberay → model-serving → llmops

---

## 14. MLOps

CI/CD for data and models — experiment tracking, automated retraining pipelines, drift detection.

| File | Topics | Level |
|------|--------|-------|
| [mlops/README.md](./mlops/README.md) | Index, DevOps→MLOps analogy, learning path | SDE-2 |
| [mlops/experiment-tracking.md](./mlops/experiment-tracking.md) | MLflow runs/experiments/registry, W&B sweeps, model promotion workflow, artifact versioning | SDE-2 |
| [mlops/training-pipelines.md](./mlops/training-pipelines.md) | Kubeflow Pipelines components/DAGs, Airflow KubernetesPodOperator, evaluation gates, retraining triggers | SDE-2 |
| [mlops/data-drift.md](./mlops/data-drift.md) | Evidently drift reports, statistical tests, K8s CronJob monitoring, shadow scoring, A/B testing model versions | SDE-2 |
| [mlops/feature-stores.md](./mlops/feature-stores.md) | Feast architecture, online vs offline store, point-in-time joins, training-serving skew detection | SDE-2 |

**Read order:** experiment-tracking → training-pipelines → data-drift → feature-stores

---

## 15. Database Internals

Storage engines, WAL, MVCC, replication internals, indexing, and query execution for each database.

| File | Topics | Level |
|------|--------|-------|
| [databases/README.md](./databases/README.md) | WAL concept, MVCC, common patterns | SDE-2 |
| [databases/postgres-internals.md](./databases/postgres-internals.md) | Buffer pool, WAL/LSN, MVCC with xmin/xmax, VACUUM, B-tree/GIN/BRIN indexes, EXPLAIN ANALYZE, PgBouncer | SDE-2 |
| [databases/mysql-internals.md](./databases/mysql-internals.md) | InnoDB buffer pool, redo log, undo log, MVCC, clustered B-tree, binlog, GTID replication | SDE-2 |
| [databases/mongodb-internals.md](./databases/mongodb-internals.md) | WiredTiger cache, journal, oplog internals, aggregation pipeline, index types, write/read concern | SDE-2 |
| [databases/redis-internals.md](./databases/redis-internals.md) | Data structure encodings, RDB vs AOF, eviction policies, replication, cluster hash slots | SDE-1/2 |
| [databases/etcd.md](./databases/etcd.md) | Raft consensus, MVCC revisions, watch API (how K8s controllers work), compaction/defrag, clustering, performance tuning | SDE-2 |
| [databases/lsm-trees.md](./databases/lsm-trees.md) | MemTable→SSTable write path, size-tiered/leveled/FIFO compaction, bloom filters, read/write/space amplification, RocksDB/LevelDB/Cassandra ecosystem | SDE-2 |
| [databases/kafka-internals.md](./databases/kafka-internals.md) | Log segments, zero-copy sendfile, OS page cache, ISR/HW/LEO, producer acks, consumer group offsets, exactly-once, Redpanda | SDE-2 |
| [databases/kafka-field-guide.md](./databases/kafka-field-guide.md) | Narrative field guide: brokers/controller, topics/partitions, ISR & under-replicated vs. offline, producers, consumer group rebalances, offsets/lag, retention, Schema Registry, Connect, ACLs, UI cheat sheet & glossary | SDE-1/2 |
| [databases/clickhouse-internals.md](./databases/clickhouse-internals.md) | MergeTree family, columnar storage, granules, vectorized execution, materialized views | SDE-2 |
| [databases/elasticsearch-internals.md](./databases/elasticsearch-internals.md) | Inverted index, segments, sharding, replication, mappings, Query DSL, aggregations, ILM, performance | SDE-2 |
| [databases/replication.md](./databases/replication.md) | Sync/async/semi-sync, WAL shipping, logical vs physical, PostgreSQL/MySQL/MongoDB/Redis/Kafka replication, Raft/Paxos, cross-region | SDE-2 |
| [databases/caching.md](./databases/caching.md) | Cache tiers, eviction policies, cache-aside/write-through/write-behind, Redis vs Memcached, stampede, warming, consistency | SDE-1/2 |

**Read order:** README → postgres-internals → mysql-internals → mongodb-internals → redis-internals → etcd → lsm-trees → kafka-internals → kafka-field-guide → clickhouse-internals → elasticsearch-internals → replication → caching

---

## 16. Databases on Kubernetes (On-Prem / GKE)

Running stateful databases on Kubernetes — system design, replication, failover, snapshots, and operational runbooks.

| File | Topics | Level |
|------|--------|-------|
| [on-prem-k8s/README.md](./on-prem-k8s/README.md) | Why run DBs on K8s, sync vs async replication, 3-2-1 snapshot strategy | SDE-2 |
| [on-prem-k8s/postgres.md](./on-prem-k8s/postgres.md) | Patroni HA, sync/async replication, automatic failover, PITR, PgBouncer, monitoring | SDE-2 |
| [on-prem-k8s/mysql.md](./on-prem-k8s/mysql.md) | InnoDB Cluster, Group Replication (Paxos), MySQL Router, XtraBackup, failover | SDE-2 |
| [on-prem-k8s/mongodb.md](./on-prem-k8s/mongodb.md) | Replica set, oplog, write/read concern, election, readPreference options | SDE-2 |
| [on-prem-k8s/redis-cluster.md](./on-prem-k8s/redis-cluster.md) | Hash slots, 6-node cluster, failover gossip, RDB vs AOF, backups | SDE-2 |
| [on-prem-k8s/kafka.md](./on-prem-k8s/kafka.md) | Strimzi operator, ISR, partition leader election, min.insync.replicas, MirrorMaker | SDE-2 |
| [on-prem-k8s/clickhouse.md](./on-prem-k8s/clickhouse.md) | ClickHouse Operator, sharding, async replication, clickhouse-backup | SDE-2 |

**Read order:** README → postgres → mysql → mongodb → redis-cluster → kafka → clickhouse

---

## 17. System Design

| File | Topics | Level |
|------|--------|-------|
| [system-design/README.md](./system-design/README.md) | Index and read order | — |
| [system-design/scaling.md](./system-design/scaling.md) | 3-tier architecture, vertical vs horizontal scaling, DB read replicas, sharding strategies, resharding, consistent hashing, celebrity problem (hot key), fan-out patterns, circuit breaker, backpressure | SDE-1/2 |
| [system-design/cap-pacelc.md](./system-design/cap-pacelc.md) | CAP theorem, CP vs AP systems, consistency models (linearizable→eventual), PACELC, quorum math (W+R>N), vector clocks, tunable consistency | SDE-2 |
| [system-design/rate-limiting.md](./system-design/rate-limiting.md) | Fixed window, sliding window, token bucket, leaky bucket — Redis implementation, distributed rate limiting, nginx, AWS API GW | SDE-1/2 |
| [system-design/async-patterns.md](./system-design/async-patterns.md) | Message queues, pub/sub, DLQ, Saga (choreography/orchestration), outbox pattern, CQRS, event sourcing, idempotency, backpressure | SDE-2 |
| [system-design/api-design.md](./system-design/api-design.md) | REST vs GraphQL vs gRPC, versioning, pagination (cursor/keyset), idempotency keys, API gateway, auth patterns, webhooks, OpenAPI | SDE-1/2 |
| [system-design/distributed-transactions.md](./system-design/distributed-transactions.md) | Dual-write problem, 2PC, Saga, outbox pattern, CDC/Debezium, distributed locking (Redlock), optimistic concurrency, TCC | SDE-2 |
| [system-design/file-transfer-storage.md](./system-design/file-transfer-storage.md) | Presigned URLs, multipart/resumable upload (tus), chunking + content-addressable dedup, replication vs erasure coding, metadata service design, CDN delivery | SDE-2 |
| [system-design/realtime-chat.md](./system-design/realtime-chat.md) | WebSocket/long-polling/SSE, connection registry + cross-server relay, delivery guarantees, presence, multi-device fan-out, MQTT (QoS, retained/LWT, MQTTS), WebRTC calling (STUN/TURN, mesh/SFU/MCU, SRTP/DTLS-SRTP, E2E vs transport encryption) | SDE-2 |
| [system-design/end-to-end-encryption.md](./system-design/end-to-end-encryption.md) | Signal Protocol (X3DH, Double Ratchet), hybrid symmetric/asymmetric model, Sender Keys for group chat, multi-device encryption, encrypted backups (HSM Backup Key Vault), server-visibility architecture, scale (Erlang/BEAM, FreeBSD) | SDE-2 |
| [system-design/distributed-id-generation.md](./system-design/distributed-id-generation.md) | UUID v4 vs ULID/UUIDv7, Twitter Snowflake bit layout, clock-drift handling, ticket servers, range/segment allocation | SDE-2 |
| [system-design/geospatial-services.md](./system-design/geospatial-services.md) | Geohashing, quadtrees, S2 geometry, Redis GEO commands, real-time location write-amplification, ride-hailing driver-rider matching, KNN vs radius search | SDE-2 |
| [system-design/probabilistic-data-structures.md](./system-design/probabilistic-data-structures.md) | Bloom filter recap, HyperLogLog cardinality estimation (live simulator), Count-Min Sketch frequency estimation | SDE-2 |

**Read order:** scaling → cap-pacelc → rate-limiting → async-patterns → api-design → distributed-transactions → file-transfer-storage → realtime-chat → end-to-end-encryption → distributed-id-generation → geospatial-services → probabilistic-data-structures

---

## 18. SRE & Debugging

| File | Topics | Level |
|------|--------|-------|
| [sre/README.md](./sre/README.md) | Index + quick triage cheatsheets | — |
| [sre/k8s-debugging.md](./sre/k8s-debugging.md) | 5XX runbooks (K8s + EKS) with Prevention, OOMKilled recovery; debugging without SSH: ephemeral containers, netshoot, port-forward decision tree, CloudWatch Logs Insights, X-Ray | SDE-1/2 |
| [sre/k8s-scenarios.md](./sre/k8s-scenarios.md) | 21 K8s scenarios with Prevention: CrashLoop, Pending, all-replicas-on-one-node outage, DNS, NetworkPolicy, HPA, rollout, webhooks, etcd, RBAC | SDE-1/2 |
| [sre/linux-debugging.md](./sre/linux-debugging.md) | 10 Linux scenarios with Prevention: high CPU, I/O wait, zombies, FD exhaustion, inodes, NFS, OOM, kernel panic | SDE-1/2 |
| [sre/aws-scenarios.md](./sre/aws-scenarios.md) | 10 AWS scenarios with Prevention: EC2 SSH, Lambda timeout, ALB 502, S3 denied, RDS refused, ECS restart, CF stuck, API GW 429, EKS nodes, high bill | SDE-1/2 |
| [sre/cicd-scenarios.md](./sre/cicd-scenarios.md) | 8 CI/CD scenarios with Prevention: GHA OIDC, job hangs, ArgoCD sync, Jenkins Docker, flaky tests | SDE-1/2 |
| [sre/iac-scenarios.md](./sre/iac-scenarios.md) | 8 IaC scenarios with Prevention: tf resource exists, unexpected destroy, state lock, drift, module conflict, sensitive values, Helm timeout, CF rollback | SDE-1/2 |
| [sre/sre-concepts.md](./sre/sre-concepts.md) | SLOs, error budgets, MTTD/MTTR, toil, incident lifecycle, blameless postmortem template, on-call best practices, runbook structure, leader election (client-go Lease API) | SDE-2 |
| [sre/self-healing-aiops.md](./sre/self-healing-aiops.md) | Argo Events + Argo Workflows remediation loop, top 5 auto-remediation scenarios, AIOps LLM agent (LangChain + Loki + RAG), human approval gate, remediation metrics | SDE-2 |
| [sre/db-monitoring.md](./sre/db-monitoring.md) | Prometheus + Grafana for PostgreSQL, MySQL, Redis, MongoDB on-prem | SDE-2 |
| [sre/scenarios-scheduling-scaling.md](./sre/scenarios-scheduling-scaling.md) | Pod Pending (label+CPU insufficient), rolling update maxSurge/maxUnavailable stuck-old-pod math, orphaned Pending pod after a second fix/edit (why maxSurge/maxUnavailable don't fix it, `progressDeadlineSeconds` + cleanup automation), `/var/log` ENOSPC despite free space (inodes, deleted-open FDs, reserved blocks), ASG predictive scaling, warm pools, unpredictable burst scaling, ALB/NLB LCU pre-warming, HPA/rollout/Cluster Autoscaler ceiling-vs-floor math | SDE-1/2 |
| [sre/oncall-tooling.md](./sre/oncall-tooling.md) | PagerDuty Services/Escalation Policies/Schedules/Event Orchestration, Alertmanager severity-based routing, PagerDuty vs Opsgenie, alert fatigue metrics (MTTA, actionable %), on-call schedule patterns, ChatOps/incident command integration, post-incident review automation | SDE-1/2 |

**Read order:** README → k8s-debugging → k8s-scenarios → linux-debugging → aws-scenarios → cicd-scenarios → iac-scenarios → sre-concepts → self-healing-aiops → db-monitoring → scenarios-scheduling-scaling → oncall-tooling

---

## 19. Coding Practice

DSA implementations in Go **and Python**, relevant to backend/infra engineering interviews — B-trees, skip lists, LRU cache, rate limiting, consistent hashing, bloom filters, and common concurrency patterns. Every structure ships with a heavy-visualization treatment (Mermaid diagrams, step-through walkthroughs of inserts/splits/evictions) and knowledge-check quizzes, matching the same interactive pattern used across the rest of the repo — see [Read it interactively](#read-it-interactively) below.

| File | Topics | Level |
|------|--------|-------|
| [coding-practice/README.md](./coding-practice/README.md) | Index and interview relevance of each topic | — |
| [coding-practice/concurrent-patterns.md](./coding-practice/concurrent-patterns.md) | Mutex vs atomic counter, bounded worker pool, channel pub/sub, debounce/throttle, goroutine/thread leak detection + fix | SDE-1/2 |
| [coding-practice/btree.md](./coding-practice/btree.md) | B-tree vs B+tree, node-split-on-insert from scratch, linked-leaf range scans — the structure behind Postgres/MySQL default indexes | SDE-2 |
| [coding-practice/skip-list.md](./coding-practice/skip-list.md) | Randomized-level skip list from scratch, insert/search traversal — the structure behind Redis sorted sets | SDE-2 |
| [coding-practice/lru-cache.md](./coding-practice/lru-cache.md) | Doubly linked list + hashmap from scratch, thread-safe variant, LFU comparison, TTL-eviction variant | SDE-1/2 |
| [coding-practice/rate-limiter-implementations.md](./coding-practice/rate-limiter-implementations.md) | Token bucket, leaky bucket, fixed window, sliding window log — full code + HTTP middleware wrapper | SDE-1/2 |
| [coding-practice/consistent-hashing.md](./coding-practice/consistent-hashing.md) | Hash ring with virtual nodes, rebalancing on node add/remove, full implementation | SDE-2 |
| [coding-practice/bloom-filter.md](./coding-practice/bloom-filter.md) | False-positive rate math, double hashing, infra use cases (DB lookup pre-check, stream dedup) | SDE-2 |

**Read order:** README → concurrent-patterns → btree → skip-list → lru-cache → rate-limiter-implementations → consistent-hashing → bloom-filter

---

## 20. Platform Engineering

Internal Developer Platforms, automation engines, and AI SRE agents.

| File | Topics | Level |
|------|--------|-------|
| [platform-engineering/README.md](./platform-engineering/README.md) | What is Platform Engineering, CNCF maturity model, Team Topologies, IDP capabilities | SDE-2 |
| [platform-engineering/idp-concepts.md](./platform-engineering/idp-concepts.md) | Golden paths, DORA metrics, SPACE framework, developer experience measurement | SDE-2 |
| [platform-engineering/backstage.md](./platform-engineering/backstage.md) | Service catalog, TechDocs, scaffolder templates, plugins | SDE-2 |
| [platform-engineering/crossplane.md](./platform-engineering/crossplane.md) | K8s-native IaC, composite resources, claim-based self-service | SDE-2 |
| [platform-engineering/developer-self-service.md](./platform-engineering/developer-self-service.md) | ApplicationSets, PR environments, self-service provisioning patterns | SDE-2 |
| [platform-engineering/multi-tenancy.md](./platform-engineering/multi-tenancy.md) | vcluster, Capsule, HNC, namespace isolation, RBAC patterns | SDE-2 |
| [platform-engineering/platform-observability.md](./platform-engineering/platform-observability.md) | DORA metrics pipeline, Keptn, deployment frequency tracking | SDE-2 |
| [platform-engineering/cost-attribution.md](./platform-engineering/cost-attribution.md) | Kubecost, OpenCost, FinOps, showback vs chargeback | SDE-2 |
| [platform-engineering/workflow-automation.md](./platform-engineering/workflow-automation.md) | n8n (visual workflows, K8s deploy), Temporal (durable execution, compensation), Argo Workflows (K8s-native CNCF, DAG pods), Kestra (YAML-first, 500+ plugins), comparison table | SDE-2 |
| [platform-engineering/ai-sre-agents.md](./platform-engineering/ai-sre-agents.md) | k8sgpt (cluster scanning, operator, air-gap), Robusta (playbooks, HolmesGPT), OpenSRE (agentic incident investigation, 60+ integrations), Coroot (eBPF auto-instrumentation, AI root cause), agentic SRE patterns | SDE-2/3 |

**Read order:** README → idp-concepts → backstage → crossplane → developer-self-service → multi-tenancy → platform-observability → cost-attribution → workflow-automation → ai-sre-agents

---

## Full Learning Path

```
── SDE-1 ──────────────────────────────────────────────────
linux/README.md → linux/commands.md → linux/boot.md
linux/systemd.md → linux/networking.md → linux/network-tools.md
linux/signals.md → linux/containers-evolution.md
docker/README.md → docker/networking.md → docker/debugging.md
kubernetes/kubectl-cheatsheet.md → kubernetes/README.md
kubernetes/workloads.md → kubernetes/resource-limits.md
kubernetes/networking.md → kubernetes/coredns.md → kubernetes/storage.md → kubernetes/rbac.md
kubernetes/helm.md
go/README.md → go/concurrency.md
cicd/README.md → cicd/github-actions → cicd/argocd
iac/terraform → iac/cloudformation
aws/README.md → aws/services-overview.md → aws/storage-databases.md
aws/messaging-serverless-observability.md
monitoring/prometheus.md → monitoring/alertmanager.md → monitoring/grafana.md
monitoring/alerting-philosophy.md → monitoring/loki.md
git/git-workflows.md → git/git-fixes.md
sre/k8s-debugging.md → sre/k8s-scenarios.md (first half)
sre/aws-scenarios.md
coding-practice/README.md → coding-practice/lru-cache.md → coding-practice/rate-limiter-implementations.md

── SDE-2 ──────────────────────────────────────────────────
linux/io-models.md → linux/scheduler.md → linux/security.md
linux/memory-tuning.md → linux/strace-perf.md
linux/cgroup-v2.md → linux/proc-internals.md → linux/ebpf-bpftrace.md
docker/buildkit.md → docker/docker-security.md
kubernetes/autoscaling.md → kubernetes/eks-architecture.md
kubernetes/pod-lifecycle.md → kubernetes/kube-proxy-modes.md
kubernetes/cross-node-networking.md → kubernetes/node-shutdown.md
go/context.md → go/sync-primitives.md
aws/databases-deep-dive.md
monitoring/opentelemetry.md → monitoring/performance-debugging.md
monitoring/slo-sli.md → monitoring/thanos-mimir.md
sre/db-monitoring.md
gcp/from-aws.md → gcp/README.md → gcp/services-overview.md
gcp/compute.md → gcp/gke.md
gcp/storage.md → gcp/databases.md → gcp/bigquery.md → gcp/bigtable.md
gcp/serverless.md → gcp/messaging.md
gcp/observability.md → gcp/cicd.md → gcp/gcp-vs-aws.md → gcp/scenarios.md
git/git-internals.md
advanced/service-mesh.md → advanced/ebpf-observability.md
advanced/chaos-engineering.md → advanced/chaos-engineering-handson.md → advanced/backup-dr.md → advanced/dr-zero-downtime.md
advanced/low-latency-networking.md → advanced/fintech-security.md → advanced/fintech-compliance.md → advanced/trading-systems.md → advanced/trading-data-streaming.md
iac/pulumi → networking/grpc-deep-dive.md
cicd/jenkins/plugin-development.md → cicd/gitops-secrets.md → cicd/argo-rollouts.md
sre/k8s-scenarios.md (advanced) → sre/linux-debugging.md
sre/cicd-scenarios.md → sre/iac-scenarios.md
sre/sre-concepts.md → sre/oncall-tooling.md
coding-practice/btree.md → coding-practice/skip-list.md → coding-practice/consistent-hashing.md → coding-practice/bloom-filter.md → coding-practice/concurrent-patterns.md
```
