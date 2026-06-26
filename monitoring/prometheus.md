# Prometheus — Production Reference Guide

---

## 1. Architecture

```mermaid
graph LR
    subgraph Targets
        A[App /metrics]
        B[Node Exporter]
        C[kube-state-metrics]
        D[Blackbox Exporter]
    end

    subgraph Prometheus
        SC[Scrape Engine]
        TSDB[TSDB Storage]
        PQ[PromQL Engine]
        RM[Rule Manager]
    end

    subgraph Outputs
        GF[Grafana]
        AM[AlertManager]
        RW[Remote Write]
    end

    A -->|pull /metrics| SC
    B -->|pull /metrics| SC
    C -->|pull /metrics| SC
    D -->|pull /metrics| SC
    SC --> TSDB
    TSDB --> PQ
    PQ --> GF
    RM -->|eval rules| TSDB
    RM -->|fire alerts| AM
    TSDB -->|stream| RW
    AM -->|notify| PagerDuty
    AM -->|notify| Slack
```

**Key insight:** Prometheus is a **pull-based** system. It scrapes HTTP `/metrics` endpoints on a configured interval (default 15s). This inverts the model — targets don't push; Prometheus fetches.

---

## 2. Data Model

Every time-series is identified by:

```
metric_name{label1="value1", label2="value2"} <timestamp> <float64>
```

Example:
```
http_requests_total{method="GET", status="200", handler="/api/users"} 1627890123456 4821
```

The **label set** uniquely identifies a series. Two series differing by even one label value are entirely separate streams stored independently in TSDB.

### 2.1 Metric Types

#### Counter — monotonically increasing

```
http_requests_total{status="200"} 4821
http_requests_total{status="500"} 12
```

- Never decreases (except on process restart → reset)
- Always use `rate()` or `increase()` to get useful numbers
- Math: `rate(http_requests_total[5m])` = per-second average over 5 min window

```
rate = (last_value - first_value) / range_seconds
     = (4821 - 4650) / 300
     = 0.57 req/s
```

#### Gauge — current snapshot value

```
process_resident_memory_bytes 52428800
go_goroutines 42
node_load1 0.73
```

- Can go up or down
- Use directly: no `rate()` needed
- Math: just read the value, or use `delta()` for change over time

```
delta(node_load1[10m])  →  load change over last 10 minutes
```

#### Histogram — distribution of observations

```
http_request_duration_seconds_bucket{le="0.1"}  240
http_request_duration_seconds_bucket{le="0.5"}  890
http_request_duration_seconds_bucket{le="1.0"}  950
http_request_duration_seconds_bucket{le="+Inf"} 960
http_request_duration_seconds_count             960
http_request_duration_seconds_sum               143.7
```

- Buckets are **cumulative** (each `le` includes all smaller values)
- `_count` = total observations, `_sum` = total sum of all values
- Math for p99:

```
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket[5m])
)
```

The function interpolates linearly within the bucket that contains the φ-th quantile.

Average latency:
```
rate(http_request_duration_seconds_sum[5m])
  /
rate(http_request_duration_seconds_count[5m])
```

#### Summary — client-side pre-computed quantiles

```
rpc_duration_seconds{quantile="0.5"}  0.012
rpc_duration_seconds{quantile="0.9"}  0.034
rpc_duration_seconds{quantile="0.99"} 0.089
rpc_duration_seconds_count            1234
rpc_duration_seconds_sum              18.6
```

- Quantiles computed **inside the client library** — cannot be aggregated across instances
- Use histogram when you need to aggregate; use summary when you need accurate single-instance quantiles cheaply
- Cannot do `histogram_quantile()` on summaries

---

## 3. TSDB Internals

### Block Structure

```mermaid
graph TD
    subgraph Head Block - RAM + WAL
        WA[WAL - write-ahead log]
        HC[Head Chunk - 2h window]
        WA --> HC
    end

    subgraph Persistent Blocks - disk
        B1[Block t0..t0+2h<br/>chunks/ index/ meta.json/ tombstones/]
        B2[Block t0+2h..t0+4h<br/>chunks/ index/ meta.json/ tombstones/]
        B3[Compacted Block<br/>spans 2..N blocks]
    end

    HC -->|flush every 2h| B1
    HC -->|flush every 2h| B2
    B1 -->|compaction| B3
    B2 -->|compaction| B3
```

### How it works

**Head block** lives in memory. All incoming scrapes write to the WAL first (durability), then to in-memory chunks. After 2 hours, the head is flushed to a persistent block on disk.

**Block layout on disk:**
```
data/
  01BKGV7JC0RY8A5WMZN4P/     ← ULID-named block directory
    chunks/
      000001                  ← raw chunk data (128MB segments)
    index                     ← series → chunk offset mapping
    meta.json                 ← minTime, maxTime, stats
    tombstones                ← soft deletes
```

**Compaction** merges small adjacent blocks into larger ones, applies tombstones, and removes redundant chunks. Prometheus runs compaction automatically. Default retention is 15 days; TSDB deletes blocks outside the retention window entirely.

**WAL replay:** On crash, Prometheus replays the WAL to reconstruct the head block. WAL segments are 128MB by default; old segments are checkpointed and removed once the head is flushed.

---

## 4. PromQL — 12+ Real Queries

### 4.1 Basic Rate

```promql
rate(http_requests_total[5m])
```
Per-second request rate averaged over 5 minutes. The `[5m]` range must contain at least 2 samples; use a range ≥ 2× scrape interval.

---

### 4.2 P99 Latency via Histogram

```promql
histogram_quantile(
  0.99,
  sum by (le, service) (
    rate(http_request_duration_seconds_bucket[5m])
  )
)
```
Aggregates buckets across all pods of a service, then computes p99. Always aggregate the `_bucket` series with `sum by (le, ...)` before passing to `histogram_quantile`.

---

### 4.3 increase() vs rate()

```promql
-- increase: total count over the window (extrapolated)
increase(http_requests_total[1h])

-- rate: per-second rate (increase / window_seconds)
rate(http_requests_total[1h])
```

`increase(v[d])` = `rate(v[d]) * duration_seconds(d)`

Use `increase()` for "how many in the last hour"; use `rate()` for "per-second throughput".

---

### 4.3b Follow-up: `rate()` vs `irate()`

| | `rate()` | `irate()` |
|--|---------|-----------|
| Samples used | All in window | Last 2 only |
| Smoothing | Yes — averages over window | No — instantaneous spike |
| Best for | Dashboards, alert rules | Detecting short bursts |
| Minimum window | 2× scrape_interval | Needs 2 recent samples |

Use `rate()` for almost everything. `irate()` only when you explicitly want to see momentary spikes that `rate()` would smooth away.

### 4.3c Follow-up: Why does `histogram_quantile` return approximate values?

`histogram_quantile` interpolates **linearly within the bucket** that contains the quantile. It cannot know where within that bucket the actual observations fall.

```
Buckets: le=0.5 → 890 observations, le=1.0 → 950 observations
p99 falls in the (0.5, 1.0] bucket.
The function assumes uniform distribution within that range → interpolates.
Actual p99 could be anywhere from 0.51 to 1.0 — impossible to know without raw data.
```

Accuracy = bucket granularity. Define buckets at your SLO boundaries:

```go
// Tight around a 300ms SLO
prometheus.LinearBuckets(0.05, 0.05, 10)   // 50ms steps up to 500ms
prometheus.ExponentialBuckets(0.01, 2, 12) // 10ms, 20ms, 40ms, 80ms...
```

For exact quantiles: use `Summary` (computed in client) — but summaries **cannot be aggregated across instances**. Use histogram when you need fleet-wide percentiles.

### 4.3d Follow-up: Staleness window (5 minutes)

If a target stops scraping, Prometheus marks its last sample **stale** after `5 × scrape_interval` (default 5 min). Stale series are excluded from `rate()` and aggregations — they return no data rather than a stale value.

Why this matters for counter resets: when a process restarts (counter resets to 0), Prometheus detects the stale marker before the new samples arrive and handles the reset correctly — `rate()` does not return a negative value.

---

### 4.4 topk / bottomk

```promql
-- Top 5 endpoints by request rate
topk(5, rate(http_requests_total[5m]))

-- Bottom 3 pods by available memory
bottomk(3, container_memory_available_bytes)
```

`topk(k, expr)` returns the k highest time-series from the instant vector. Does not aggregate — returns individual series.

---

### 4.5 Aggregation: by / without

```promql
-- Total RPS per service (drop all labels except service)
sum by (service) (rate(http_requests_total[5m]))

-- Total RPS dropping only instance label
sum without (instance, pod) (rate(http_requests_total[5m]))

-- Error ratio per service
sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
  /
sum by (service) (rate(http_requests_total[5m]))
```

`by` keeps only listed labels. `without` drops listed labels and keeps the rest. Prefer `by` for clarity.

---

### 4.6 absent() — Alert on Missing Metrics

```promql
-- Fire if a job stops scraping entirely
absent(up{job="payment-service"})

-- Fire if no 200 responses seen in 5m
absent(rate(http_requests_total{status="200"}[5m]))
```

`absent()` returns a single element with value 1 if the selector matches nothing. Returns empty if the metric exists. Essential for "target down" and "metric disappeared" alerts.

---

### 4.7 predict_linear() — Disk Full Forecast

```promql
predict_linear(
  node_filesystem_avail_bytes{mountpoint="/"}[1h],
  4 * 3600
) < 0
```

Uses linear regression over the last 1h of data to predict the value 4 hours from now. Returns predicted bytes; `< 0` means disk will be full. Pair with `and` to avoid false alerts on stable disks:

```promql
predict_linear(node_filesystem_avail_bytes[1h], 4*3600) < 0
  and
(node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.2
```

---

### 4.8 changes() — Config Reload / Flapping Detection

```promql
-- How many times did a value change in 1h
changes(process_start_time_seconds[1h]) > 2

-- Detect pod restart storms
changes(kube_pod_status_ready[30m]) > 5
```

`changes(v[d])` counts the number of times the value changed within the range. Useful to detect flapping or frequent restarts.

---

### 4.9 Average Request Duration

```promql
sum by (service) (rate(http_request_duration_seconds_sum[5m]))
  /
sum by (service) (rate(http_request_duration_seconds_count[5m]))
```

Computes mean latency per service. Use only as a rough guide — mean hides tail latency. Always pair with p99.

---

### 4.10 CPU Saturation

```promql
-- CPU usage per pod (last 5m)
sum by (pod, namespace) (
  rate(container_cpu_usage_seconds_total{container!=""}[5m])
)

-- Throttling ratio
sum by (pod) (rate(container_cpu_throttled_seconds_total[5m]))
  /
sum by (pod) (rate(container_cpu_usage_seconds_total[5m]))
```

---

### 4.11 Memory Saturation

```promql
-- Working set memory as fraction of limit
container_memory_working_set_bytes
  /
container_spec_memory_limit_bytes > 0.9
```

---

### 4.12 Recording Rule Query — Pre-computed

```promql
-- This becomes a new metric: job:http_requests:rate5m
sum by (job) (rate(http_requests_total[5m]))
```

When stored as a recording rule, Prometheus pre-evaluates this on every rule interval and stores the result as a new metric. Dashboards then query `job:http_requests:rate5m` directly — much faster for high-cardinality sources.

---

### PromQL Evaluation Flow

```mermaid
graph TD
    Q[PromQL Query String] --> P[Parser<br/>AST construction]
    P --> A[Analyzer<br/>type check + label validation]
    A --> E[Evaluator]
    E --> TS[TSDB Chunk Iterator<br/>fetch raw samples]
    TS --> F[Function Eval<br/>rate / histogram_quantile]
    F --> AG[Aggregation<br/>sum / by / without]
    AG --> R[Result Vector<br/>instant or range]
    R --> GF[Grafana / API caller]
```

---

## 5. Scrape Configuration

```yaml
global:
  scrape_interval: 15s       # default pull frequency
  evaluation_interval: 15s   # rule evaluation frequency
  scrape_timeout: 10s

scrape_configs:

  # --- Static targets ---
  - job_name: payment-service
    static_configs:
      - targets:
          - payment-svc:8080
          - payment-svc-2:8080
        labels:
          env: production
          region: us-east-1

  # --- Kubernetes pod discovery ---
  - job_name: k8s-pods
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [production, staging]

    relabel_configs:
      # Only scrape pods with annotation prometheus.io/scrape=true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"

      # Use custom port from annotation
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: (.+)
        replacement: "${1}"

      # Copy pod name to label
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod

      # Copy namespace to label
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace

      # Drop pods in Terminating state
      - source_labels: [__meta_kubernetes_pod_phase]
        action: drop
        regex: (Terminating|Succeeded|Failed)

  # --- Kubernetes node discovery ---
  - job_name: k8s-nodes
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    kubernetes_sd_configs:
      - role: node
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)

  # --- Blackbox HTTP probing ---
  - job_name: blackbox-http
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - https://api.example.com/health
          - https://api.example.com/ready
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
```

### Relabeling Actions

| Action | Effect |
|--------|--------|
| `keep` | Drop series where regex does NOT match |
| `drop` | Drop series where regex matches |
| `replace` | Rewrite target_label using regex + replacement |
| `labelmap` | Copy labels matching regex to new names |
| `labeldrop` | Remove labels matching regex from final set |
| `labelkeep` | Remove all labels NOT matching regex |

---

## 6. Recording Rules

```yaml
# rules/recording.yaml
groups:
  - name: http_aggregations
    interval: 30s   # override global evaluation_interval
    rules:

      # Pre-aggregate per-job request rate
      - record: job:http_requests_total:rate5m
        expr: |
          sum by (job, status) (
            rate(http_requests_total[5m])
          )

      # Pre-aggregate error ratio
      - record: job:http_error_ratio:rate5m
        expr: |
          sum by (job) (rate(http_requests_total{status=~"5.."}[5m]))
            /
          sum by (job) (rate(http_requests_total[5m]))

      # Pre-aggregate p99 latency per service
      - record: job:http_request_duration_p99:rate5m
        expr: |
          histogram_quantile(0.99,
            sum by (job, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )

      # CPU usage per namespace
      - record: namespace:container_cpu_usage:rate5m
        expr: |
          sum by (namespace) (
            rate(container_cpu_usage_seconds_total{container!=""}[5m])
          )

      # Memory working set per namespace
      - record: namespace:container_memory_working_set:sum
        expr: |
          sum by (namespace) (
            container_memory_working_set_bytes{container!=""}
          )
```

**Naming convention:** `level:metric:operation` — e.g., `job:http_requests_total:rate5m`. This is the Prometheus community standard.

---

## 7. Alerting Rules — 5 Production Alerts

```yaml
# rules/alerts.yaml
groups:
  - name: production-alerts
    rules:

      # 1. High error rate (> 1% of traffic for 5 minutes)
      - alert: HighErrorRate
        expr: |
          (
            sum by (job) (rate(http_requests_total{status=~"5.."}[5m]))
              /
            sum by (job) (rate(http_requests_total[5m]))
          ) > 0.01
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "High HTTP error rate on {{ $labels.job }}"
          description: >
            {{ $labels.job }} error rate is {{ $value | humanizePercentage }}
            (threshold 1%) for 5 minutes.
          runbook: https://wiki.example.com/runbooks/high-error-rate

      # 2. High p99 latency (> 1s for 10 minutes)
      - alert: HighP99Latency
        expr: |
          histogram_quantile(0.99,
            sum by (job, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          ) > 1.0
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "High p99 latency on {{ $labels.job }}"
          description: >
            p99 latency for {{ $labels.job }} is {{ $value | humanizeDuration }}
            (threshold 1s).
          runbook: https://wiki.example.com/runbooks/high-latency

      # 3. Pod crash-looping (> 3 restarts in 15 minutes)
      - alert: PodCrashLooping
        expr: |
          increase(kube_pod_container_status_restarts_total[15m]) > 3
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Pod {{ $labels.pod }} is crash-looping"
          description: >
            Pod {{ $labels.namespace }}/{{ $labels.pod }} container
            {{ $labels.container }} restarted {{ $value }} times in 15m.
          runbook: https://wiki.example.com/runbooks/pod-crash-loop

      # 4. Disk filling up (< 20% free, will fill in < 4h)
      - alert: DiskFillingUp
        expr: |
          (
            node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
              /
            node_filesystem_size_bytes
          ) < 0.2
          and
          predict_linear(
            node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[1h],
            4 * 3600
          ) < 0
        for: 15m
        labels:
          severity: warning
          team: infra
        annotations:
          summary: "Disk {{ $labels.mountpoint }} filling on {{ $labels.instance }}"
          description: >
            Filesystem {{ $labels.mountpoint }} on {{ $labels.instance }}
            is {{ $value | humanizePercentage }} free and will fill in < 4h.
          runbook: https://wiki.example.com/runbooks/disk-filling

      # 5. Prometheus target down
      - alert: TargetDown
        expr: up == 0
        for: 2m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Target {{ $labels.instance }} is down"
          description: >
            Prometheus cannot scrape {{ $labels.job }}/{{ $labels.instance }}
            for 2 minutes.
          runbook: https://wiki.example.com/runbooks/target-down
```

### Scrape → Alert Pipeline

```mermaid
sequenceDiagram
    participant T as Target /metrics
    participant SC as Scrape Engine
    participant TSDB as TSDB
    participant RM as Rule Manager
    participant AM as AlertManager
    participant PD as PagerDuty

    SC->>T: GET /metrics every 15s
    T-->>SC: text/plain metrics
    SC->>TSDB: write samples
    RM->>TSDB: eval alert expr every 15s
    TSDB-->>RM: instant vector result
    alt expr result non-empty
        RM->>RM: set state = pending
        RM->>RM: wait for: duration (5m)
        RM->>AM: POST /alerts firing
        AM->>AM: group + inhibit + silence
        AM->>PD: send notification
    else expr result empty
        RM->>RM: set state = resolved
        RM->>AM: POST /alerts resolved
    end
```

---

## 8. Production Scenarios

### 8.1 High Cardinality Problem

**What causes it:**

High cardinality happens when a label has too many unique values — each unique combination creates a new time-series. TSDB stores each series independently; memory and CPU grow linearly with series count.

Common mistakes:
```
# BAD — user_id can have millions of unique values
http_requests_total{user_id="usr_abc123", path="/api/..."} 

# BAD — request_id is unique per request
rpc_calls_total{request_id="req_8f7a3b2c"}

# BAD — full URL with query strings
http_requests_total{url="/search?q=golang&page=3&sort=date"}

# GOOD — normalize to a path template
http_requests_total{handler="/search"}
```

**How to detect:**

```promql
-- Top metrics by series count
topk(10, count by (__name__) ({__name__=~".+"}))

-- Total active series
prometheus_tsdb_head_series

-- Series created per minute (cardinality growth rate)
rate(prometheus_tsdb_head_series_created_total[5m])

-- Memory used by head block
prometheus_tsdb_head_chunks_storage_size_bytes
```

Check the Prometheus UI at `http://prometheus:9090/tsdb-status` for top metrics by series count and top label value pairs.

**Fix:**

1. Drop high-cardinality labels at scrape time with `relabel_configs`:
```yaml
relabel_configs:
  - source_labels: [__name__]
    target_label: __tmp_metric_name
  - regex: http_requests_total
    source_labels: [__tmp_metric_name]
    action: keep
metric_relabel_configs:
  # Drop user_id label from all metrics
  - action: labeldrop
    regex: user_id
  # Drop request_id label
  - action: labeldrop
    regex: request_id
```

2. Use `metric_relabel_configs` (post-scrape) to drop series before storage:
```yaml
metric_relabel_configs:
  - source_labels: [url]
    regex: '/api/v\d+/users/[a-f0-9-]+'
    target_label: url
    replacement: '/api/v1/users/{id}'
```

---

### 8.2 Scrape Failure Debugging

Step 1 — Check `up` metric:
```promql
up{job="my-service"} == 0
```

Step 2 — Check Prometheus targets page: `http://prometheus:9090/targets` — shows last scrape error message.

Common errors and fixes:

| Error | Cause | Fix |
|-------|-------|-----|
| `connection refused` | Port wrong or service down | Fix port in scrape config or restart service |
| `context deadline exceeded` | Scrape timeout too short | Increase `scrape_timeout` |
| `x509: certificate signed by unknown authority` | TLS cert not trusted | Add `tls_config.ca_file` or `insecure_skip_verify: true` |
| `401 Unauthorized` | Missing auth | Add `bearer_token_file` or `basic_auth` |
| `text format parsing errors` | Malformed metrics output | Fix instrumentation in the target |

Step 3 — Manual probe:
```bash
# Direct HTTP check
curl -v http://service:8080/metrics | head -50

# Check Prometheus can reach it (from Prometheus pod)
kubectl exec -n monitoring prometheus-0 -- \
  curl -s http://payment-service:8080/metrics | head -20
```

---

### 8.3 Slow PromQL Queries

Symptoms: Grafana dashboards time out, `query_log` shows high latency.

**Diagnosis:**
```promql
-- Queries taking > 5s
prometheus_engine_query_duration_seconds{quantile="0.99"} > 5

-- Enable query log in prometheus.yml
-- global:
--   query_log_file: /var/log/prometheus/query.log
```

**Common causes and fixes:**

| Cause | Symptom | Fix |
|-------|---------|-----|
| High cardinality aggregation | `sum({__name__=~".+"})` scans all series | Use specific selectors |
| Long range on high-churn metric | `rate(v[1h])` on 100k series | Reduce range or use recording rule |
| No label filtering | `rate(http_requests_total[5m])` returns 50k series | Add `{job="x"}` filter |
| Nested subqueries | `max_over_time(rate(v[5m])[1h:1m])` | Pre-compute with recording rule |

**Fix pattern — recording rules:**
```yaml
# Replace slow dashboard query with pre-computed metric
- record: job:http_requests_total:rate5m
  expr: sum by (job) (rate(http_requests_total[5m]))

# Dashboard now queries the tiny pre-computed series
# job:http_requests_total:rate5m  instead of  sum by (job) (rate(http_requests_total[5m]))
```

---

### 8.4 Federation vs Remote Write

```mermaid
graph TD
    subgraph Federation
        PL1[Prometheus Local 1<br/>cluster A]
        PL2[Prometheus Local 2<br/>cluster B]
        PG[Prometheus Global<br/>scrapes /federate]
        PL1 -->|/federate endpoint| PG
        PL2 -->|/federate endpoint| PG
    end

    subgraph Remote Write
        PR1[Prometheus 1<br/>cluster A]
        PR2[Prometheus 2<br/>cluster B]
        RW[Remote Storage<br/>Thanos / Cortex / Mimir]
        PR1 -->|stream samples| RW
        PR2 -->|stream samples| RW
    end
```

| | Federation | Remote Write |
|---|---|---|
| **How** | Global Prometheus scrapes `/federate` on local instances | Each Prometheus streams samples to remote endpoint |
| **Latency** | One scrape interval behind | Near real-time (configurable queue) |
| **Scalability** | Limited — global becomes bottleneck | Scales horizontally (Thanos/Cortex/Mimir) |
| **Data loss on restart** | Possible — depends on scrape timing | WAL-backed queue survives restarts |
| **Use case** | Small multi-DC setups, aggregate pre-recorded metrics | Production multi-cluster, long-term storage |
| **Query scope** | Single global Prometheus | Unified query across all clusters |

**Remote write config:**
```yaml
remote_write:
  - url: https://thanos-receive.example.com/api/v1/receive
    queue_config:
      max_samples_per_send: 10000
      capacity: 100000
      max_shards: 30
    write_relabel_configs:
      # Only send metrics needed for long-term storage
      - source_labels: [__name__]
        regex: 'job:.*'
        action: keep
```

**Federation config (global Prometheus):**
```yaml
scrape_configs:
  - job_name: federate
    honor_labels: true
    metrics_path: /federate
    params:
      match[]:
        - '{job="payment-service"}'
        - 'job:http_requests_total:rate5m'
    static_configs:
      - targets:
          - prometheus-cluster-a:9090
          - prometheus-cluster-b:9090
```

---

## Quick Reference

```
Metric types:  counter(rate) · gauge(direct) · histogram(quantile) · summary(client)
TSDB:          2h head → block flush → compaction → retention delete
PromQL:        instant vector | range vector | scalar | string
Cardinality:   series = unique label combinations — keep labels low-cardinality
Alerting:      expr fires → pending → (for: duration) → firing → AlertManager
Recording:     level:metric:operation naming, pre-compute expensive queries
Remote write:  prefer over federation for production multi-cluster
```
