# Database Monitoring: On-Prem (K8s & EC2)

Prometheus + Grafana stack for MySQL, PostgreSQL, Redis, MongoDB running on-prem or EC2/self-managed K8s.

---

## Architecture

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    subgraph DBLayer["Database Layer (K8s pods or EC2 VMs)"]
        PG["PostgreSQL"]:::blue
        MY["MySQL"]:::blue
        RD["Redis"]:::blue
        MG["MongoDB"]:::blue
    end

    subgraph Exporters["Exporters (sidecar or separate pod/process)"]
        PGE["postgres_exporter<br/>:9187"]:::teal
        MYE["mysqld_exporter<br/>:9104"]:::teal
        RDE["redis_exporter<br/>:9121"]:::teal
        MGE["mongodb_exporter<br/>:9216"]:::teal
    end

    subgraph Observability["Observability Stack"]
        PROM["Prometheus<br/>scrapes /metrics every 15s"]:::orange
        ALERT["Alertmanager<br/>routes alerts"]:::red
        GRAF["Grafana<br/>dashboards"]:::green
        LOKI["Loki (optional)<br/>log aggregation"]:::orange
    end

    NOTIF["PagerDuty / Slack / Email"]:::red

    PG -->|queries| PGE
    MY -->|queries| MYE
    RD -->|queries| RDE
    MG -->|queries| MGE

    PGE & MYE & RDE & MGE -->|scrape /metrics| PROM
    PROM --> ALERT
    PROM --> GRAF
    ALERT --> NOTIF
```

Exporters are the bridge — they query the DB using native protocol and expose Prometheus `/metrics` endpoint.

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

### PostgreSQL

| Metric | What it tells you | Alert threshold |
|--------|------------------|-----------------|
| `pg_up` | Is exporter connected to DB | = 0 → DB down |
| `pg_database_size_bytes` | Database disk usage | > 80% of disk |
| `pg_stat_activity_count` | Active connections | > 80% of `max_connections` |
| `pg_stat_activity_max_tx_duration` | Longest running transaction | > 300s → long-running query |
| `pg_stat_bgwriter_checkpoint_write_time` | Checkpoint I/O time | Sustained high → I/O bottleneck |
| `pg_stat_replication_pg_wal_lsn_diff` | Replication lag (bytes) | > 50MB → replica falling behind |
| `pg_locks_count` | Lock contention | Sudden spike → deadlock risk |
| `pg_stat_user_tables_n_dead_tup` | Dead tuples (bloat) | High → needs VACUUM |
| `rate(pg_stat_user_tables_seq_scan[5m])` | Sequential scans | High on large tables → missing index |
| `pg_stat_statements_mean_exec_time_seconds` | Slow query avg time | Spike → bad query plan / missing index |

### MySQL

| Metric | What it tells you | Alert threshold |
|--------|------------------|-----------------|
| `mysql_up` | DB reachable | = 0 → alert |
| `mysql_global_status_threads_connected` | Active connections | > 80% of `max_connections` |
| `mysql_global_status_innodb_buffer_pool_read_requests` vs `reads` | Buffer pool hit rate | hit rate < 95% → add RAM |
| `rate(mysql_global_status_slow_queries[5m])` | Slow query rate | > 0 sustained → investigate |
| `mysql_global_status_innodb_row_lock_waits` | Row lock waits | Sudden spike → contention |
| `mysql_slave_status_seconds_behind_master` | Replication lag | > 30s → alert |
| `mysql_global_status_aborted_connects` | Failed connections | Spike → auth issues / network |

### Redis

| Metric | What it tells you | Alert threshold |
|--------|------------------|-----------------|
| `redis_up` | Redis reachable | = 0 → alert |
| `redis_memory_used_bytes` vs `redis_memory_max_bytes` | Memory usage | > 80% of maxmemory |
| `redis_connected_clients` | Active connections | Spike → connection leak |
| `redis_keyspace_hits_total` / `(hits+misses)` | Cache hit rate | < 90% → hot keys missing |
| `redis_rejected_connections_total` | Rejected (maxclients hit) | > 0 → raise maxclients |
| `redis_replication_backlog_first_byte_offset` | Replication lag | High → replica falling behind |
| `redis_rdb_last_bgsave_status` | Last RDB snapshot status | != ok → snapshot failing |
| `redis_blocked_clients` | Clients blocked on BLPOP etc | High → consumers not draining |
| `rate(redis_commands_processed_total[1m])` | Ops/sec | Baseline for anomaly detection |

### MongoDB

| Metric | What it tells you | Alert threshold |
|--------|------------------|-----------------|
| `mongodb_up` | DB reachable | = 0 → alert |
| `mongodb_connections_current` | Active connections | > 80% of `maxIncomingConnections` |
| `mongodb_opcounters_total` | Ops/sec (insert/query/update) | Baseline for anomaly |
| `mongodb_memory_resident_mb` | RAM used by mongod | > 80% of system RAM |
| `mongodb_globalLock_currentQueue_total` | Global lock queue | > 0 sustained → severe contention |
| `mongodb_repl_lag` | Replica set replication lag | > 10s → alert |
| `mongodb_wiredTiger_cache_bytes_currently_in_cache` | WiredTiger cache usage | > 80% of cache size |
| `rate(mongodb_mongod_op_latencies_latency_total[5m])` | Operation latency | Spike → slow queries |

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

```
Row 1: Health
  [ pg_up / redis_up / mysql_up ]  [ active connections ]  [ replication lag ]

Row 2: Performance
  [ queries/sec ]  [ avg query latency ]  [ slow queries/min ]

Row 3: Resources
  [ memory used vs limit ]  [ disk used % ]  [ CPU % ]

Row 4: Cache / Buffer
  [ buffer pool hit rate (MySQL) ]  [ Redis hit rate ]  [ dead tuples (PG) ]

Row 5: Alerts firing (Alertmanager panel)
```
