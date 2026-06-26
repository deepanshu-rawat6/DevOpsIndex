# SRE & Debugging Reference

Runbooks, debugging scenarios, and SRE concepts for Kubernetes, Linux, and AWS.

---

## Index

| File | Topics |
|------|--------|
| [k8s-debugging.md](./k8s-debugging.md) | 5XX debugging (K8s + EKS), OOM-Killed recovery, pod state quick reference |
| [k8s-scenarios.md](./k8s-scenarios.md) | CrashLoopBackOff, Pending, ImagePullBackOff, Terminating, NotReady, High Latency, PVC, Quota, DNS, NetworkPolicy, HPA, rollout stuck, webhooks, disk pressure, etcd slow, RBAC 403 |
| [linux-debugging.md](./linux-debugging.md) | High CPU, I/O wait, zombies, FD exhaustion, TIME_WAIT, disk I/O, inodes, NFS, OOM killer, kernel panic |
| [aws-scenarios.md](./aws-scenarios.md) | EC2 SSH timeout, Lambda timeout, ALB 502, S3 denied, RDS refused, ECS restart, CF stuck, API GW 429, EKS nodes not joining, high bill |
| [cicd-scenarios.md](./cicd-scenarios.md) | GHA OIDC auth, job hangs, ArgoCD out-of-sync, ArgoCD ImagePull, Jenkins Docker, wrong env deploy, staging crash, flaky tests |
| [iac-scenarios.md](./iac-scenarios.md) | terraform resource exists, unexpected destroy, state lock, drift, module conflict, sensitive values, Helm timeout, CF ROLLBACK_COMPLETE |
| [sre-concepts.md](./sre-concepts.md) | SLOs, SLAs, error budgets, MTTD/MTTR, incident management lifecycle, blameless postmortem template, on-call best practices |
| [self-healing-aiops.md](./self-healing-aiops.md) | Argo Events + Argo Workflows remediation loop, top 5 auto-remediation scenarios, AIOps LLM agent (LangChain + Loki + runbook RAG), human approval gate |
| [db-monitoring.md](./db-monitoring.md) | Prometheus + Grafana for PostgreSQL, MySQL, Redis, MongoDB on-prem |

---

## K8s Debugging — Quick Triage

```
pod not Running?
  Pending          → kubectl describe pod → FailedScheduling events
  CrashLoopBackOff → kubectl logs --previous + exit code
  ImagePullBackOff → kubectl describe pod → registry/auth/tag
  Terminating      → kubectl get pod -o json | jq .metadata.finalizers

pod Running but broken?
  Requests failing → kubectl exec -- curl localhost:PORT, check logs
  DNS failing      → kubectl exec -- nslookup my-svc
  Can't reach pod  → check NetworkPolicy, check Service endpoints
  High latency     → kubectl top pod, check CPU throttling

node issues?
  NotReady         → kubectl describe node → Conditions + Events
  Disk pressure    → kubectl debug node, df -h on node
  etcd slow        → etcdctl endpoint health, etcdctl defrag
```

## Linux Debugging — Quick Triage

```
high load?
  CPU high + nothing in top → perf top (kernel threads / softirq / steal)
  CPU idle + high load      → iostat -x (iowait), iotop (culprit process)

process issues?
  zombies          → ps -eo pid,ppid,stat | awk '$3~/Z/' → kill parent
  disappeared      → dmesg | grep -i oom (OOM killer)
  fd exhaustion    → lsof -p PID | wc -l, ulimit -n

disk issues?
  no space (df fine) → df -i (inodes exhausted)
  slow writes        → iostat -x (await > 100ms), iotop
  nfs hang           → umount -l, check server reachability

crashes?
  unexpected reboot  → journalctl -b -1 | tail -50
  kernel panic       → dmesg | grep -i panic, /var/crash/vmcore
```
