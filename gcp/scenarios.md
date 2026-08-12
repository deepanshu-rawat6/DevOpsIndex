# GCP Debugging Scenarios

Seven failure patterns you'll actually hit running workloads on GCP — the symptom, a diagnostic flowchart, the commands that confirm the cause, and the prevention that stops it recurring.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. GKE Pod Can't Access Cloud Storage / BigQuery

**Symptom:** Pod gets `403 Permission Denied` calling GCP APIs.

```mermaid
flowchart TD
    classDef err fill:#e74c3c,stroke:#c0392b,color:#fff
    classDef decision fill:#f39c12,stroke:#ba6018,color:#fff
    classDef fix fill:#27ae60,stroke:#1e8449,color:#fff
    classDef verify fill:#3498db,stroke:#2471a3,color:#fff

    ERR["403 calling GCP API from pod"]:::err --> WI
    WI{"Workload Identity<br/>configured on the cluster?"}:::decision -->|No| SETUP
    WI -->|Yes| CHECK

    subgraph SETUP_GROUP["Set up Workload Identity"]
        SETUP["1. Create a GCP service account<br/>2. Bind K8s SA to GCP SA<br/>(roles/iam.workloadIdentityUser)<br/>3. Annotate the K8s SA with<br/>the GCP SA's email<br/>4. Grant the GCP SA the<br/>IAM role it actually needs"]:::fix
    end

    CHECK["Check annotation on K8s SA<br/>kubectl describe sa my-sa"]:::verify --> ROLE
    ROLE{"GCP SA has<br/>the right IAM role?"}:::decision -->|No| GRANT["Grant the role:<br/>gcloud iam bindings add<br/>--role roles/storage.objectViewer"]:::fix
    ROLE -->|Yes| TOKEN["Verify from inside the pod:<br/>curl the metadata server for<br/>/computeMetadata/v1/instance/<br/>service-accounts/default/email"]:::verify
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Confirm Workload Identity is enabled on the cluster.</strong> <code>gcloud container clusters describe my-cluster --region us-central1 --format="value(workloadIdentityConfig)"</code> — if this comes back empty, nothing downstream matters yet; the cluster's metadata server doesn't federate to GCP IAM at all.
    </div>
    <div class="stepper-panel">
      <strong>2. Check the K8s ServiceAccount's annotation.</strong> <code>kubectl describe serviceaccount my-app -n my-namespace</code> should show <code>iam.gke.io/gcp-service-account=my-app@project.iam.gserviceaccount.com</code>. A missing or misspelled annotation means the pod has no path to a GCP identity at all.
    </div>
    <div class="stepper-panel">
      <strong>3. Check the IAM binding on the GCP service account.</strong> <code>gcloud iam service-accounts get-iam-policy</code> should show <code>serviceAccount:project.svc.id.goog[namespace/ksa-name]</code> bound with <code>workloadIdentityUser</code> — this is the binding that lets the K8s SA "become" the GCP SA, separate from whatever IAM role the GCP SA itself holds.
    </div>
    <div class="stepper-panel">
      <strong>4. Test from inside the pod.</strong> Exec a curl against the metadata server's <code>service-accounts/default/email</code> endpoint. If it returns the GCP SA's email, credentials are flowing correctly, and a 403 at that point means the role grant itself is wrong — not the identity plumbing.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```bash
# Step 1: Verify Workload Identity is enabled on cluster
gcloud container clusters describe my-cluster --region us-central1 \
  --format="value(workloadIdentityConfig)"

# Step 2: Check K8s SA annotation
kubectl describe serviceaccount my-app -n my-namespace
# Annotations: iam.gke.io/gcp-service-account=my-app@project.iam.gserviceaccount.com

# Step 3: Check IAM binding
gcloud iam service-accounts get-iam-policy my-app@project.iam.gserviceaccount.com
# Should show: serviceAccount:project.svc.id.goog[namespace/ksa-name] with workloadIdentityUser

# Step 4: Test from inside pod
kubectl exec -it my-pod -- curl -H "Metadata-Flavor: Google" \
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/email"
# Should return: my-app@project.iam.gserviceaccount.com

# Prevention: always use Workload Identity — never mount service account JSON keys
```

<div class="quiz-card">
  <p class="quiz-q">A teammate wants to grant a new GKE pod access to Cloud Storage by baking a service-account JSON key into the container image instead of setting up Workload Identity. What does this scenario's prevention rule say, and what's the correct path?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The prevention rule is explicit: always use Workload Identity — never mount service account JSON keys. The correct path is the one walked through above: create a GCP service account, bind it to the pod's Kubernetes ServiceAccount with the <code>workloadIdentityUser</code> role, annotate the K8s SA with the GCP SA's email, grant the GCP SA the IAM role it needs, then verify with the metadata-server curl from inside the pod.</div>
</div>

---

## 2. GKE Node Pool Scaling Not Working

**Symptom:** Pods stuck Pending despite Cluster Autoscaler configured, nodes not adding.

```mermaid
flowchart TD
    classDef err fill:#e74c3c,stroke:#c0392b,color:#fff
    classDef decision fill:#f39c12,stroke:#ba6018,color:#fff
    classDef fix fill:#27ae60,stroke:#1e8449,color:#fff

    PEND["Pod stuck Pending"]:::err --> LOGS["kubectl -n kube-system logs<br/>-l component=cluster-autoscaler"]
    LOGS --> MSG{"What does the<br/>autoscaler log say?"}:::decision
    MSG -->|"Scale-up blocked<br/>by group minimum"| MIN["min-nodes == current node count<br/>raise the node pool's min-nodes"]:::fix
    MSG -->|"Node pool has<br/>reached max size"| MAX["max-nodes too low for demand<br/>raise the node pool's max-nodes"]:::fix
    MSG -->|"No pending pods"| NOREQ["Pod has no resource requests —<br/>autoscaler can't size a node for it<br/>set requests on every pod"]:::fix
```

```bash
# Check autoscaler logs
kubectl -n kube-system logs -l component=cluster-autoscaler --tail=50

# Common messages:
# "Scale-up blocked by group minimum"  → min nodes = current count
# "Node pool has reached max size"      → increase max-nodes
# "No pending pods"                     → pods have tolerations but no requests

# Check node pool limits
gcloud container node-pools describe default-pool \
  --cluster my-cluster --region us-central1 \
  --format="yaml(autoscaling)"

# Check if autoscaler is enabled
gcloud container clusters describe my-cluster --region us-central1 \
  --format="value(autoscaling.enableNodeAutoprovisioning)"

# Prevention: set explicit resource requests on ALL pods
# HPA/CA both require resource requests to function
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="min" class="active state-warn">Scale-up blocked by group minimum</button>
    <button data-toggle-opt="max" class="state-warn">Node pool has reached max size</button>
    <button data-toggle-opt="norequest" class="state-bad">No pending pods</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="min">
    The node pool's <code>min-nodes</code> is already equal to (or above) its current node count, so the autoscaler treats itself as already at floor capacity and won't add more even though pods are Pending. Fix: raise <code>min-nodes</code>, or check whether something else deliberately capped it there.
  </div>
  <div class="toggle-panel" data-toggle-panel="max">
    The node pool is already at its configured <code>max-nodes</code> ceiling. The autoscaler is working correctly here — it's refusing to scale past a limit you set. Fix: raise <code>max-nodes</code> if the workload genuinely needs more capacity.
  </div>
  <div class="toggle-panel" data-toggle-panel="norequest">
    The sneaky one: <code>kubectl get pods</code> clearly shows Pending pods, but the autoscaler log insists there are none. That's because pods without resource <code>requests</code> set give the scheduler nothing to size a hypothetical new node against — the autoscaler doesn't count them as a scale-up trigger at all. Fix: set explicit CPU/memory requests on every pod.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">The cluster autoscaler logs say "No pending pods," but <code>kubectl get pods</code> clearly shows pods stuck in Pending. What explains the mismatch?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The pods almost certainly have no resource <code>requests</code> set. Both the scheduler and the cluster autoscaler size decisions off requests, not limits or actual usage — with no requests, the autoscaler has no way to compute whether a new node would even fit the pod, so it doesn't register it as a scale-up trigger. This is exactly why the prevention rule here is to set explicit resource requests on <em>all</em> pods: HPA and Cluster Autoscaler both require them to function at all.</div>
</div>

---

## 3. BigQuery Query Costs Unexpectedly High

**Symptom:** Daily BigQuery bill much higher than expected.

```sql
-- Find expensive queries in last 24 hours
SELECT
  job_id,
  user_email,
  query,
  total_bytes_processed / 1e12 AS tb_scanned,
  (total_bytes_processed / 1e12) * 5 AS cost_usd,
  creation_time
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
  AND job_type = 'QUERY'
  AND statement_type != 'SCRIPT'
ORDER BY total_bytes_processed DESC
LIMIT 20;

-- Find tables without partitioning (most common cause)
SELECT table_name, row_count, size_bytes/1e9 AS size_gb
FROM `project.dataset`.INFORMATION_SCHEMA.TABLE_STORAGE
WHERE total_partitions = 0 AND size_bytes > 1e10  -- >10GB unpartitioned
ORDER BY size_bytes DESC;
```

```bash
# Fix: require partition filters on large tables
bq update --require_partition_filter project:dataset.orders

# Set billing cap per query (prevents runaway queries)
# In BigQuery console: Project → Edit → Maximum bytes billed
bq query --maximum_bytes_billed=10000000000 \   # 10GB max
  'SELECT ...'

# Prevention:
# 1. Partition all large tables by date
# 2. Set require_partition_filter=true
# 3. Grant BigQuery Job User (not Data Owner) to analysts
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Find the expensive queries.</strong> Run the <code>INFORMATION_SCHEMA.JOBS_BY_PROJECT</code> query above, sorted by <code>total_bytes_processed</code> — on-demand BigQuery bills per byte scanned, so this ranks jobs (and the users running them) by actual cost, not just runtime.
    </div>
    <div class="stepper-panel">
      <strong>2. Find the root-cause table.</strong> Cross-reference against <code>TABLE_STORAGE</code> for tables with <code>total_partitions = 0</code> and size over 10GB. An unpartitioned multi-terabyte table getting fully scanned on every query is the most common cause of a cost spike.
    </div>
    <div class="stepper-panel">
      <strong>3. Force partition pruning.</strong> <code>bq update --require_partition_filter</code> makes it impossible to run a query against that table without a filter on the partition column — no more accidental full scans from a missing <code>WHERE</code> clause.
    </div>
    <div class="stepper-panel">
      <strong>4. Cap the blast radius.</strong> Set <code>--maximum_bytes_billed</code> per query, and grant analysts <strong>BigQuery Job User</strong> instead of <strong>Data Owner</strong> — so one bad query, or one careless or compromised credential, can't run an unbounded scan.
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
  <p class="quiz-q">Besides partitioning large tables, what does setting <code>require_partition_filter=true</code> actually buy you that partitioning alone doesn't?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Partitioning alone just makes a partition filter <em>possible</em> — it doesn't stop anyone from writing a query that omits the <code>WHERE</code> clause and scans every partition anyway. <code>require_partition_filter=true</code> makes that query fail outright instead of running (and billing) for a full-table scan. Paired with granting analysts BigQuery Job User rather than Data Owner, it limits both how much data a single query can accidentally touch and what a given credential is allowed to do in the first place.</div>
</div>

---

## 4. Cloud Run Service Cold Start Latency

**Symptom:** First request to Cloud Run takes 10+ seconds.

```mermaid
flowchart TD
    classDef cold fill:#e67e22,stroke:#ba6018,color:#fff
    classDef warm fill:#27ae60,stroke:#1e8449,color:#fff
    classDef req fill:#3498db,stroke:#2471a3,color:#fff

    REQ["First request arrives<br/>(no warm instance available)"]:::req --> ALLOC

    subgraph COLD["Cold start path — this is the 10+ seconds"]
        ALLOC["GCP allocates a new<br/>container instance"]:::cold --> PULL["Pull the container image"]:::cold
        PULL --> START["Start the container process"]:::cold
        START --> INIT["App initialization<br/>(connect DB, load config,<br/>warm caches)"]:::cold
    end

    INIT --> HANDLE["Handle the request"]:::req
    HANDLE --> WARM["Container stays warm —<br/>subsequent requests skip<br/>straight to Handle"]:::warm
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Allocate.</strong> A request arrives with no warm instance available, so Cloud Run has to provision a fresh container instance before anything else can happen.
    </div>
    <div class="stepper-panel">
      <strong>2. Pull the image.</strong> The container image is pulled onto that instance. A large image — extra framework layers, unused dependencies — directly adds to this step's duration.
    </div>
    <div class="stepper-panel">
      <strong>3. Start and initialize.</strong> The container process starts, then the app itself initializes: connecting to a database, loading config, warming any in-memory caches. Cloud Run waits for the container to start listening on <code>$PORT</code> before routing traffic to it — it does not use Kubernetes-style startup or readiness probes.
    </div>
    <div class="stepper-panel">
      <strong>4. Handle, then stay warm.</strong> The first request is finally handled. The instance then stays warm for subsequent requests, which skip straight past allocation, pull, and init.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```bash
# Check cold start frequency
gcloud logging read \
  'resource.type="cloud_run_revision" AND textPayload:"Cold start"' \
  --limit 50

# Mitigations:
# 1. Minimum instances (keep N instances warm, costs money)
gcloud run services update my-service \
  --min-instances 1 \
  --region us-central1

# 2. Reduce image size (faster pull)
# Use distroless or scratch base images

# 3. Optimize startup (lazy initialization — connect DB on first request, not at startup)

# 4. Use CPU boost (GCP gives extra CPU during startup)
gcloud run services update my-service \
  --cpu-boost

# 5. Use startup probe correctly — Cloud Run doesn't use K8s probes
# but Cloud Run waits for the container to listen on $PORT before routing
```

<div class="quiz-card">
  <p class="quiz-q">Does Cloud Run use Kubernetes-style startup or readiness probes to know when a cold-started container is ready for traffic?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. Cloud Run doesn't use K8s probes at all — it simply waits for the container to start listening on the <code>$PORT</code> environment variable, and only then routes requests to it. That's the entire readiness signal; there's no separate probe configuration to tune.</div>
</div>

---

## 5. Spanner High Latency or Hotspot

**Symptom:** Spanner p99 latency spikes, or one node has much higher CPU than others.

```bash
# Check for hotspots using Key Visualizer
# GCP Console → Spanner → Instance → Key Visualizer
# Bright spots indicate hot row ranges
```

```mermaid
flowchart TD
    classDef hot fill:#e74c3c,stroke:#c0392b,color:#fff
    classDef cool fill:#27ae60,stroke:#1e8449,color:#fff
    classDef writer fill:#3498db,stroke:#2471a3,color:#fff

    W1["New rows —<br/>sequential UUID or<br/>timestamp leading key"]:::writer -->|"100% of writes"| HOT["Split A — hot<br/>single node absorbs every insert"]:::hot
    HOT -.->|idle| HOT2["Split B"]:::cool
    HOT -.->|idle| HOT3["Split C"]:::cool

    W2["New rows —<br/>randomized UUID key"]:::writer -->|"~33% of writes"| R1["Split A"]:::cool
    W2 -->|"~33% of writes"| R2["Split B"]:::cool
    W2 -->|"~33% of writes"| R3["Split C"]:::cool
```

**Common causes of hotspots in Spanner:**

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="uuid" class="active state-bad">Sequential UUID primary key</button>
    <button data-toggle-opt="timestamp" class="state-bad">Timestamp as leading key</button>
    <button data-toggle-opt="cardinality" class="state-warn">Low-cardinality leading key</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="uuid">
    A UUID that's generated sequentially still sorts sequentially. Since Spanner shards on key ranges, every new row's key lands right after the previous one — all recent inserts pile onto the same split instead of spreading out.
  </div>
  <div class="toggle-panel" data-toggle-panel="timestamp">
    Same failure mode from a different source: if the leading key column is (or starts with) a timestamp, every write from "right now" sorts into the same narrow, ever-advancing range — one split takes 100% of current write traffic no matter how many nodes the instance has.
  </div>
  <div class="toggle-panel" data-toggle-panel="cardinality">
    A leading key column with only a handful of distinct values (a status enum, a small tenant ID set) can only ever be split into that many ranges — traffic concentrates on whichever value is most common, regardless of insert order.
  </div>
</div>

```bash
# Fix: use UUIDs generated randomly (not sequentially)
# Or use bit-reversed sequences:
# Spanner auto-shards on boundary values — random UUIDs distribute naturally

# Check Spanner metrics
gcloud monitoring read \
  'metric.type="spanner.googleapis.com/instance/cpu/utilization_by_priority"' \
  --start="2024-01-15T00:00:00Z" --end="2024-01-15T01:00:00Z"

# Prevention: design schema to avoid hotspots
# Use INTERLEAVE for parent-child relationships (not FK joins)
```

<div class="quiz-card">
  <p class="quiz-q">Switching a Spanner table from sequentially-generated UUIDs to randomly-generated UUIDs fixes a hotspot — but both are still "just UUIDs." Why does randomness matter here?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Spanner shards its keyspace by contiguous key range, not by hashing. A sequentially-generated UUID still sorts in generation order, so every new row's key lands immediately after the last one — all recent inserts concentrate on a single split. A randomly-generated UUID scatters new keys across the entire keyspace, so Spanner's range-based auto-sharding naturally spreads writes across many splits instead of one.</div>
</div>

---

## 6. Pub/Sub Messages Piling Up (High Backlog)

**Symptom:** `subscription/num_undelivered_messages` metric growing, consumers not keeping up.

```mermaid
flowchart TD
    classDef err fill:#e74c3c,stroke:#c0392b,color:#fff
    classDef decision fill:#f39c12,stroke:#ba6018,color:#fff
    classDef fix fill:#27ae60,stroke:#1e8449,color:#fff

    BACKLOG["num_undelivered_messages<br/>climbing"]:::err --> NACK{"High nack /<br/>redelivery rate in logs?"}:::decision
    NACK -->|Yes| ERRORS["Consumers are erroring —<br/>fix the processing bug;<br/>let the dead-letter topic<br/>catch true poison messages"]:::fix
    NACK -->|No| THROUGHPUT{"Consumers keeping up<br/>with the publish rate?"}:::decision
    THROUGHPUT -->|"No — too few workers"| SCALE["Scale consumers horizontally<br/>kubectl scale deployment --replicas=N"]:::fix
    THROUGHPUT -->|"No — ack deadline<br/>too short for processing time"| DEADLINE["Extend the ack deadline<br/>modify-push-config --ack-deadline"]:::fix
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Confirm there's a real backlog.</strong> <code>gcloud pubsub subscriptions describe</code> for <code>numUndeliveredMessages</code> and <code>oldestUnackedMessage</code> — the age of the oldest message tells you how far behind delivery actually is, not just how many messages are queued.
    </div>
    <div class="stepper-panel">
      <strong>2. Rule out errors first.</strong> Check the logs for nacks. A high nack rate means consumers are actively failing to process messages — that's a code/data bug, and no amount of scaling or ack-deadline tuning fixes it.
    </div>
    <div class="stepper-panel">
      <strong>3. Scale or retune, based on which one is actually true.</strong> If consumers are healthy but outnumbered, scale the deployment. If they're healthy but the ack deadline is shorter than real processing time, messages are being redelivered before they're even finished — extend <code>--ack-deadline</code> instead of adding replicas.
    </div>
    <div class="stepper-panel">
      <strong>4. Add a dead-letter topic.</strong> After a bounded number of delivery attempts (<code>--max-delivery-attempts</code>), truly unprocessable messages move to a DLQ instead of endlessly recycling through the main subscription and inflating the backlog forever.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```bash
# Check subscription backlog
gcloud pubsub subscriptions describe my-subscription \
  --format="value(numUndeliveredMessages,oldestUnackedMessage)"

# Check if messages are being nacked (errors)
# High nack rate = consumer processing errors
gcloud logging read \
  'resource.type="pubsub_subscription" AND labels.subscription_id="my-subscription"' \
  --limit 20

# Scale up consumers
kubectl scale deployment my-consumer --replicas=10

# Tune subscription settings:
gcloud pubsub subscriptions modify-push-config my-subscription \
  --ack-deadline=60  # give consumers more time (default 10s)

# Dead letter topic: failed messages after N retries go here
gcloud pubsub subscriptions modify-dead-letter-policy my-subscription \
  --dead-letter-topic=my-dlq \
  --max-delivery-attempts=5

# Prevention:
# 1. Use push subscriptions → Pub/Sub pushes to Cloud Run (auto-scales)
# 2. Use BigQuery subscriptions → messages written directly to BQ table
# 3. Set appropriate ack deadline (longer than max processing time)
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="push" class="active">Push subscriptions</button>
    <button data-tab="bqsub">BigQuery subscriptions</button>
    <button data-tab="deadline">Ack deadline tuning</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="push">
      Pub/Sub pushes messages to Cloud Run itself, so consumer capacity auto-scales with the backlog instead of you having to size and manage a separate consumer deployment.
    </div>
    <div class="tab-panel" data-tab-panel="bqsub">
      Messages are written directly into a BigQuery table by the subscription — no consumer code to write, scale, or fail at all for the simple "just land it in a table" case.
    </div>
    <div class="tab-panel" data-tab-panel="deadline">
      Set the ack deadline longer than the slowest realistic processing time (default is 10s). Too short, and Pub/Sub redelivers messages that are still being legitimately processed, inflating both load and the apparent backlog.
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A consumer takes 45 seconds on average to process a message, but the subscription's ack deadline is left at the 10-second default. What symptom does this produce, and is it the same problem as "consumers can't keep up"?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Pub/Sub redelivers each message before the consumer finishes acking it, since the deadline expires mid-processing — so every message gets reprocessed at least once, inflating both load and the apparent backlog even if the consumers have plenty of real throughput. It looks identical to a scaling problem from the outside, but the fix is extending <code>--ack-deadline</code> past the real processing time, not adding more consumer replicas.</div>
</div>

---

## 7. GCS Bucket Access Denied from External

**Symptom:** `gsutil` or SDK call returns 403 from outside GCP.

```bash
# Check bucket IAM
gcloud storage buckets get-iam-policy gs://my-bucket

# Check if object is public
gsutil acl get gs://my-bucket/my-file.txt

# Grant specific access
gcloud storage buckets add-iam-policy-binding gs://my-bucket \
  --member="serviceAccount:my-app@project.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# Generate signed URL for temporary public access (no IAM needed for requester)
gsutil signurl -d 1h -m GET my-service-account-key.json gs://my-bucket/file.txt

# Check if uniform bucket-level access is enabled (disables ACLs)
gcloud storage buckets describe gs://my-bucket \
  --format="value(iamConfiguration.uniformBucketLevelAccess)"
# If true: can't use object ACLs, only bucket-level IAM
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="uniform-on" class="active state-warn">Uniform access: ON</button>
    <button data-toggle-opt="uniform-off" class="state-ok">Uniform access: OFF</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="uniform-on">
    Object-level ACLs are disabled outright — <code>gsutil acl get/set</code> against an individual object won't help you here. Access is controlled purely by bucket-level IAM; go straight to <code>gcloud storage buckets get-iam-policy</code> and grant access with <code>add-iam-policy-binding</code>.
  </div>
  <div class="toggle-panel" data-toggle-panel="uniform-off">
    Legacy object ACLs are still active alongside bucket IAM. <code>gsutil acl get</code> on the specific object can reveal a per-object grant (or an unexpected missing one) that the bucket-level policy alone won't show you.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A signed URL lets an external caller download a private GCS object successfully, even though that caller has no GCP IAM identity or credentials whatsoever. How is that access being authorized?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Authorization is proven by possession of the URL itself, not by who's asking. <code>gsutil signurl</code> embeds a time-limited, cryptographically signed credential directly into the URL (<code>-d 1h</code> sets how long it stays valid) — no IAM identity is needed on the requester's end at all, which is exactly why it works for one-off external or temporary access without granting any bucket IAM role.</div>
</div>

---

## Quick Reference: GCP Debug Commands

| Problem | First command |
|---------|--------------|
| GKE pod can't access GCP API | `kubectl exec -- curl -H "Metadata-Flavor: Google" http://169.254.169.254/...` |
| GKE node not scaling | `kubectl -n kube-system logs -l component=cluster-autoscaler` |
| BigQuery cost spike | `SELECT ... FROM INFORMATION_SCHEMA.JOBS_BY_PROJECT ORDER BY total_bytes_processed DESC` |
| Pub/Sub backlog | `gcloud pubsub subscriptions describe ... --format="value(numUndeliveredMessages)"` |
| Cloud Run cold start | `gcloud run services update --min-instances 1` |
| Permission denied | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --filter="bindings.members:USER"` |
| Spanner hotspot | GCP Console → Spanner → Key Visualizer |
