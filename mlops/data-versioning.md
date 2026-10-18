# Data Versioning

Code lives in git. Data is different: it is large, binary, mutable, and its changes are just as likely to break your model as a code bug. Data versioning gives every training run a pointer to the exact dataset it used — so you can reproduce any model, debug any regression, and audit any prediction.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Why Data Versioning Is Hard

Data doesn't behave like code, and git isn't designed for it:

- **Size**: git objects are immutable blobs — adding and removing a 100GB dataset bloats the object store permanently. `git clone` of such a repo downloads everything.
- **Decorrelation**: the same training script run on Monday vs Friday data can produce very different models. Without data versioning, you can't tell which changed.
- **Silent degradation**: "this model was 94% accurate last month, now it's 89%" — without data versioning, you cannot isolate whether the data or the code caused the regression.
- **Compliance**: regulated domains (healthcare, finance) require proof of exactly what data trained each production model. "We think it was this dataset" is not an audit trail.

The solution isn't to put data in git — it's to put a **pointer** to data in git and store the data separately.

---

## DVC: Data Version Control

DVC (Data Version Control) replaces large files with tiny `.dvc` pointer files that live in git. The actual data lives in a remote (S3, GCS, Azure, local).

**Initialize**:

```bash
dvc init        # creates .dvc/ directory — commit this to git
dvc remote add -d myremote s3://mybucket/dvc   # default remote
git add .dvc .dvcignore
git commit -m "chore: initialize DVC"
```

**Track a dataset**:

```bash
dvc add data/train.csv
# Creates: data/train.csv.dvc  (tiny JSON with md5 hash — commit this)
# Adds:    data/train.csv to .gitignore (don't track the actual file)

git add data/train.csv.dvc data/.gitignore
git commit -m "data: add train.csv v1"
dvc push   # uploads data/train.csv to S3
```

**The `.dvc` file** is a stable pointer:

```yaml
# data/train.csv.dvc
outs:
- md5: a1b2c3d4e5f6...   # exact hash of the file
  size: 2147483648        # 2GB
  path: train.csv
```

**Reproduce any historical version**:

```bash
git checkout v1.2-tag     # switch code to tag
dvc checkout              # fetch data matching that tag's .dvc hashes
# Now your working directory has exactly the data that trained v1.2
```

**Status check**:

```bash
dvc status        # which tracked files differ from their .dvc checksums?
dvc status --cloud  # which local files aren't pushed to remote?
```

---

## DVC Pipelines

DVC pipelines make the full training workflow reproducible — not just the data, but every transformation step.

**`dvc.yaml`**:

```yaml
stages:
  preprocess:
    cmd: python preprocess.py --input data/raw --output data/processed
    deps:
    - data/raw              # input dataset (tracked by DVC)
    - preprocess.py         # source code
    outs:
    - data/processed        # output tracked by DVC

  train:
    cmd: python train.py --data data/processed --output models/
    deps:
    - data/processed
    - train.py
    - params.yaml           # hyperparameters
    outs:
    - models/model.pkl
    metrics:
    - metrics/eval.json:
        cache: false        # don't cache metrics, always recompute

  evaluate:
    cmd: python evaluate.py --model models/model.pkl --output metrics/
    deps:
    - models/model.pkl
    - evaluate.py
    metrics:
    - metrics/eval.json
    plots:
    - metrics/confusion_matrix.csv
```

**Running the pipeline**:

```bash
dvc repro            # runs only stages where deps have changed (like make)
dvc dag              # visualize pipeline dependency graph
dvc dag --md         # export as Markdown table
```

**Comparing across versions**:

```bash
dvc params diff v1.0..v1.5      # hyperparameter changes between tags
dvc metrics diff v1.0..v1.5     # accuracy/F1 changes between tags
dvc plots diff v1.0..v1.5       # confusion matrix diff
```

DVC's caching means if `data/raw` hasn't changed, the preprocess stage is skipped entirely — saves hours on large datasets.

---

## Delta Lake

Delta Lake adds ACID transactions and time travel to Parquet files stored in object storage. It's the foundation for large feature stores and data warehouses.

**Creating a Delta table**:

```python
# Write initial data
df.write.format("delta").save("s3://bucket/features/user_features")

# Or create via SQL
spark.sql("""
  CREATE TABLE user_features
  USING DELTA
  LOCATION 's3://bucket/features/user_features'
  AS SELECT * FROM staging.user_features
""")
```

**MERGE INTO for upserts** (critical for feature stores — updating existing rows without a full rewrite):

```python
from delta.tables import DeltaTable

deltaTable = DeltaTable.forPath(spark, "s3://bucket/features/user_features")

deltaTable.alias("target").merge(
    new_features.alias("source"),
    "target.user_id = source.user_id"
).whenMatchedUpdateAll(
).whenNotMatchedInsertAll(
).execute()
```

**Time travel** — query any historical snapshot:

```python
# By version number
df_v10 = spark.read.format("delta") \
    .option("versionAsOf", 10) \
    .load("s3://bucket/features/user_features")

# By timestamp
df_jan = spark.read.format("delta") \
    .option("timestampAsOf", "2024-01-15") \
    .load("s3://bucket/features/user_features")

# Check history
deltaTable.history(20).show()
```

**Schema evolution**: add new columns without rewriting the table:

```python
df_with_new_col.write.format("delta") \
    .option("mergeSchema", "true") \
    .mode("append") \
    .save("s3://bucket/features/user_features")
```

**VACUUM** — clean up old files:

```python
# Remove files older than 7 days
deltaTable.vacuum(retentionHours=168)
```

**VACUUM breaks time travel** for the deleted window. If you need to reproduce a model trained 30 days ago, set `spark.databricks.delta.retentionDurationCheck.enabled = false` and use `vacuum(720)` (30 days) or snapshot the table explicitly at training time.

---

## OpenLineage and Data Lineage

Data lineage answers: "which models use this table?" and "if I change this schema, what breaks?"

**OpenLineage** is an open standard for dataset-level lineage events. Every job emits a `RunEvent` JSON with its inputs and outputs.

**Key RunEvent fields**:

```json
{
  "eventType": "COMPLETE",
  "run": { "runId": "abc-123" },
  "job": { "namespace": "airflow", "name": "preprocess_user_features" },
  "inputs": [
    { "namespace": "s3://bucket", "name": "raw/user_events" }
  ],
  "outputs": [
    { "namespace": "s3://bucket", "name": "features/user_features" }
  ]
}
```

**Airflow integration** — zero-code, automatic lineage:

```bash
pip install openlineage-airflow
# Set in airflow.cfg:
# [openlineage]
# transport = {"type": "http", "url": "http://marquez:5000"}
```

Every Airflow operator (PythonOperator, SparkSubmitOperator, etc.) automatically emits start/complete/fail events with dataset I/O.

**Spark integration**:

```
spark.jars.packages=io.openlineage:openlineage-spark_2.12:1.x.x
spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener
spark.openlineage.transport.type=http
spark.openlineage.transport.url=http://marquez:5000
```

**Marquez** stores and visualizes lineage:

```bash
docker run -p 5000:5000 -p 5001:5001 marquezproject/marquez
# UI at http://localhost:5001
```

Marquez UI shows a DAG: `raw/user_events → preprocess job → user_features → training job → model_v8`. If `raw/user_events` schema changes, impact analysis shows every downstream job and model.

---

## Feature Store Versioning

Feature stores add versioning and consistency guarantees to features used in training and serving.

**Feast feature views with TTL**:

```python
from feast import FeatureView, Field
from feast.types import Float64, Int64
from datetime import timedelta

user_features = FeatureView(
    name="user_features",
    entities=["user_id"],
    ttl=timedelta(days=7),   # features older than 7 days are considered stale
    schema=[
        Field(name="avg_order_value", dtype=Float64),
        Field(name="order_count_30d", dtype=Int64),
    ],
    source=user_features_source,
)
```

**Point-in-time correct joins** — the hardest part of feature engineering:

Training data must use feature values as they *existed at the time of the label*, not the current values. Feast handles this automatically:

```python
# entity_df has columns: user_id, event_timestamp, label
training_df = store.get_historical_features(
    entity_df=entity_df,
    features=["user_features:avg_order_value", "user_features:order_count_30d"],
).to_df()
# Each row gets the feature value that was live at its event_timestamp
```

Without point-in-time joins, training data leaks future information — the model learns from features it couldn't have had in production, causing overoptimistic offline metrics.

**Training-serving skew** — the most common MLOps bug:

Training computes features one way (30-day batch window), serving computes them another way (7-day streaming window). Same feature name, different semantics. Fix: use the same feature server for both paths.

```python
# Training (historical)
training_df = store.get_historical_features(entity_df=entity_df, features=FEATURE_REFS).to_df()

# Serving (real-time) — same store, same logic, different retrieval path
online_features = store.get_online_features(
    features=FEATURE_REFS,
    entity_rows=[{"user_id": uid}]
).to_dict()
```

**Feature versioning**: pin a `FeatureService` for reproducibility:

```python
fraud_v2_service = FeatureService(
    name="fraud_detection_v2",
    features=[user_features[["avg_order_value", "order_count_30d"]]],
)
```

Each production model references a specific `FeatureService` version. Changing features for a new model doesn't silently change the serving logic for the old one.

---

## Practical Comparison

| Tool | Best for | Scale | ACID | Streaming | Self-hosted |
|---|---|---|---|---|---|
| **DVC** | ML experiment data, model artifacts, git-based workflows | GB–TB (pointer files) | No | No | Yes |
| **Delta Lake** | Large feature stores, data warehouses, upserts | TB–PB | Yes | Yes (Structured Streaming) | Yes (Spark) |
| **LakeFS** | Git-like branching for entire data lakes | PB | No (copy-on-write) | Partial | Yes |
| **git-lfs** | Binary assets up to ~2GB, simple version history | GB | No | No | Via git server |

**Decision guide**:
- Use **DVC** when you need git-native ML experiment reproducibility and your team already uses git workflows
- Use **Delta Lake** when you need ACID transactions, upserts, and time travel on large (TB+) datasets
- Use **LakeFS** when multiple teams need to branch, test, and merge entire data lake paths safely
- Use **git-lfs** only for small binary assets (images, audio, small model files) where DVC is overkill

---

<div class="quiz-card">
  <p class="quiz-q">You run the same training script on Monday and again on Friday — same code, same config — but get different accuracy. No random seed was set. What is DVC's role in debugging this?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    DVC's <code>.dvc</code> pointer files record the exact MD5 hash of every dataset file used. If <code>dvc status</code> shows your <code>data/train.csv.dvc</code> hash changed between Monday and Friday, the training data changed — someone added or modified rows. Without DVC, you'd have no way to know. With DVC + git, you can <code>git checkout &lt;monday-commit&gt; &amp;&amp; dvc checkout</code> to restore Monday's exact dataset and reproduce Monday's training run exactly.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Your Delta Lake feature table has time-travel retention set to 7 days (VACUUM runs with 168-hour threshold). A data scientist asks to reproduce a model trained 10 days ago. Can they?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. VACUUM removes the Parquet files backing old table versions. Once those files are gone, time travel to that version fails with a "not found" error. They would need to restore from a backup of the Delta log + data files taken before the VACUUM ran. Lesson: for ML reproducibility, either extend the vacuum retention beyond your longest investigation window, or snapshot the feature view explicitly at training time with DVC alongside Delta Lake.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">What is "training-serving skew" and why does it degrade model quality without any code change?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Training-serving skew happens when training uses features computed with different logic than serving. For example: training computes "average order value" with a 30-day window using a weekly batch job, but serving computes it with a 7-day window from a real-time stream. The model learned patterns on the 30-day signal, but at inference time it sees the 7-day signal — same feature name, different semantics. Predictions degrade silently. Fix: use the same feature server (e.g., Feast's online store) for both training (historical path) and serving (online path).
  </div>
</div>
