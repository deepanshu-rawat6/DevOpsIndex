# Alerting Philosophy

---

## The Four Golden Signals

Every service should be monitored across these four dimensions. From the Google SRE Book.

| Signal | What it measures | PromQL example |
|--------|-----------------|----------------|
| **Latency** | Time to serve a request — distinguish successful vs failed latency | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` |
| **Traffic** | Demand on the system | `rate(http_requests_total[5m])` |
| **Errors** | Rate of requests that fail (explicitly or implicitly) | `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])` |
| **Saturation** | How "full" the service is — the resource most constrained | `container_cpu_cfs_throttled_periods_total / container_cpu_cfs_periods_total` |

**Why these four?** They directly map to user experience. A user notices slow responses (latency), errors, and service unavailability (saturation → queue full). Traffic gives context: low error rate during low traffic is different from low error rate during peak.

**Latency trap:** Always separate latency of successful requests from failed ones. Failed requests that return immediately (fast 500s) will artificially improve your p99 latency metric.

```promql
# Correct: latency of successful requests only
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket{status!~"5.."}[5m])
)
```

---

## Symptoms vs Causes

**Alert on symptoms, not causes.**

A symptom is something the user experiences. A cause is the internal reason it's happening.

| ❌ Cause alert | ✅ Symptom alert |
|---------------|-----------------|
| CPU > 80% | p99 latency > 500ms |
| Disk usage > 70% | Error rate > 0.1% |
| Pod restarted | Requests failing |
| Memory growing | SLO burn rate > 6x |
| DB replica lag > 5s | Checkout success rate < 99% |

**Why cause alerts are bad:**
- CPU at 80% usually doesn't hurt users — the service handles it
- Disk at 70% may be fine for another 30 days
- They fire constantly → alert fatigue → on-call ignores pages → real incidents missed

**Why symptoms are better:**
- Directly tied to user impact
- Self-documenting: "users are experiencing errors" is unambiguous
- Cover multiple root causes with one alert

**Exception:** Use cause alerts as *tickets* (low urgency), not pages. "Disk 70%" creates a ticket for next sprint. "Users can't complete checkout" pages immediately.

---

## Alert Fatigue

Alert fatigue: on-call starts ignoring alerts because too many fire without real impact.

```mermaid
flowchart LR
    NOISE["Too many low-signal alerts"] --> IGNORE
    IGNORE["On-call habituates,<br>starts ignoring pages"] --> MISS
    MISS["Real incident missed<br>or delayed response"] --> OUTAGE["Extended outage"]
```

**Signs you have alert fatigue:**
- Alerts that fire every week but never cause an incident
- On-call acknowledges alerts without investigating
- "We just silence that one" is normal vocabulary
- Alert history shows > 30% of pages had no action taken

**Fixing alert fatigue:**

1. **Audit every alert:** For each alert, ask "What did I do the last 5 times this fired?" If the answer is "nothing" or "silenced it" → delete it.

2. **Raise thresholds:** An alert that fires at 50% CPU when the system is never impacted until 90% should be at 85%.

3. **Add `for:` duration:** Don't alert on a 1-second spike. Use `for: 5m` to require the condition persists.

4. **Use `inhibit_rules`** in AlertManager: if a high-severity alert is firing, suppress lower-severity alerts for the same service.

5. **Route by urgency:** Not everything needs to wake someone up.

---

## Alert Routing by Urgency

```
P1 — Page immediately (wake up at 3am)
  → User-facing service down, SLO burn rate > 14.4x, data loss risk

P2 — Page during on-call hours
  → Significant degradation, SLO burn rate > 6x, partial failure

P3 — Ticket / Slack notification (next business day)
  → SLO burn rate > 3x, resource trending toward exhaustion

P4 — Dashboard annotation / log
  → Informational, no action needed now
```

```yaml
# AlertManager routing tree matching this model
route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: default-slack

  routes:
  - match:
      severity: critical
    receiver: pagerduty
    continue: false

  - match:
      severity: warning
    receiver: slack-warning
    continue: false

  - match:
      severity: info
    receiver: slack-info
```

---

## Alert Design Checklist

For every alert, answer these before merging:

```
□ Does this alert on a symptom (not a cause)?
□ Is there a clear action the on-call must take?
□ Is there a runbook link in the annotation?
□ Does it have a `for:` duration to suppress transient spikes?
□ Has it been tested in staging — does it actually fire when expected?
□ Is the severity correct? (Would you wake someone at 3am for this?)
□ Does it have enough context in annotations to diagnose without extra tools?
□ Is there a corresponding suppression/inhibition rule for related alerts?
```

**Required annotation fields:**
```yaml
annotations:
  summary: "One-line human-readable description"
  description: "Current value: {{ $value }}, threshold: X. What this means."
  runbook: "https://wiki/runbooks/service-name/alert-name"
  dashboard: "https://grafana/d/xxx/service-dashboard"
```

---

## Multi-Window Alerting

Single-threshold alerts have two failure modes:
- **Too sensitive:** fires on 1-minute spikes → false positives, alert fatigue
- **Too slow:** requires long `for:` → misses fast-burning incidents

Solution: alert on the **rate of change** (burn rate) over two time windows simultaneously.

```promql
# Fires only if BOTH short and long windows exceed threshold
# Short window = fast detection, long window = reduces false positives
(
  error_rate_1h > (14.4 * error_budget_ratio)
  AND
  error_rate_5m > (14.4 * error_budget_ratio)
)
```

See `slo-sli.md` for the full multi-window burn rate alert tiers.

---

## Runbook Structure

Every P1/P2 alert must link to a runbook. A runbook answers:

```markdown
# Alert: HighErrorBudgetBurn — api service

## What is happening
The API service error rate is > 1.44% (14.4x the SLO budget burn rate).
Users are experiencing errors on ~1 in 70 requests.

## Impact
~1.4% of all API requests are failing. Checkout, user login, and search affected.

## Immediate triage (< 5 min)
1. kubectl get pods -n production -l app=api
2. kubectl logs -n production -l app=api --tail=100 | grep ERROR
3. Check Grafana: [dashboard link]
4. Check recent deployments: kubectl rollout history deployment/api -n production

## Likely causes (most common first)
1. Recent deployment introduced a bug → rollback with kubectl rollout undo
2. Database connection pool exhausted → check RDS connection count
3. Downstream service degraded → check dependency health dashboard

## Escalation
If not resolved in 30 min → escalate to service owner: @team-backend
```

---

## USE vs RED vs Four Golden Signals

| Framework | Focus | Best for |
|-----------|-------|----------|
| **USE** (Utilization, Saturation, Errors) | Resources (CPU, memory, disk, network) | Infrastructure / node-level monitoring |
| **RED** (Rate, Errors, Duration) | Request-driven services | Microservices, APIs |
| **Four Golden Signals** | User experience | Any user-facing service SLO |

They complement each other:
- USE → tells you *why* (which resource is the bottleneck)
- RED / Golden Signals → tells you *what* the user experiences
- Alert on Golden Signals/RED → investigate with USE

---

## Common Anti-Patterns

| Anti-pattern | Consequence | Fix |
|---|---|---|
| Alert on every metric | Alert fatigue | Alert on symptoms; use dashboards for exploration |
| No `for:` duration | False positives on transient spikes | Add `for: 5m` minimum |
| Same severity for everything | On-call can't prioritize | 4-tier severity model |
| Alert without runbook | Slow resolution, tribal knowledge | Runbook required for P1/P2 |
| Alert that always resolves itself | Engineers stop caring | Delete it or lower to info |
| Alerting on averages | Hides tail latency problems | Alert on p99, not mean |
| Per-instance alerts (not aggregated) | Noise from single bad replica | Aggregate across replicas first |
