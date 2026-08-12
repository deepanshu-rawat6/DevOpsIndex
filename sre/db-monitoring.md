# Database Monitoring: On-Prem (K8s & EC2)

Prometheus + Grafana stack for MySQL, PostgreSQL, Redis, MongoDB running on-prem or EC2/self-managed K8s.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Architecture

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph DBLayer["Database Layer — K8s pods or EC2 VMs"]
        PG["PostgreSQL<br/>native protocol :5432"]:::blue
        MY["MySQL<br/>native protocol :3306"]:::blue
        RD["Redis<br/>native protocol :6379"]:::blue
        MG["MongoDB<br/>native protocol :27017"]:::blue
    end

    subgraph Exporters["Exporters — sidecar or separate pod/process<br/>translate native stats into Prometheus text format"]
        PGE["postgres_exporter<br/>:9187"]:::teal
        MYE["mysqld_exporter<br/>:9104"]:::teal
        RDE["redis_exporter<br/>:9121"]:::teal
        MGE["mongodb_exporter<br/>:9216"]:::teal
    end

    subgraph Observability["Observability Stack"]
        PROM["Prometheus<br/>scrapes /metrics every 15s<br/>evaluates alert rules on the same data"]:::orange
        ALERT["Alertmanager<br/>dedupes, groups, routes firing alerts"]:::red
        GRAF["Grafana<br/>dashboards, queries Prometheus directly"]:::green
        LOKI["Loki (optional)<br/>log aggregation, correlate with metrics"]:::orange
    end

    subgraph Channels["Notification Channels"]
        PD["PagerDuty<br/>critical severity, pages on-call"]:::red
        SLACK["Slack<br/>warning severity, team channel"]:::purple
        EMAIL["Email<br/>low-urgency digest"]:::purple
    end

    PG -->|"read-only monitoring user<br/>queries pg_stat_* views"| PGE
    MY -->|"read-only monitoring user<br/>queries SHOW STATUS"| MYE
    RD -->|"AUTH + INFO command"| RDE
    MG -->|"read-only monitoring user<br/>runs serverStatus()"| MGE

    PGE & MYE & RDE & MGE -->|"scrape /metrics<br/>every 15s"| PROM
    PROM -->|"rule evaluation interval"| ALERT
    PROM -->|"PromQL queries"| GRAF
    ALERT -->|"critical"| PD
    ALERT -->|"warning"| SLACK
    ALERT -->|"info"| EMAIL
```

Exporters are the bridge — they query the DB using native protocol and expose Prometheus `/metrics` endpoint. None of these four databases speak Prometheus's text format on their own; the exporter's entire job is that one translation step.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Exporter queries the database.</strong> Each exporter connects with a dedicated, read-only monitoring user and asks the database for its native internal stats — <code>pg_stat_*</code> views for PostgreSQL, <code>SHOW STATUS</code> for MySQL, the <code>INFO</code> command for Redis, <code>serverStatus()</code> for MongoDB.
    </div>
    <div class="stepper-panel">
      <strong>2. Exporter translates to Prometheus format.</strong> It reshapes those native, protocol-specific stats into the plain-text <code>/metrics</code> exposition format Prometheus understands. This translation is the only reason exporters exist — the databases themselves have no idea Prometheus exists.
    </div>
    <div class="stepper-panel">
      <strong>3. Prometheus scrapes.</strong> On its configured interval (15s in this setup, set via the <code>ServiceMonitor</code> or a static scrape config), Prometheus pulls <code>/metrics</code> from each exporter and appends the values as new points on each metric's time series.
    </div>
    <div class="stepper-panel">
      <strong>4. Alert rule evaluates.</strong> On its own evaluation interval, Prometheus checks each <code>PrometheusRule</code> expression against the latest data. If the condition holds continuously for that rule's <code>for:</code> duration, the alert transitions to firing and Alertmanager routes it — critical to PagerDuty, warning to Slack, informational to email.
    </div>
    <div class="stepper-panel">
      <strong>5. Grafana renders the dashboard.</strong> Independently of the alerting path, Grafana queries Prometheus directly with PromQL to draw live panels — so a human can see the same underlying trend that triggered, or is about to trigger, an alert.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Why can't Prometheus scrape PostgreSQL, MySQL, or MongoDB directly, the way it scrapes a service that already exposes its own /metrics endpoint?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>None of these databases speak Prometheus's text exposition format natively — they only expose their internal stats through their own native protocol (SQL system views, the INFO command, serverStatus(), and so on). The exporter is the bridge: it queries the database using that native protocol, then re-exposes the results as a standard Prometheus <code>/metrics</code> endpoint that Prometheus can scrape like any other target.</div>
</div>

---

## Setup on Kubernetes

### Prometheus + Grafana via kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.adminPassword=changeme \
  --set prometheus.prometheusSpec.retention=30d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=gp3 \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=50Gi
```

This installs: Prometheus, Grafana, Alertmanager, node-exporter DaemonSet, kube-state-metrics.

### PostgreSQL Exporter

```yaml
# postgres-exporter deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres-exporter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres-exporter
  template:
    metadata:
      labels:
        app: postgres-exporter
      annotations:
        prometheus.io/scrape: "true"   # auto-discovery
        prometheus.io/port: "9187"
    spec:
      containers:
      - name: exporter
        image: prometheuscommunity/postgres-exporter:v0.15.0
        env:
        - name: DATA_SOURCE_NAME
          valueFrom:
            secretKeyRef:
              name: postgres-exporter-secret
              key: dsn      # postgresql://monitor_user:pass@postgres-svc:5432/mydb?sslmode=disable
        ports:
        - containerPort: 9187
---
# Read-only monitoring user (least privilege)
# CREATE USER monitor WITH PASSWORD 'pass';
# GRANT pg_monitor TO monitor;   -- PostgreSQL 10+
```

```yaml
# ServiceMonitor tells Prometheus to scrape this service
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: postgres-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: postgres-exporter
  endpoints:
  - port: metrics
    interval: 15s
```

### Redis Exporter

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-exporter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis-exporter
  template:
    metadata:
      labels:
        app: redis-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9121"
    spec:
      containers:
      - name: exporter
        image: oliver006/redis_exporter:v1.55.0
        env:
        - name: REDIS_ADDR
          value: "redis://redis-svc:6379"
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: password
        ports:
        - containerPort: 9121
```

### Setup on EC2 (bare metal / VM)

```bash
# Download and run postgres_exporter as a systemd service
wget https://github.com/prometheus-community/postgres_exporter/releases/download/v0.15.0/postgres_exporter-0.15.0.linux-amd64.tar.gz
tar xvf postgres_exporter*.tar.gz

# Create systemd unit
cat > /etc/systemd/system/postgres-exporter.service << EOF
[Unit]
Description=Postgres Exporter

[Service]
Environment="DATA_SOURCE_NAME=postgresql://monitor:pass@localhost:5432/mydb?sslmode=disable"
ExecStart=/usr/local/bin/postgres_exporter
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now postgres-exporter

# Tell Prometheus to scrape this EC2 instance
# In prometheus.yml on the Prometheus server:
# scrape_configs:
#   - job_name: postgres
#     static_configs:
#       - targets: ['10.0.1.50:9187']   # EC2 private IP
```

---

## Key Metrics to Monitor

Same shape of question for all four engines — is it up, is it running out of headroom (connections/memory/disk), is it falling behind on replication, is it serving queries slowly — but each exposes that through its own metric names and its own notion of "healthy." Flip between them below.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="metrics-pg" class="active">PostgreSQL</button>
    <button data-tab="metrics-my">MySQL</button>
    <button data-tab="metrics-rd">Redis</button>
    <button data-tab="metrics-mg">MongoDB</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="metrics-pg">
      <table>
        <thead><tr><th>Metric</th><th>What it tells you</th><th>Alert threshold</th></tr></thead>
        <tbody>
          <tr><td><code>pg_up</code></td><td>Is exporter connected to DB</td><td>= 0 → DB down</td></tr>
          <tr><td><code>pg_database_size_bytes</code></td><td>Database disk usage</td><td>&gt; 80% of disk</td></tr>
          <tr><td><code>pg_stat_activity_count</code></td><td>Active connections</td><td>&gt; 80% of <code>max_connections</code></td></tr>
          <tr><td><code>pg_stat_activity_max_tx_duration</code></td><td>Longest running transaction</td><td>&gt; 300s → long-running query</td></tr>
          <tr><td><code>pg_stat_bgwriter_checkpoint_write_time</code></td><td>Checkpoint I/O time</td><td>Sustained high → I/O bottleneck</td></tr>
          <tr><td><code>pg_stat_replication_pg_wal_lsn_diff</code></td><td>Replication lag (bytes)</td><td>&gt; 50MB → replica falling behind</td></tr>
          <tr><td><code>pg_locks_count</code></td><td>Lock contention</td><td>Sudden spike → deadlock risk</td></tr>
          <tr><td><code>pg_stat_user_tables_n_dead_tup</code></td><td>Dead tuples (bloat)</td><td>High → needs VACUUM</td></tr>
          <tr><td><code>rate(pg_stat_user_tables_seq_scan[5m])</code></td><td>Sequential scans</td><td>High on large tables → missing index</td></tr>
          <tr><td><code>pg_stat_statements_mean_exec_time_seconds</code></td><td>Slow query avg time</td><td>Spike → bad query plan / missing index</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tab-panel" data-tab-panel="metrics-my">
      <table>
        <thead><tr><th>Metric</th><th>What it tells you</th><th>Alert threshold</th></tr></thead>
        <tbody>
          <tr><td><code>mysql_up</code></td><td>DB reachable</td><td>= 0 → alert</td></tr>
          <tr><td><code>mysql_global_status_threads_connected</code></td><td>Active connections</td><td>&gt; 80% of <code>max_connections</code></td></tr>
          <tr><td><code>mysql_global_status_innodb_buffer_pool_read_requests</code> vs <code>reads</code></td><td>Buffer pool hit rate</td><td>hit rate &lt; 95% → add RAM</td></tr>
          <tr><td><code>rate(mysql_global_status_slow_queries[5m])</code></td><td>Slow query rate</td><td>&gt; 0 sustained → investigate</td></tr>
          <tr><td><code>mysql_global_status_innodb_row_lock_waits</code></td><td>Row lock waits</td><td>Sudden spike → contention</td></tr>
          <tr><td><code>mysql_slave_status_seconds_behind_master</code></td><td>Replication lag</td><td>&gt; 30s → alert</td></tr>
          <tr><td><code>mysql_global_status_aborted_connects</code></td><td>Failed connections</td><td>Spike → auth issues / network</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tab-panel" data-tab-panel="metrics-rd">
      <table>
        <thead><tr><th>Metric</th><th>What it tells you</th><th>Alert threshold</th></tr></thead>
        <tbody>
          <tr><td><code>redis_up</code></td><td>Redis reachable</td><td>= 0 → alert</td></tr>
          <tr><td><code>redis_memory_used_bytes</code> vs <code>redis_memory_max_bytes</code></td><td>Memory usage</td><td>&gt; 80% of maxmemory</td></tr>
          <tr><td><code>redis_connected_clients</code></td><td>Active connections</td><td>Spike → connection leak</td></tr>
          <tr><td><code>redis_keyspace_hits_total</code> / (hits+misses)</td><td>Cache hit rate</td><td>&lt; 90% → hot keys missing</td></tr>
          <tr><td><code>redis_rejected_connections_total</code></td><td>Rejected (maxclients hit)</td><td>&gt; 0 → raise maxclients</td></tr>
          <tr><td><code>redis_replication_backlog_first_byte_offset</code></td><td>Replication lag</td><td>High → replica falling behind</td></tr>
          <tr><td><code>redis_rdb_last_bgsave_status</code></td><td>Last RDB snapshot status</td><td>!= ok → snapshot failing</td></tr>
          <tr><td><code>redis_blocked_clients</code></td><td>Clients blocked on BLPOP etc</td><td>High → consumers not draining</td></tr>
          <tr><td><code>rate(redis_commands_processed_total[1m])</code></td><td>Ops/sec</td><td>Baseline for anomaly detection</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tab-panel" data-tab-panel="metrics-mg">
      <table>
        <thead><tr><th>Metric</th><th>What it tells you</th><th>Alert threshold</th></tr></thead>
        <tbody>
          <tr><td><code>mongodb_up</code></td><td>DB reachable</td><td>= 0 → alert</td></tr>
          <tr><td><code>mongodb_connections_current</code></td><td>Active connections</td><td>&gt; 80% of <code>maxIncomingConnections</code></td></tr>
          <tr><td><code>mongodb_opcounters_total</code></td><td>Ops/sec (insert/query/update)</td><td>Baseline for anomaly</td></tr>
          <tr><td><code>mongodb_memory_resident_mb</code></td><td>RAM used by mongod</td><td>&gt; 80% of system RAM</td></tr>
          <tr><td><code>mongodb_globalLock_currentQueue_total</code></td><td>Global lock queue</td><td>&gt; 0 sustained → severe contention</td></tr>
          <tr><td><code>mongodb_repl_lag</code></td><td>Replica set replication lag</td><td>&gt; 10s → alert</td></tr>
          <tr><td><code>mongodb_wiredTiger_cache_bytes_currently_in_cache</code></td><td>WiredTiger cache usage</td><td>&gt; 80% of cache size</td></tr>
          <tr><td><code>rate(mongodb_mongod_op_latencies_latency_total[5m])</code></td><td>Operation latency</td><td>Spike → slow queries</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">MySQL's buffer pool hit rate isn't its own exported metric — the table above lists two counters instead: innodb_buffer_pool_read_requests and reads. Why can't you alert on either one alone?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>read_requests</code> counts every logical read (cache hit or miss), and <code>reads</code> counts only the physical disk reads that fell through to storage. Neither number means anything about cache health by itself — a busy server has a rising <code>reads</code> count just from doing more total work. The hit rate only exists as their ratio: <code>1 - (reads / read_requests)</code>. Alerting on a raw counter instead of the ratio would fire (or stay silent) based on traffic volume, not on whether the buffer pool is actually undersized.</div>
</div>

---

## Alerting Rules

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: database-alerts
  namespace: monitoring
spec:
  groups:
  - name: postgres
    rules:
    - alert: PostgresDown
      expr: pg_up == 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "PostgreSQL is down on {{ $labels.instance }}"

    - alert: PostgresHighConnections
      expr: pg_stat_activity_count / pg_settings_max_connections > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PostgreSQL connections above 80% ({{ $value | humanizePercentage }})"

    - alert: PostgresLongRunningQuery
      expr: pg_stat_activity_max_tx_duration > 300
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Query running > 5min on {{ $labels.instance }}"

    - alert: PostgresReplicationLag
      expr: pg_stat_replication_pg_wal_lsn_diff > 52428800   # 50MB
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Postgres replica lag {{ $value | humanize1024 }}B"

  - name: redis
    rules:
    - alert: RedisDown
      expr: redis_up == 0
      for: 1m
      labels:
        severity: critical

    - alert: RedisHighMemory
      expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Redis memory above 80% on {{ $labels.instance }}"

    - alert: RedisCacheHitRateLow
      expr: |
        rate(redis_keyspace_hits_total[5m]) /
        (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m])) < 0.9
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Redis hit rate below 90%: {{ $value | humanizePercentage }}"
```

Notice every rule pairs its `expr` with a `for:` duration before it's allowed to fire. That's a debounce: the condition has to hold continuously for the full window, not just be true on one 15s scrape, before Alertmanager sees it as firing. `PostgresDown` uses a short `for: 1m` because a real outage should page fast, while `RedisCacheHitRateLow` uses `for: 10m` because hit rate naturally dips for a few seconds under a traffic burst and that alone isn't worth waking anyone up. The `severity` label (`critical` vs `warning`) is what routes the alert to the right channel downstream in Alertmanager — it's data the rule attaches, not something Alertmanager infers on its own.

<div class="quiz-card">
  <p class="quiz-q">RedisHighMemory uses for: 5m and RedisCacheHitRateLow uses for: 10m. If you changed both to for: 0s so they fire the instant the expression is true, what would actually improve — and what would get worse?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Nothing meaningfully improves — a real, sustained problem still crosses the threshold and fires either way, just a few minutes earlier. What gets worse is noise: a momentary memory blip or a few seconds of cache misses during a traffic burst would now page or Slack someone immediately, even though the file's own rules already show those conditions self-correcting within minutes in normal operation. The <code>for:</code> duration exists specifically to only fire on conditions that persist, not ones that spike and recover.</div>
</div>

---

## Grafana Dashboards

Import pre-built dashboards from grafana.com by ID:

| Dashboard | Grafana ID | For |
|-----------|-----------|-----|
| PostgreSQL Database | `9628` | postgres_exporter |
| MySQL Overview | `7362` | mysqld_exporter |
| Redis Dashboard | `11835` | redis_exporter |
| MongoDB Overview | `2583` | mongodb_exporter |
| Node Exporter Full | `1860` | host-level CPU/disk/network |

```bash
# Import via Grafana API
curl -X POST http://admin:changeme@localhost:3000/api/dashboards/import \
  -H "Content-Type: application/json" \
  -d '{"gnetId": 9628, "overwrite": true, "folderId": 0}'
```

---

## What to Put on the DB Overview Dashboard

```mermaid
graph TD
    classDef health fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef perf fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef res fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef cache fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef alerts fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph Row1["Row 1 — Health (is it even up?)"]
        H1["pg_up / redis_up / mysql_up<br/>single-stat, red when any = 0"]:::health
        H2["Active connections<br/>vs max_connections / maxclients"]:::health
        H3["Replication lag<br/>across all 4 engines, one panel"]:::health
    end

    subgraph Row2["Row 2 — Performance (is it keeping up?)"]
        P1["Queries/sec<br/>opcounters, ops_processed"]:::perf
        P2["Avg query latency<br/>op_latencies, exec_time"]:::perf
        P3["Slow queries/min<br/>slow_queries, long-running tx"]:::perf
    end

    subgraph Row3["Row 3 — Resources (is it about to run out?)"]
        R1["Memory used vs limit<br/>resident RAM, maxmemory"]:::res
        R2["Disk used %<br/>database_size_bytes"]:::res
        R3["CPU %<br/>from node-exporter, host-level"]:::res
    end

    subgraph Row4["Row 4 — Cache / Buffer (is it hitting disk too often?)"]
        C1["Buffer pool hit rate<br/>MySQL InnoDB"]:::cache
        C2["Redis hit rate<br/>keyspace_hits / (hits+misses)"]:::cache
        C3["Dead tuples<br/>PostgreSQL bloat, needs VACUUM"]:::cache
    end

    subgraph Row5["Row 5 — Alerts firing"]
        A1["Alertmanager panel<br/>everything currently above threshold"]:::alerts
    end

    Row1 --> Row2 --> Row3 --> Row4 --> Row5
```

The ordering is deliberate: health first because nothing else on the dashboard matters if the database is down, resource pressure before cache/buffer detail because a saturated resource explains a bad hit rate before you go hunting for a query-level cause, and Alertmanager last as the summary row that ties back to everything above it.

<div class="quiz-card">
  <p class="quiz-q">Row 4 puts MySQL's buffer pool hit rate and Redis's hit rate in the same "Cache / Buffer" row, even though they're two completely different database engines. Why group by role instead of by database?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Both metrics answer the same question — "how often does a read get served from memory instead of falling through to something slower?" — just for different layers (MySQL's InnoDB buffer pool vs Redis's own keyspace). Grouping by that shared role, rather than by which engine owns the metric, lets you glance at one row and immediately see whether *any* caching layer is under-provisioned, instead of hunting for the same signal spread across four engine-specific rows.</div>
</div>
