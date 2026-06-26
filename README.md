# DevOps Reference

Kubernetes, Linux, Docker, AWS, GCP, CI/CD, IaC, Monitoring, Git, and SRE — ordered from foundation to advanced.

---

## Recommended Order

```
1.  Linux fundamentals       → understand what everything runs on
2.  Networking               → TCP, TLS, HTTP, gRPC — how data moves
3.  Docker                   → containers before orchestration
4.  Kubernetes               → orchestration, networking, security
5.  CI/CD                    → build and deploy pipelines
6.  IaC                      → Terraform, Helm, CloudFormation
7.  AWS                      → cloud infrastructure
8.  GCP                      → GCP equivalents + BigQuery, Bigtable, GKE
9.  Monitoring               → Prometheus, Grafana, OTel, Loki
10. Git                      → internals, workflows, fixing mistakes
11. Advanced                 → service mesh, eBPF, chaos, DR
12. AI Infrastructure        → GPU scheduling, KubeRay, vLLM, LLMOps
13. MLOps                    → experiment tracking, pipelines, drift detection
14. Database Internals       → WAL, MVCC, indexes, replication internals
15. Databases on K8s         → running Postgres, Kafka, Redis on GKE
16. SRE & Debugging          → production incident runbooks
```

---

## 1. Linux

| File | Topics | Level |
|------|--------|-------|
| [linux/README.md](./linux/README.md) | Process model, memory, filesystem, signals, load average | SDE-1 |
| [linux/commands.md](./linux/commands.md) | grep, awk, sed, find, ps, ss, curl, disk management | SDE-1 |
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
| [linux/signals.md](./linux/signals.md) | SIGTERM vs SIGKILL internals, signal delivery, signal masks, SIGCHLD/zombies, Go graceful shutdown | SDE-1/2 |

**Read order:** README → commands → boot → systemd → networking → network-tools → io-models → scheduler → security → memory-tuning → strace-perf → containers-evolution → cgroup-v2 → proc-internals → ebpf-bpftrace → signals

---

## 2. Networking

| File | Topics | Level |
|------|--------|-------|
| [networking/README.md](./networking/README.md) | Index and read order | — |
| [networking/osi-model.md](./networking/osi-model.md) | 7 OSI layers, full HTTPS request flow layer-by-layer (curl google.com), encapsulation, debug by layer | SDE-1 |
| [networking/tcp-udp.md](./networking/tcp-udp.md) | TCP 3-way handshake, 4-way teardown, state machine, flow/congestion control, TIME_WAIT, UDP, when to use each | SDE-1/2 |
| [networking/tls-encryption.md](./networking/tls-encryption.md) | Symmetric vs asymmetric, TLS 1.2 vs 1.3 handshake (RTT comparison), certificate chain, validation steps, openssl debugging | SDE-1/2 |
| [networking/http-versions.md](./networking/http-versions.md) | HTTP/1.1 vs HTTP/2 vs HTTP/3, HOL blocking, binary framing, status codes, methods, caching (ETag), CORS | SDE-1 |
| [networking/linux-networking.md](./networking/linux-networking.md) | Linux packet RX/TX path, netfilter hooks, conntrack, network namespaces, veth pairs, SO_REUSEPORT | SDE-2 |
| [networking/grpc-graphql.md](./networking/grpc-graphql.md) | gRPC on HTTP/2, Protobuf encoding, 4 streaming modes, connection flow; GraphQL SDL, N+1 problem, DataLoader | SDE-1/2 |

**Read order:** osi-model → tcp-udp → tls-encryption → http-versions → grpc-graphql

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
| [kubernetes/networking.md](./kubernetes/networking.md) | Services, ClusterIP/iptables, DNS, Ingress, NetworkPolicy, CNI, per-node virtual networks | SDE-1/2 |
| [kubernetes/resource-limits.md](./kubernetes/resource-limits.md) | Requests vs limits, CPU throttling math, OOMKill, QoS classes, LimitRange, ResourceQuota, node allocatable chain, VPA | SDE-1/2 |
| [kubernetes/storage.md](./kubernetes/storage.md) | PV/PVC/StorageClass, dynamic provisioning, CSI, volume snapshots | SDE-1 |
| [kubernetes/autoscaling.md](./kubernetes/autoscaling.md) | HPA, VPA, KEDA, Cluster Autoscaler, Karpenter | SDE-2 |
| [kubernetes/rbac.md](./kubernetes/rbac.md) | ServiceAccount, Role/ClusterRole, RoleBinding, auth chain | SDE-1 |
| [kubernetes/helm.md](./kubernetes/helm.md) | Chart structure, templating, hooks, library charts, Helmfile, debugging | SDE-1/2 |
| [kubernetes/eks-architecture.md](./kubernetes/eks-architecture.md) | EKS managed control plane, VPC CNI, IRSA, node groups, Fargate | SDE-1/2 |
| [kubernetes/coredns.md](./kubernetes/coredns.md) | Corefile plugins, ndots:5 problem + fix, forwarding, caching, dnsPolicy options, debugging, NodeLocal DNSCache | SDE-1/2 |
| [kubernetes/pod-lifecycle.md](./kubernetes/pod-lifecycle.md) | Startup sequence (sandbox→CNI→image→probes→Endpoints), admission controller chain, server-side apply, termination race + preStop fix | SDE-2 |
| [kubernetes/kube-proxy-modes.md](./kubernetes/kube-proxy-modes.md) | iptables O(n) + conntrack, IPVS O(1) + LB algorithms, Cilium/eBPF socket-level LB (no DNAT), comparison | SDE-2 |
| [kubernetes/cross-node-networking.md](./kubernetes/cross-node-networking.md) | Same-node veth/bridge, VXLAN overlay, Calico BGP direct routing, AWS VPC CNI flat network, MTU table | SDE-2 |
| [kubernetes/hpa-vpa-internals.md](./kubernetes/hpa-vpa-internals.md) | HPA internals every stage, VPA components, singleton VPA, HPA+VPA conflict | SDE-1/2 |
| [kubernetes/scheduler-internals.md](./kubernetes/scheduler-internals.md) | Filter+Score plugins, FailedScheduling events, full pod scheduling sequence | SDE-1/2 |
| [kubernetes/policy-security.md](./kubernetes/policy-security.md) | OPA/Gatekeeper, Kyverno (validate/mutate/generate), multi-tenancy, ResourceQuota, NetworkPolicy isolation, PSA, seccomp, AppArmor | SDE-2 |
| [kubernetes/node-shutdown.md](./kubernetes/node-shutdown.md) | Graceful shutdown (systemd inhibitor), pod eviction ordering, node drain, non-graceful shutdown + out-of-service taint, lifecycle taints | SDE-2 |

**Read order:** kubectl-cheatsheet → README → workloads → resource-limits → networking → coredns → storage → rbac → autoscaling → helm → eks-architecture → pod-lifecycle → kube-proxy-modes → cross-node-networking → node-shutdown

---

## 5. CI/CD

| File | Topics | Level |
|------|--------|-------|
| [cicd/README.md](./cicd/README.md) | CI vs CD vs GitOps, pipeline patterns, deployment strategies, secrets | SDE-1 |
| [cicd/github-actions/README.md](./cicd/github-actions/README.md) | Workflows, OIDC to AWS, matrix builds, caching, reusable workflows | SDE-1 |
| [cicd/jenkins/README.md](./cicd/jenkins/README.md) | Declarative pipeline, shared libraries, master-agent architecture | SDE-1 |
| [cicd/jenkins/ecs-agents.md](./cicd/jenkins/ecs-agents.md) | Dynamic Jenkins agents on ECS Fargate, cost optimization | SDE-2 |
| [cicd/argocd/README.md](./cicd/argocd/README.md) | GitOps, Application CRD, sync waves, multi-cluster with ApplicationSet, RBAC, Projects, SSO | SDE-1/2 |
| [cicd/gitops-secrets.md](./cicd/gitops-secrets.md) | Sealed Secrets vs ESO, EKS/IRSA pattern, secret rotation, decision framework | SDE-2 |
| [cicd/pipeline-design.md](./cicd/pipeline-design.md) | Java CI end-to-end, CD to 2 clusters, ArgoCD vs GHA deploy, Helm create/install/upgrade, SDE-1 vs SDE-2 classification | SDE-1/2 |
| [cicd/argo-rollouts.md](./cicd/argo-rollouts.md) | Canary (steps + Prometheus analysis + ALB), blue-green, kubectl plugin, ArgoCD integration | SDE-2 |

---

## 6. Infrastructure as Code

| File | Topics | Level |
|------|--------|-------|
| [iac/README.md](./iac/README.md) | IaC overview, Terraform vs CloudFormation, state, drift | SDE-1 |
| [iac/terraform/README.md](./iac/terraform/README.md) | HCL, state, modules, workspaces deep-dive, Terragrunt, remote backend (S3+DynamoDB), import, moved block, check block, terraform test framework | SDE-1/2 |
| [iac/cloudformation/README.md](./iac/cloudformation/README.md) | Templates, stacks, change sets, nested stacks, StackSets, custom resources | SDE-1 |

---

## 7. AWS

| File | Topics | Level |
|------|--------|-------|
| [aws/README.md](./aws/README.md) | VPC, subnets, SGs vs NACLs, NAT GW, IGW, VPC Peering, Transit Gateway | SDE-1 |
| [aws/ecs-fargate.md](./aws/ecs-fargate.md) | ECS Fargate task definition, networking, rolling updates, auto scaling, debugging | SDE-1/2 |
| [aws/request-flow-alb-to-pod.md](./aws/request-flow-alb-to-pod.md) | Route53→ALB→TargetGroup→Pod full flow, ALB vs NLB, L4 vs L7, debug commands | SDE-1/2 |
| [aws/services-overview.md](./aws/services-overview.md) | IAM, ALB/NLB, Route 53, ECS vs EKS, TLS/mTLS | SDE-1 |
| [aws/storage-databases.md](./aws/storage-databases.md) | S3, RDS, Aurora, ElastiCache, DynamoDB, EBS vs EFS | SDE-1 |
| [aws/databases-deep-dive.md](./aws/databases-deep-dive.md) | Aurora internals, DocumentDB, DynamoDB single-table design, DAX, 8 scenarios | SDE-2 |
| [aws/messaging-serverless-observability.md](./aws/messaging-serverless-observability.md) | SQS, SNS, EventBridge, Lambda, CloudWatch, Secrets Manager, multi-account, cost | SDE-1/2 |

---

## 8. GCP

| File | Topics | Level |
|------|--------|-------|
| [gcp/README.md](./gcp/README.md) | Global VPC, subnets, firewall rules, Cloud NAT, VPC Peering, Shared VPC | SDE-1/2 |
| [gcp/services-overview.md](./gcp/services-overview.md) | IAM, Workload Identity, Cloud LB, Cloud DNS, Cloud Run vs GKE | SDE-1/2 |
| [gcp/gke.md](./gcp/gke.md) | GKE Standard vs Autopilot, Workload Identity, VPC-native networking, container-native LB (NEG), GPU pools, upgrade channels | SDE-2 |
| [gcp/bigquery.md](./gcp/bigquery.md) | Columnar storage, partitioning, clustering, slots, streaming vs batch, external tables, time travel, cost optimization | SDE-1/2 |
| [gcp/bigtable.md](./gcp/bigtable.md) | Wide-column model, row key design (hotspot prevention), LSM tree, HBase API, monitoring | SDE-2 |
| [gcp/gcp-vs-aws.md](./gcp/gcp-vs-aws.md) | Full service mapping, global VPC vs regional VPC, BigQuery vs Redshift, GKE vs EKS, TPUs, when to choose | SDE-1/2 |
| [gcp/scenarios.md](./gcp/scenarios.md) | 7 scenarios with Prevention: Workload Identity 403, autoscaler stuck, BigQuery cost spike, Cloud Run cold start, Spanner hotspot, Pub/Sub backlog, GCS 403 | SDE-1/2 |

---

## 9. Monitoring & Observability

| File | Topics | Level |
|------|--------|-------|
| [monitoring/prometheus.md](./monitoring/prometheus.md) | Architecture, data model (4 types + math), TSDB internals, 12+ PromQL queries, scrape config, recording rules, 5 production alerts, scenarios | SDE-1/2 |
| [monitoring/alertmanager.md](./monitoring/alertmanager.md) | Routing tree, grouping, inhibition, silences, complete config, debugging | SDE-1/2 |
| [monitoring/grafana.md](./monitoring/grafana.md) | Panel types, variables, USE/RED/SLO dashboards, provisioning as code | SDE-1/2 |
| [monitoring/opentelemetry.md](./monitoring/opentelemetry.md) | Three pillars (traces/metrics/logs), OTEL Collector, Go SDK, auto-instrumentation | SDE-2 |
| [monitoring/loki.md](./monitoring/loki.md) | Architecture, labels vs content, LogQL, Promtail config, trace correlation | SDE-1/2 |
| [monitoring/performance-debugging.md](./monitoring/performance-debugging.md) | USE method, RED method, 60-second checklist, Go pprof, bpftrace one-liners | SDE-2 |
| [monitoring/monitoring-scenarios.md](./monitoring/monitoring-scenarios.md) | 12 scenarios with Prevention: target DOWN, missing metrics, Prometheus OOM, slow PromQL, alert not notifying, alert storm, Grafana no data, Loki missing logs, no OTEL traces, K8s scrape issues | SDE-1/2 |
| [monitoring/slo-sli.md](./monitoring/slo-sli.md) | SLI/SLO/Error Budget math, multi-window multi-burn-rate alerts, recording rules, Grafana SLO dashboard, decision framework | SDE-2 |
| [monitoring/alerting-philosophy.md](./monitoring/alerting-philosophy.md) | Four Golden Signals + PromQL, symptoms vs causes, alert fatigue, urgency tiers, runbook structure, USE vs RED vs Golden Signals | SDE-1/2 |
| [monitoring/thanos-mimir.md](./monitoring/thanos-mimir.md) | Thanos components (sidecar/querier/store/compactor), Mimir distributed TSDB, long-term S3 storage, deduplication, downsampling, when to use each | SDE-2 |
| [sre/db-monitoring.md](./sre/db-monitoring.md) | Prometheus + Grafana for PostgreSQL, MySQL, Redis, MongoDB | SDE-2 |

---

## 10. Git

| File | Topics | Level |
|------|--------|-------|
| [git/git-internals.md](./git/git-internals.md) | Object model (blob/tree/commit/tag), refs, pack files, merge vs rebase internals, reflog | SDE-1/2 |
| [git/git-workflows.md](./git/git-workflows.md) | Trunk-based vs GitFlow vs GitHub Flow, monorepo, branch protection, conventional commits | SDE-1 |
| [git/git-fixes.md](./git/git-fixes.md) | reset modes, amend, reflog recovery, interactive rebase, bisect, detached HEAD, secrets removal | SDE-1 |

---

## 11. Advanced

| File | Topics | Level |
|------|--------|-------|
| [advanced/service-mesh.md](./advanced/service-mesh.md) | Istio control/data plane, VirtualService, mTLS, circuit breaking, Linkerd vs Istio | SDE-2 |
| [advanced/ebpf-observability.md](./advanced/ebpf-observability.md) | eBPF verifier, bpftrace, BCC tools, Cilium, Tetragon, Hubble | SDE-2 |
| [advanced/chaos-engineering.md](./advanced/chaos-engineering.md) | Litmus Chaos, Chaos Mesh, game days, failure injection patterns | SDE-2 |
| [advanced/backup-dr.md](./advanced/backup-dr.md) | RTO/RPO math, Velero, etcd backup, PITR, AWS DR patterns, 3-2-1 rule | SDE-2 |

---

## 12. AI Infrastructure & LLMOps

The natural extension of K8s/Linux expertise into AI/ML platform engineering.

| File | Topics | Level |
|------|--------|-------|
| [ai-infra/README.md](./ai-infra/README.md) | Index, learning path (Phase 1-3), AI vs standard K8s workload differences | SDE-2 |
| [ai-infra/gpu-scheduling.md](./ai-infra/gpu-scheduling.md) | NVIDIA Device Plugin, extended resources, MIG slicing, GPU Operator, DCGM metrics, gang scheduling | SDE-2 |
| [ai-infra/kuberay.md](./ai-infra/kuberay.md) | KubeRay operator, RayCluster CRD, RayJob, RayService, autoscaling to zero, observability | SDE-2 |
| [ai-infra/model-serving.md](./ai-infra/model-serving.md) | KServe InferenceService, vLLM continuous batching, PagedAttention, KV cache, canary rollouts, KEDA scaling | SDE-2 |
| [ai-infra/llmops.md](./ai-infra/llmops.md) | RAG pipeline, pgvector/Milvus, LangSmith/OpenLLMetry tracing, NeMo guardrails, cost optimization, drift detection | SDE-2 |
| [ai-infra/networking.md](./ai-infra/networking.md) | NVLink/NVSwitch, InfiniBand, RoCE, AWS EFA, NCCL AllReduce, Cilium for inference, fat-tree topology | SDE-2 |

**Read order:** gpu-scheduling → kuberay → model-serving → llmops

---

## 13. MLOps

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

## 14. Database Internals

Storage engines, WAL, MVCC, replication internals, indexing, and query execution for each database.

| File | Topics | Level |
|------|--------|-------|
| [databases/README.md](./databases/README.md) | WAL concept, MVCC, common patterns | SDE-2 |
| [databases/postgres-internals.md](./databases/postgres-internals.md) | Buffer pool, WAL/LSN, MVCC with xmin/xmax, VACUUM, B-tree/GIN/BRIN indexes, EXPLAIN ANALYZE, PgBouncer | SDE-2 |
| [databases/mysql-internals.md](./databases/mysql-internals.md) | InnoDB buffer pool, redo log, undo log, MVCC, clustered B-tree, binlog, GTID replication | SDE-2 |
| [databases/mongodb-internals.md](./databases/mongodb-internals.md) | WiredTiger cache, journal, oplog internals, aggregation pipeline, index types, write/read concern | SDE-2 |
| [databases/redis-internals.md](./databases/redis-internals.md) | Data structure encodings, RDB vs AOF, eviction policies, replication, cluster hash slots | SDE-1/2 |
| [databases/kafka-internals.md](./databases/kafka-internals.md) | Log segments, ISR/HW/LEO, producer acks, consumer group offsets, exactly-once, log compaction | SDE-2 |
| [databases/clickhouse-internals.md](./databases/clickhouse-internals.md) | MergeTree family, columnar storage, granules, vectorized execution, materialized views | SDE-2 |

---

## 15. Databases on Kubernetes (On-Prem / GKE)

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

---

## 16. SRE & Debugging

| File | Topics | Level |
|------|--------|-------|
| [sre/README.md](./sre/README.md) | Index + quick triage cheatsheets | — |
| [sre/k8s-debugging.md](./sre/k8s-debugging.md) | 5XX runbooks (K8s + EKS) with Prevention, OOMKilled recovery | SDE-1/2 |
| [sre/k8s-scenarios.md](./sre/k8s-scenarios.md) | 20 K8s scenarios with Prevention: CrashLoop, DNS, NetworkPolicy, HPA, rollout, webhooks, etcd, RBAC | SDE-1/2 |
| [sre/linux-debugging.md](./sre/linux-debugging.md) | 10 Linux scenarios with Prevention: high CPU, I/O wait, zombies, FD exhaustion, inodes, NFS, OOM, kernel panic | SDE-1/2 |
| [sre/aws-scenarios.md](./sre/aws-scenarios.md) | 10 AWS scenarios with Prevention: EC2 SSH, Lambda timeout, ALB 502, S3 denied, RDS refused, ECS restart, CF stuck, API GW 429, EKS nodes, high bill | SDE-1/2 |
| [sre/cicd-scenarios.md](./sre/cicd-scenarios.md) | 8 CI/CD scenarios with Prevention: GHA OIDC, job hangs, ArgoCD sync, Jenkins Docker, flaky tests | SDE-1/2 |
| [sre/iac-scenarios.md](./sre/iac-scenarios.md) | 8 IaC scenarios with Prevention: tf resource exists, unexpected destroy, state lock, drift, module conflict, sensitive values, Helm timeout, CF rollback | SDE-1/2 |
| [sre/sre-concepts.md](./sre/sre-concepts.md) | SLOs, error budgets, MTTD/MTTR, toil, incident lifecycle, blameless postmortem template, on-call best practices, runbook structure, leader election (client-go Lease API) | SDE-2 |
| [sre/self-healing-aiops.md](./sre/self-healing-aiops.md) | Argo Events + Argo Workflows remediation loop, top 5 auto-remediation scenarios, AIOps LLM agent (LangChain + Loki + RAG), human approval gate, remediation metrics | SDE-2 |
| [sre/db-monitoring.md](./sre/db-monitoring.md) | Prometheus + Grafana for PostgreSQL, MySQL, Redis, MongoDB on-prem | SDE-2 |

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
cicd/README.md → cicd/github-actions → cicd/argocd
iac/terraform → iac/cloudformation
aws/README.md → aws/services-overview.md → aws/storage-databases.md
aws/messaging-serverless-observability.md
monitoring/prometheus.md → monitoring/alertmanager.md → monitoring/grafana.md
monitoring/alerting-philosophy.md → monitoring/loki.md
git/git-workflows.md → git/git-fixes.md
sre/k8s-debugging.md → sre/k8s-scenarios.md (first half)
sre/aws-scenarios.md

── SDE-2 ──────────────────────────────────────────────────
linux/io-models.md → linux/scheduler.md → linux/security.md
linux/memory-tuning.md → linux/strace-perf.md
linux/cgroup-v2.md → linux/proc-internals.md → linux/ebpf-bpftrace.md
docker/buildkit.md → docker/docker-security.md
kubernetes/autoscaling.md → kubernetes/eks-architecture.md
kubernetes/pod-lifecycle.md → kubernetes/kube-proxy-modes.md
kubernetes/cross-node-networking.md → kubernetes/node-shutdown.md
aws/databases-deep-dive.md
monitoring/opentelemetry.md → monitoring/performance-debugging.md
monitoring/slo-sli.md → monitoring/thanos-mimir.md
sre/db-monitoring.md
gcp/README.md → gcp/services-overview.md
git/git-internals.md
advanced/service-mesh.md → advanced/ebpf-observability.md
advanced/chaos-engineering.md → advanced/backup-dr.md
cicd/gitops-secrets.md → cicd/argo-rollouts.md
sre/k8s-scenarios.md (advanced) → sre/linux-debugging.md
sre/cicd-scenarios.md → sre/iac-scenarios.md
sre/sre-concepts.md
```
