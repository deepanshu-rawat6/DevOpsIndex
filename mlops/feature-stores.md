# Feature Stores

A feature store solves one problem: **training-serving skew** — the model trains on one version of a feature and serves predictions using a different version, silently degrading accuracy.

Each major section below ends with a quick knowledge check — track your progress:

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## The Problem Without a Feature Store

```mermaid
graph TD
    subgraph "Without Feature Store (common pattern)"
        DW["Data Warehouse<br>(Snowflake / BigQuery)"] -->|batch SQL| TRAIN["Training job<br>features computed one way"]
        APP["Application DB<br>(Postgres / DynamoDB)"] -->|real-time query| SERVE["Serving code<br>features computed differently"]
        TRAIN -. "features computed<br>different time windows,<br>different logic" .-> SERVE
    end
```

The training feature `avg_order_value_30d` is computed over a 30-day window from the data warehouse. The serving feature is computed over the last 100 records from Postgres. These are different — model gets different inputs at training vs serving time → accuracy degrades silently.

<div class="quiz-card">
  <p class="quiz-q">Training computes <code>avg_order_value_30d</code> from a 30-day warehouse window; serving computes it from the last 100 Postgres records. Why is this a problem even though both are "the same feature"?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>They're two different computations of what's supposed to be the same feature &mdash; different time windows, different logic, different data sources. The model was trained on one distribution of values and now serves predictions on a different one, so accuracy degrades silently with no error or crash pointing to the cause. That gap is training-serving skew.</div>
</div>

---

## Feature Store Architecture

```mermaid
graph TD
    RAW["Raw data<br>(events, transactions, user actions)"] --> TRANS["Feature transformation<br>(batch + streaming)"]

    subgraph FeatureStore["Feature Store"]
        OFF["Offline Store<br>Parquet / BigQuery / Snowflake<br>Historical features for training"]
        ON["Online Store<br>Redis / DynamoDB / Cassandra<br>Low-latency for serving"]
        REG["Feature Registry<br>schema, metadata, ownership"]
    end

    TRANS --> OFF & ON
    OFF -->|"point-in-time join<br>(prevents leakage)"| TRAIN["Training dataset"]
    ON -->|"<10ms lookup"| SERVE["Serving: predict(features)"]
    REG --> TRANS
```

Both training and serving read from the same feature definitions → identical features guaranteed.

<div class="quiz-card">
  <p class="quiz-q">What actually guarantees that training and serving see identical features in this architecture — not just "best practice," but the mechanism?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Both paths read from the same feature definitions in the registry, and both are fed by the same transformation logic. Training goes through the offline store via a point-in-time join; serving goes through the online store via a low-latency lookup &mdash; but neither side independently recomputes the feature its own way, which is exactly what caused the skew in the previous section.</div>
</div>

---

## Online vs Offline Store

| | Offline Store | Online Store |
|--|---------------|-------------|
| Storage | Parquet / BigQuery / Redshift | Redis / DynamoDB / Cassandra |
| Latency | Seconds to minutes | < 10ms |
| Scale | Petabytes (all history) | Gigabytes (latest values only) |
| Use case | Training dataset generation | Real-time inference |
| Access pattern | Full scan / range query | Point lookup by entity ID |

The **online store contains only the latest feature values**. If you need `user_123`'s `avg_order_value_30d` at inference time, the online store has the pre-computed current value — no need to query the data warehouse.

<div class="quiz-card">
  <p class="quiz-q">At inference time, does the online store recompute <code>avg_order_value_30d</code> from scratch by querying the data warehouse?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The online store only holds the latest pre-computed feature values and does a point lookup by entity ID in under 10ms &mdash; the expensive computation already happened earlier during the batch/streaming transformation and materialization step, not at request time.</div>
</div>

---

## Feast — Open-Source Feature Store

Feast implements the architecture above end to end. The same pipeline recurs across every feature store product — install it, define what a feature is, keep the online store fresh, then read from either side for training or serving:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Install.</strong> <code>pip install feast[redis,aws]</code> and <code>feast init</code> scaffold a feature repo &mdash; a directory of Python files that will declare entities, sources, and feature views.
    </div>
    <div class="stepper-panel">
      <strong>2. Define features.</strong> Declare an <code>Entity</code> (the primary key, e.g. <code>user_id</code>), a <code>FileSource</code> pointing at raw feature data with a timestamp field, and a <code>FeatureView</code> grouping related fields with a TTL.
    </div>
    <div class="stepper-panel">
      <strong>3. Materialize.</strong> <code>feast apply</code> registers the definitions in the registry; <code>feast materialize-incremental</code> &mdash; typically a CronJob running hourly &mdash; copies the latest feature values from the offline store into the online store (Redis).
    </div>
    <div class="stepper-panel">
      <strong>4. Train.</strong> <code>get_historical_features()</code> takes an entity dataframe with timestamps and returns features as they existed at each timestamp &mdash; a point-in-time join against the offline store, preventing leakage.
    </div>
    <div class="stepper-panel">
      <strong>5. Serve.</strong> <code>get_online_features()</code> looks up the same feature names for a live entity ID against the online store in under 10ms &mdash; same definitions, different store, no train/serve gap.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

### Install on K8s

```bash
pip install feast[redis,aws]

# Initialize a feature repo
feast init my-feature-repo
cd my-feature-repo
```

### Define features

```python
# feature_repo/features.py
from datetime import timedelta
from feast import Entity, FeatureView, Field, FileSource
from feast.types import Float64, Int64, String

# Entity = the primary key your features are about
user = Entity(name="user_id", description="User identifier")

# Source = where raw feature data lives
user_stats_source = FileSource(
    path="s3://my-data/features/user_stats.parquet",
    timestamp_field="event_timestamp",   # for point-in-time joins
)

# FeatureView = a group of related features from a source
user_stats = FeatureView(
    name="user_stats",
    entities=[user],
    ttl=timedelta(days=7),      # features expire after 7 days
    schema=[
        Field(name="avg_order_value_30d", dtype=Float64),
        Field(name="order_count_90d", dtype=Int64),
        Field(name="days_since_last_order", dtype=Int64),
        Field(name="preferred_category", dtype=String),
    ],
    source=user_stats_source,
    online=True,    # also materialized to online store
)
```

### Materialize features to online store

```bash
# Apply feature definitions to registry
feast apply

# Materialize: copy latest features from offline → online store (Redis)
# Run this as a CronJob — e.g., every hour
feast materialize-incremental $(date -u +"%Y-%m-%dT%H:%M:%S")
```

```yaml
# K8s CronJob for materialization
apiVersion: batch/v1
kind: CronJob
metadata:
  name: feast-materialize
spec:
  schedule: "0 * * * *"    # every hour
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: feast
            image: myrepo/feast:v1.0
            command:
            - feast
            - materialize-incremental
            - $(date -u +"%Y-%m-%dT%H:%M:%S")
            env:
            - name: FEAST_REPO_PATH
              value: /app/feature_repo
          restartPolicy: OnFailure
```

### Training: get historical features with point-in-time join

```python
from feast import FeatureStore
import pandas as pd

store = FeatureStore(repo_path="./feature_repo")

# Entity dataframe: what entities and when (prevents future leakage)
entity_df = pd.DataFrame({
    "user_id": ["user_1", "user_2", "user_3"],
    "event_timestamp": ["2024-01-15", "2024-01-15", "2024-01-15"],
})

# Feast retrieves feature values AS OF the event_timestamp
# This prevents data leakage: no future data used in training
training_df = store.get_historical_features(
    entity_df=entity_df,
    features=[
        "user_stats:avg_order_value_30d",
        "user_stats:order_count_90d",
        "user_stats:preferred_category",
    ],
).to_df()

# training_df has features as they existed at each event_timestamp
# No leakage, identical computation to what serving will use
```

### Serving: get online features (< 10ms)

```python
# At inference time — same feature definitions, different store
online_features = store.get_online_features(
    features=[
        "user_stats:avg_order_value_30d",
        "user_stats:order_count_90d",
        "user_stats:preferred_category",
    ],
    entity_rows=[{"user_id": "user_123"}],
).to_dict()

# Pass to model
prediction = model.predict(online_features)
```

---

## Point-in-Time Join — Preventing Data Leakage

Without point-in-time correctness, your training data uses future information that won't be available at serving time:

```
User placed order on Jan 15.
Feature: avg_order_value_30d as of Jan 15 = $45 (correct — only past 30 days)

Without PIT join: feature value = avg over ALL orders including future ones = $62 (leakage)
With PIT join:    feature value = avg over orders before Jan 15 = $45 (correct)
```

This is why the feature store — not a manual SQL join — handles feature retrieval for training. The timestamp-aware join is the core correctness guarantee.

---

## Training-Serving Skew — The Key Problem to Solve

| Cause | Detection | Fix |
|-------|-----------|-----|
| Different computation logic | Compare feature distributions between training and serving | Use same feature definitions in both |
| Different time windows | A/B test shows model worse than expected | Point-in-time join in feature store |
| Stale online features | Drift in online feature values vs offline | Reduce materialization interval |
| Missing features at serving | High null rate in serving logs | Add default values + monitoring |

```python
# Detect skew: compare feature stats between training and serving
from evidently.metric_preset import DataDriftPreset

training_features = store.get_historical_features(...).to_df()
serving_features = pd.read_parquet("s3://logs/serving-features-last-week.parquet")

report = Report(metrics=[DataDriftPreset()])
report.run(reference_data=training_features, current_data=serving_features)
# If significant drift: training-serving skew is present
```

---

## When to Use a Feature Store

```
✅ Use when:
  - Multiple models share the same features (don't recompute)
  - Training-serving skew is causing model degradation
  - Feature computation is expensive (30-day aggregations, graph features)
  - Compliance requires reproducible feature values for audit

❌ Skip when:
  - Single model, simple features (just pass raw fields)
  - Features are just the raw DB columns (no transformation)
  - Small team, early stage — add later when skew becomes a problem
```
