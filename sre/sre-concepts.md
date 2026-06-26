## Leader Election for Singleton Workloads

If you need exactly one active instance (not zero, not two), use Kubernetes **Lease-based leader election**. The Lease API is a lightweight lock stored in etcd.

**Use cases:** distributed job scheduler, CDC consumer, singleton reconciler, any process that must not run concurrently.

### How It Works

```mermaid
sequenceDiagram
    participant P1 as Pod 1 (candidate)
    participant P2 as Pod 2 (standby)
    participant K8s as K8s API Server (Lease object in etcd)

    P1->>K8s: Try to acquire Lease (create/update with holderIdentity=pod-1)
    K8s-->>P1: Lease acquired — pod-1 is leader
    P2->>K8s: Try to acquire Lease
    K8s-->>P2: Lease held by pod-1, renewDeadline not expired — not acquired

    loop Every leaseDuration/2
        P1->>K8s: Renew lease (update renewTime)
        K8s-->>P1: OK
    end

    Note over P1: Pod 1 OOM-killed / crashes
    Note over K8s: Lease expires (no renewal within leaseDuration)

    P2->>K8s: Try to acquire Lease — lease expired!
    K8s-->>P2: Lease acquired — pod-2 is now leader
    Note over P2: Pod 2 starts doing work
```

### Go Implementation with `client-go`

```go
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

func main() {
	// Identity: use pod name so we can see who is leader
	id := os.Getenv("POD_NAME")
	if id == "" {
		id, _ = os.Hostname()
	}

	// In-cluster config (works when running inside a K8s pod)
	cfg, err := rest.InClusterConfig()
	if err != nil {
		panic(err)
	}
	client := kubernetes.NewForConfigOrDie(cfg)

	// Lease lock — stored as a Lease object in the given namespace
	lock := &resourcelock.LeaseLock{
		LeaseMeta: metav1.ObjectMeta{
			Name:      "my-app-leader",    // Lease object name
			Namespace: "default",
		},
		Client: client.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{
			Identity: id, // pod name — identifies who holds the lease
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock: lock,

		// How long a lease is valid without renewal
		// If the leader crashes, a new leader can only be elected after this duration
		LeaseDuration: 15 * time.Second,

		// How long the leader has to renew before losing leadership
		// Must be < LeaseDuration
		RenewDeadline: 10 * time.Second,

		// How often the leader tries to renew
		// Must be < RenewDeadline
		RetryPeriod: 2 * time.Second,

		// ReleaseOnCancel: release the lease gracefully when context is cancelled
		// (e.g., on SIGTERM). Without this, the lease holds for LeaseDuration
		// after crash, delaying failover.
		ReleaseOnCancel: true,

		Callbacks: leaderelection.LeaderCallbacks{
			// Called when this pod becomes the leader — start your work here
			OnStartedLeading: func(ctx context.Context) {
				fmt.Printf("[%s] became leader — starting work<br>", id)
				runWork(ctx)
			},

			// Called when this pod loses leadership (lease expired, context cancelled)
			// Stop your work here — MUST return quickly
			OnStoppedLeading: func() {
				fmt.Printf("[%s] lost leadership — stopping work<br>", id)
				// If work goroutine is running, the ctx passed to OnStartedLeading
				// is cancelled automatically by the leader election library
				os.Exit(0) // let kubelet restart the pod to re-compete
			},

			// Called when any pod acquires the lease (informational)
			OnNewLeader: func(identity string) {
				if identity == id {
					return // we already know we're leader from OnStartedLeading
				}
				fmt.Printf("[%s] new leader elected: %s<br>", id, identity)
			},
		},
	})
}

// runWork is the actual singleton work. ctx is cancelled when leadership is lost.
func runWork(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			fmt.Println("work stopped — leadership lost or context cancelled")
			return
		case t := <-ticker.C:
			fmt.Printf("doing singleton work at %s<br>", t.Format(time.RFC3339))
			// e.g., process a job queue, run a reconciliation loop, etc.
		}
	}
}
```

### Required RBAC

The pod needs permission to create/get/update the `Lease` object:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: leader-election
  namespace: default
rules:
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-app-leader-election
  namespace: default
subjects:
  - kind: ServiceAccount
    name: my-app
roleRef:
  kind: Role
  name: leader-election
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 2   # both pods run, only one is leader at a time
  template:
    spec:
      serviceAccountName: my-app  # bind the SA with lease permissions
      containers:
        - name: app
          image: my-org/my-app:v1
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name  # inject pod name as identity
```

### Key Tuning Parameters

| Parameter | Default | Effect of too low | Effect of too high |
|-----------|---------|------------------|--------------------|
| `LeaseDuration` | 15s | Frequent leader churn under network blips | Slow failover after leader crash |
| `RenewDeadline` | 10s | Leader gives up leadership under transient API slowness | Leader holds on too long during real failures |
| `RetryPeriod` | 2s | High API Server load (many renewals) | Slow to detect that renewal is needed |
| `replicas` | 2+ | Single point of failure if leader pod is OOM-killed | Wasted resources |

**`ReleaseOnCancel: true`** is critical for fast failover on graceful shutdown. When the pod receives SIGTERM (rolling update, scale-down), it cancels the context, the leader election library releases the Lease immediately, and a new leader is elected within `RetryPeriod` — not `LeaseDuration`. Without this, failover waits the full 15 seconds.


---

## SRE Core Concepts

### SLI, SLO, Error Budget, SLA

```mermaid
graph LR
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    SLI["SLI: the measured signal"]:::blue --> SLO["SLO: internal target, e.g. 99.9% over 30 days"]:::blue
    SLO --> EB["Error Budget: 100% minus SLO = allowed failure"]:::green
    SLO --> SLA["SLA: external contract, SLO must be tighter than SLA"]:::blue
    EB --> BEHAVIOR["Budget remaining? Ship fast. Budget burned? Freeze and fix."]:::blue
```

**SLI (Service Level Indicator):**
The actual measured signal. What you observe.
- % of requests served successfully (status != 5xx)
- % of requests under 300ms latency
- Uptime percentage
- Error rate

**SLO (Service Level Objective):**
The internal target for the SLI. What you commit to internally.
- 99.9% of requests successful over a 30-day rolling window
- p99 latency under 500ms, measured over 1-hour windows
- 99.95% availability per quarter

**Error Budget:**
`100% - SLO = allowed failure`

| SLO | Budget | Monthly downtime allowed |
|-----|--------|--------------------------|
| 99% | 1% | ~7.2 hours |
| 99.9% | 0.1% | ~43 minutes |
| 99.95% | 0.05% | ~21.6 minutes |
| 99.99% | 0.01% | ~4.3 minutes |

The budget is a **resource**: burn it fast (bad incident) -> freeze risky changes, focus on reliability. Budget remaining -> ship features aggressively. This depersonalizes the argument: the budget decides, not opinion.

**How error budget changes behavior:** The team checks error budget weekly. If a bad incident burns 50% of the month's budget in one day, the next sprint freezes new features and focuses entirely on reliability.

**SLA (Service Level Agreement):**
External contract with customers. Breaching it means fines/credits. SLOs should always be tighter than SLAs (buffer for detecting breaches before customers do).

---

### MTTD, MTTR, MTTF

```mermaid
graph LR
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    INCIDENT_START["Incident starts (users affected)"]:::blue -->|"MTTD"| DETECTED["Team alerted"]:::blue
    DETECTED -->|"MTTR"| RESOLVED["Service restored"]:::teal
    RESOLVED -->|"MTTF"| NEXT["Next incident"]:::blue
```

**MTTD (Mean Time To Detect):**
Time from incident START to team KNOWS about it.

Improve by: SLO-based burn rate alerts, synthetic monitoring, anomaly detection, on-call coverage gaps analysis.

**MTTR (Mean Time To Recover):**
Time from detection to SERVICE RESTORED.

Improve by: runbooks (documented and tested), automated rollback, feature flags (instant kill switches), on-call drills, pre-approved playbooks for common failure modes.

**MTTF (Mean Time To Failure):**
Average time between incidents. Higher = more reliable.

Improve by: reducing toil, better testing, chaos engineering, capacity planning.

**Key insight:** MTTD and MTTR are separate problems.
- Fast detection + slow recovery = still bad (you know it's broken but can't fix it)
- Fast recovery + slow detection = users hurt for a long time before you knew

---

### Toil

**Toil** = manual, repetitive, automatable, reactive operational work that scales linearly with service growth and produces no enduring improvement.

**All traits must be true:**

| Trait | Question |
|-------|----------|
| Manual | No automation runs it |
| Repetitive | Done again and again |
| Automatable | Could be automated |
| Scales with growth | More users = more toil instances |
| No durable value | Does it again next time, leaves nothing behind |

**Examples:**
- Manually restarting a stuck service
- Hand-running database migrations
- Rotating certs by SSH-ing to 30 servers
- A daily release call with the same manual steps

**Why cap at ~50%:** If toil isn't capped, the team drowns in ops as the service grows and never builds anything permanent. SRE dedicates the freed time to automating the toil away.

---

### Incident Response Flow

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    DETECT["1. DETECT: Alert fires on SLO burn rate. Goal: minimize MTTD"]:::blue --> TRIAGE
    TRIAGE["2. TRIAGE: Assess severity SEV1/2/3, assign Incident Commander, open war room"]:::blue --> MITIGATE
    MITIGATE["3. MITIGATE: Rollback, shift traffic, feature-flag off, shed load. Do NOT wait for root cause."]:::orange --> RECOVER
    RECOVER["4. RECOVER: Confirm service restored, metrics normal, communicate status"]:::teal --> POSTMORTEM
    POSTMORTEM["5. BLAMELESS POSTMORTEM: Timeline, contributing factors, 5 Whys, action items"]:::blue
```

**Key principle of step 3:** Do NOT wait for root cause analysis. Mitigate first, investigate after. Rollback the deploy, shed load, feature-flag off — worry about why later.

**Blameless postmortem questions:**
- What happened? (timeline)
- What allowed it to happen? (not who caused it — what system gap)
- How did we detect it? Could we have detected it faster?
- How did we mitigate? Could we have mitigated faster?
- What prevents this class of failure from recurring? (action items)

---

### Monitoring: RED Method and Alerting

**RED method for request-based services:**

| Signal | What it measures | Alert when |
|--------|-----------------|------------|
| **R**ate | Requests per second | Sudden drop (service down?) or spike (DDoS?) |
| **E**rrors | Error rate (5xx / total) | Exceeds error budget burn rate |
| **D**uration | Latency distribution (p50, p95, p99) | p99 exceeds SLO threshold |

**Rules for good alerts:**
1. Alert on **symptoms** (user impact), not causes (CPU high, memory high)
2. Every page must be **actionable** — if no human action needed, it is not a page
3. Use **SLO burn rate** alerts — page when consuming error budget faster than sustainable
4. Group and deduplicate — one incident = one page, not 30
5. Audit alerts quarterly — delete any that fire but nobody acts on

**SLO burn rate alert example (Prometheus):**

```promql
# Fires when error budget burns 2x faster than sustainable over 1h window
sum(rate(http_requests_total{status=~"5.."}[1h])) /
sum(rate(http_requests_total[1h]))
> (1 - 0.999) * 2     # 2x the error budget rate for 99.9% SLO
```

---

### Scaling: Horizontal vs Vertical

| | Horizontal (scale out) | Vertical (scale up) |
|--|----------------------|-------------------|
| How | Add more instances | Bigger instance (more CPU/RAM) |
| Works for | Stateless services, microservices | Any app, no code changes |
| Fails when | App has shared state hard to distribute | Hit the largest instance size |
| Downtime | Zero (add instances behind LB) | Possible for traditional infra (not K8s) |
| Tools | K8s HPA, ECS Autoscaling, ASG | Change instance type |

**Best practice:** Design stateless services (session in Redis, not in-process memory) so horizontal scaling works cleanly. Vertical scale is the emergency lever when you can't distribute state.

---


## Incident Management Lifecycle

```mermaid
flowchart LR
    DETECT["1. Detect<br>Alert fires<br>SLO burn rate"] --> TRIAGE
    TRIAGE["2. Triage<br>Assign severity<br>Assign IC"] --> MITIGATE
    MITIGATE["3. Mitigate<br>Rollback · feature flag<br>load shed · redirect traffic"] --> RESOLVE
    RESOLVE["4. Resolve<br>Confirm metrics normal<br>Communicate status"] --> POSTMORTEM
    POSTMORTEM["5. Postmortem<br>Timeline · 5 Whys<br>Action items"]
```

### Severity Levels

| SEV | Impact | Response | Examples |
|-----|--------|----------|---------|
| SEV1 | Complete outage, data loss risk | Immediate page, war room | Checkout down, DB unreachable |
| SEV2 | Significant degradation | Page, respond within 15min | Error rate 10×, p99 > 5s |
| SEV3 | Minor degradation, workaround exists | Ticket, next business day | Single region slow, non-critical feature down |
| SEV4 | Cosmetic / no user impact | Log | Wrong log line, minor UI glitch |

### Incident Commander (IC) Role

The IC is one person with authority to make decisions. They do NOT debug — they coordinate.

```
IC responsibilities:
  - Declare severity, open war room (Slack/Zoom)
  - Assign tasks: "Alice owns the DB investigation, Bob owns the rollback"
  - Give status updates every 15 min (even if "no change")
  - Declare mitigation / resolution
  - Initiate postmortem
  - NOT: debugging, writing code, pulling logs themselves
```

### Mitigation vs Resolution

- **Mitigation** — stop the bleeding. Users are no longer impacted. Root cause unknown.
  → Rollback, feature flag off, traffic shift, increase rate limit, scale up
- **Resolution** — permanent fix deployed, root cause understood, monitoring confirmed normal.

**Always mitigate first.** Never wait for root cause before acting. A 30-minute outage while you find root cause is worse than a 5-minute outage from rolling back immediately.

---

## Blameless Postmortem Template

A postmortem is a **written record** of what happened, why, and what prevents recurrence. It is blameless — we fix systems and processes, never blame individuals.

```markdown
# Postmortem: [Service] [Brief Description] — [Date]

**Severity:** SEV1 / SEV2 / SEV3
**Duration:** HH:MM (detection to resolution)
**Impact:** [X% of users affected] [specific features broken]
**Status:** Complete / Action Items Open

---

## Summary (2–3 sentences)
What happened and what was the user impact. Written for a non-technical audience.

---

## Timeline (UTC)

| Time  | Event |
|-------|-------|
| 14:02 | Alert fires: error rate 8× SLO burn rate |
| 14:03 | On-call acknowledges, opens war room |
| 14:07 | Identifies deploy at 13:55 as likely cause |
| 14:09 | Rollback initiated |
| 14:12 | Error rate returns to baseline — **MITIGATED** |
| 14:45 | Root cause confirmed: nil pointer in new payment handler |
| 15:30 | Fix deployed, monitoring confirmed — **RESOLVED** |

---

## Root Cause

[Technical explanation. What specific change/condition caused the failure.]

Example: The v2.4.1 deploy introduced a nil pointer dereference in `payment.ProcessOrder()`
when the optional `discount_code` field was absent. The condition was not covered by unit tests.

---

## Contributing Factors (5 Whys)

1. Why did the service return 500s? → nil pointer panic in payment handler
2. Why was the nil pointer not caught? → no unit test for empty `discount_code`
3. Why was there no test? → the field was added without updating test fixtures
4. Why was it not caught in staging? → staging test data always includes a discount code
5. Why does staging not mirror prod data shapes? → no contract testing between services

Root cause is **systemic** (missing test coverage + staging data gap), not individual error.

---

## What Went Well

- Alert fired within 90 seconds of deploy
- Rollback completed in 3 minutes (< RTO target of 5 min)
- On-call had clear runbook to follow
- Status page updated before customer complaints

---

## What Went Poorly

- MTTD was good but MTTR was longer than target (30 min vs 10 min)
- War room had 8 people — too many, caused confusion
- Staging did not reproduce the bug

---

## Action Items

| Action | Owner | Due | Priority |
|--------|-------|-----|----------|
| Add unit tests for all optional fields in payment handler | Alice | 2025-06-27 | P1 |
| Add production-representative data to staging fixtures | Bob | 2025-07-04 | P1 |
| Document rollback procedure in runbook | Carol | 2025-06-27 | P2 |
| Review war room protocol — limit to 4 people max | Dan (EM) | 2025-06-30 | P2 |
| Investigate synthetic canary to catch nil panics pre-deploy | Alice | 2025-07-11 | P3 |

---

## Metrics

- **MTTD:** 1 min (alert to acknowledgment)
- **MTTR:** 30 min (detection to resolution)
- **Error budget burned:** ~18% of monthly budget
- **Users affected:** ~12,000 (estimated from error count)
```

### Postmortem Anti-Patterns

| Anti-pattern | Why it's harmful | Better |
|---|---|---|
| "Human error" as root cause | Ignores the system that allowed the error | Ask why the system allowed it |
| Blame in the doc | Chills future reporting of near-misses | Keep names out, focus on conditions |
| Action items with no owner | Never get done | Every item has a named owner + deadline |
| Action items with no priority | P3 items never get done | Explicitly mark P1 (must fix) vs P3 (nice to have) |
| Postmortem not shared | Team doesn't learn | Publish internally, link from incident channel |
| No follow-up | Action items rot | Review at next sprint planning |

---

## On-Call Best Practices

```
Before your shift:
  □ Ensure runbooks are up to date for your services
  □ Verify alert routing is correct (your phone/Slack receives pages)
  □ Know how to rollback the last 3 deploys

During an incident:
  □ Acknowledge within 5 min
  □ Declare severity immediately (even if uncertain — downgrade later)
  □ Mitigate first, investigate second
  □ Update status page / stakeholders every 15 min
  □ Take notes in a shared doc (timestamps are critical for postmortem)

After an incident:
  □ Write postmortem within 24h (while memory is fresh)
  □ Assign action items before closing the postmortem
  □ Update runbook with anything you learned
  □ Sleep — handoff if shift continues
```

### Runbook Minimum Structure

Every page-worthy alert must link to a runbook with:

```markdown
# [Alert Name] Runbook

## What is happening
One sentence: what the alert means in plain English.

## User impact
Who is affected and how.

## Immediate triage (first 5 minutes)
1. [specific command]
2. [specific command]
3. Check [specific dashboard link]

## Likely causes (most common first)
1. Cause A → fix: [command/step]
2. Cause B → fix: [command/step]

## Escalation
If not resolved in 30 min → page [team/person]
```
