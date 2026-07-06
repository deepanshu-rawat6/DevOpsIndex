# GCP Observability — Cloud Monitoring, Logging, Trace, Audit Logs

---

## Observability Service Map

| Pillar | AWS | GCP |
|--------|-----|-----|
| Metrics | CloudWatch Metrics | **Cloud Monitoring** |
| Logs | CloudWatch Logs | **Cloud Logging** |
| Traces | X-Ray | **Cloud Trace** |
| Dashboards | CloudWatch Dashboards | **Cloud Monitoring Dashboards** |
| Alerts | CloudWatch Alarms | **Cloud Monitoring Alerting** |
| API audit trail | CloudTrail | **Cloud Audit Logs** |
| Uptime checks | Route 53 Health Checks | **Cloud Monitoring Uptime Checks** |
| Error tracking | — | **Error Reporting** |
| Profiling | — | **Cloud Profiler** |

**GCP advantage**: GKE, Cloud Run, Cloud SQL, GCE all emit structured logs and metrics automatically. In AWS, you often need CloudWatch Agent configuration before metrics appear.

---

## Cloud Monitoring

Cloud Monitoring collects metrics from all GCP services automatically. You don't configure agents for managed services.

### Metric Types

```
System metrics (auto-collected):
  compute.googleapis.com/instance/cpu/utilization
  kubernetes.io/container/memory/used_bytes
  run.googleapis.com/request_count
  cloudsql.googleapis.com/database/cpu/utilization

Custom metrics (you emit):
  custom.googleapis.com/myapp/orders_processed
  custom.googleapis.com/myapp/queue_depth
```

### Emit Custom Metrics

```python
from google.cloud import monitoring_v3
import time

client = monitoring_v3.MetricServiceClient()
project_name = f"projects/my-project"

series = monitoring_v3.TimeSeries()
series.metric.type = "custom.googleapis.com/myapp/orders_processed"
series.metric.labels["environment"] = "production"
series.resource.type = "global"

now = time.time()
interval = monitoring_v3.TimeInterval({
    "end_time": {"seconds": int(now), "nanos": 0}
})
point = monitoring_v3.Point({
    "interval": interval,
    "value": {"int64_value": 42}
})
series.points = [point]

client.create_time_series(name=project_name, time_series=[series])
```

### Alerting Policies

```bash
# Create an alert when CPU > 80% for 5 minutes
gcloud alpha monitoring policies create \
  --notification-channels=projects/my-project/notificationChannels/12345 \
  --display-name="High CPU Alert" \
  --condition-display-name="CPU > 80%" \
  --condition-filter='resource.type="gce_instance" AND metric.type="compute.googleapis.com/instance/cpu/utilization"' \
  --condition-threshold-value=0.8 \
  --condition-threshold-comparison=COMPARISON_GT \
  --condition-threshold-duration=300s
```

Or use Terraform (recommended for production):

```hcl
resource "google_monitoring_alert_policy" "cpu_alert" {
  display_name = "High CPU Alert"
  combiner     = "OR"

  conditions {
    display_name = "CPU utilization > 80%"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}
```

### Uptime Checks (= Route 53 Health Checks)

```bash
gcloud monitoring uptime create my-service-uptime \
  --display-name="My API Uptime" \
  --resource-type=uptime-url \
  --hostname=api.example.com \
  --path=/health \
  --port=443 \
  --use-ssl \
  --check-interval=60s
```

---

## Cloud Logging

All GCP services write structured logs automatically. Cloud Run, GKE containers, Cloud Functions, Cloud SQL — everything logs to Cloud Logging without agent setup.

### Log Levels and Structure

```python
import logging
from google.cloud import logging as cloud_logging

# In Cloud Run / GKE: just write structured JSON to stdout
import json, sys

def log(severity, message, **kwargs):
    entry = {
        "severity": severity,
        "message": message,
        "component": "order-service",
        **kwargs
    }
    print(json.dumps(entry), flush=True)

log("INFO", "Order placed", order_id="123", amount=99.99)
log("ERROR", "Payment failed", order_id="123", error="card_declined")
```

Cloud Logging automatically indexes structured JSON fields — you can query by `jsonPayload.order_id` directly.

### Log Queries (Cloud Logging Query Language)

```bash
# Query logs via CLI
gcloud logging read 'resource.type="k8s_container" AND severity=ERROR' \
  --limit=50 \
  --freshness=1h \
  --format=json

# Common filters
gcloud logging read 'resource.type="cloud_run_revision" 
  AND resource.labels.service_name="my-api"
  AND severity>=WARNING
  AND timestamp>="2024-01-15T00:00:00Z"' \
  --limit=100
```

```
# Logging Query Language (LQL) — used in console and API

# Filter by log level
severity >= WARNING

# Filter by resource
resource.type = "k8s_container"
resource.labels.namespace_name = "production"

# Filter by log field (structured JSON)
jsonPayload.order_id = "123"
jsonPayload.http_status >= 500

# Full text search
textPayload: "connection refused"

# Time range
timestamp >= "2024-01-15T00:00:00Z" AND timestamp <= "2024-01-15T01:00:00Z"

# Combine
resource.type="cloud_run_revision"
  AND jsonPayload.http_status>=500
  AND severity=ERROR
```

### Log-Based Metrics

Create metrics from log patterns — like CloudWatch Metric Filters:

```bash
# Count ERROR logs per service
gcloud logging metrics create error-rate \
  --description="Errors per service" \
  --log-filter='severity=ERROR AND resource.type="cloud_run_revision"' \
  --value-extractor='EXTRACT(jsonPayload.latency_ms)'   # optional: extract numeric value
```

### Log Sinks — Export to BigQuery / GCS / Pub/Sub

```bash
# Export all ERROR logs to BigQuery for analysis
gcloud logging sinks create errors-to-bigquery \
  bigquery.googleapis.com/projects/my-project/datasets/logs \
  --log-filter='severity >= ERROR'

# Export all logs to GCS (long-term archival)
gcloud logging sinks create all-logs-to-gcs \
  storage.googleapis.com/my-logs-bucket \
  --log-filter='' \
  --include-children   # include logs from child resources
```

### Log Retention

| Log type | Default retention | Configurable |
|---------|-----------------|-------------|
| Admin Activity | 400 days | No (always kept) |
| Data Access | 30 days | Yes (1–3650 days) |
| System Event | 400 days | No |
| User-written | 30 days | Yes |

---

## Cloud Trace

Cloud Trace = AWS X-Ray. Distributed tracing across services.

For GKE and Cloud Run, traces can be auto-collected via OpenTelemetry collector.

### Auto-instrumentation with OpenTelemetry

```python
# requirements.txt
# opentelemetry-api
# opentelemetry-sdk
# opentelemetry-exporter-gcp-trace

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# Setup
provider = TracerProvider()
exporter = CloudTraceSpanExporter(project_id="my-project")
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer(__name__)

# Instrument your code
def process_order(order_id: str):
    with tracer.start_as_current_span("process_order") as span:
        span.set_attribute("order.id", order_id)
        
        with tracer.start_as_current_span("validate_payment"):
            validate_payment(order_id)
        
        with tracer.start_as_current_span("update_inventory"):
            update_inventory(order_id)
```

### Auto-instrumentation in GKE (OpenTelemetry Operator)

```yaml
# Annotate a deployment for auto-instrumentation (no code changes)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
  annotations:
    instrumentation.opentelemetry.io/inject-python: "true"
spec:
  template:
    metadata:
      labels:
        app: my-service
```

---

## Cloud Audit Logs

Every GCP API call is logged in Audit Logs. Equivalent to CloudTrail — but mandatory for Admin Activity (cannot be disabled).

### Log Types

| Type | What it captures | Default enabled |
|------|-----------------|----------------|
| **Admin Activity** | Create/delete/modify resources | Always on |
| **Data Access** | Read data, get metadata | Off by default (verbose + costly) |
| **System Event** | Google-initiated (live migrations, auto-repairs) | Always on |
| **Policy Denied** | Requests denied by VPC Service Controls | Always on |

```bash
# Query audit logs for all GCS deletions
gcloud logging read \
  'protoPayload.serviceName="storage.googleapis.com"
   AND protoPayload.methodName="storage.objects.delete"' \
  --freshness=24h

# Query for who modified IAM policies
gcloud logging read \
  'protoPayload.methodName="SetIamPolicy"
   AND protoPayload.serviceName="iam.googleapis.com"' \
  --freshness=7d
```

### Enable Data Access Logs

```bash
# Enable for Cloud Storage (logs all read/write access)
gcloud projects get-iam-policy my-project > policy.yaml
# Add to policy.yaml:
#   auditConfigs:
#   - auditLogConfigs:
#     - logType: DATA_READ
#     - logType: DATA_WRITE
#     service: storage.googleapis.com
gcloud projects set-iam-policy my-project policy.yaml
```

---

## Error Reporting

Automatically groups exceptions from Cloud Run, GKE, App Engine, and Cloud Functions. No setup needed — just let exceptions bubble with a stack trace.

```bash
# View errors
gcloud error-reporting events list --service=my-api --version=v2
```

In the console: Error Reporting shows count, first/last seen, affected users, and the stack trace grouped by error signature.

---

## Cloud Profiler

Continuous CPU and memory profiling in production. No sampling gaps, minimal overhead (<1%). Equivalent to AWS CodeGuru Profiler.

```python
# Add to your main.py
import googlecloudprofiler

googlecloudprofiler.start(
    service="my-api",
    service_version="1.0.0",
    project_id="my-project"
)
```

Shows flame graphs in the GCP console — where CPU time is actually spent in production.

---

## Monitoring Stack Summary

| Need | Tool |
|------|------|
| VM / GKE / Cloud Run metrics | Cloud Monitoring (automatic) |
| Custom business metrics | Cloud Monitoring custom metrics |
| Application logs | Cloud Logging (write structured JSON to stdout) |
| Log queries and alerts | Cloud Logging + Log-based metrics |
| Distributed tracing | Cloud Trace + OpenTelemetry |
| Audit trail (who did what) | Cloud Audit Logs |
| Exception tracking | Error Reporting |
| Production CPU profiling | Cloud Profiler |
| Long-term log archival | Log Sink → GCS |
| Log analytics with SQL | Log Sink → BigQuery |
| Third-party (Grafana, etc.) | Metrics via Cloud Monitoring API |

### GCP vs AWS Observability

| | GCP | AWS |
|--|---|---|
| **Auto-instrumentation** | GKE + Cloud Run log/metric automatically | Requires CloudWatch agent for EC2 |
| **Log format** | Structured JSON indexed immediately | Raw text (Insights adds parsing) |
| **Trace format** | CloudEvents / OTel (open standard) | X-Ray format (proprietary) |
| **Audit log retention** | Admin Activity: 400 days (permanent) | CloudTrail: configurable, paid |
| **Uptime checks** | Free (50 checks) | Route 53 health checks ($0.50/check/mo) |
| **Error grouping** | Error Reporting (automatic) | CloudWatch (manual) |
