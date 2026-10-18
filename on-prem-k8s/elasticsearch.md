# Elasticsearch on Kubernetes (ECK)

Elastic Cloud on Kubernetes (ECK) is the official operator for running Elasticsearch, Kibana, and the rest of the Elastic Stack on Kubernetes. It installs custom resource definitions, manages the StatefulSets for each node set, handles TLS certificate rotation, and orchestrates rolling upgrades — all from a single `Elasticsearch` CR.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Architecture

```mermaid
graph TD
    subgraph K8S["Kubernetes Cluster"]
        ECK["ECK Operator\n(elastic-operator pod)"]
        subgraph MASTER["master-eligible StatefulSet (3 replicas)"]
            M0["es-master-0\n4Gi RAM | roles: master"]
            M1["es-master-1\n4Gi RAM | roles: master"]
            M2["es-master-2\n4Gi RAM | roles: master"]
        end
        subgraph HOT["data-hot StatefulSet (3 replicas)"]
            H0["es-hot-0\n12Gi RAM | roles: data_hot, data_content"]
            H1["es-hot-1\n12Gi RAM | roles: data_hot, data_content"]
            H2["es-hot-2\n12Gi RAM | roles: data_hot, data_content"]
        end
        subgraph WARM["data-warm StatefulSet (2 replicas)"]
            W0["es-warm-0\n8Gi RAM | roles: data_warm"]
            W1["es-warm-1\n8Gi RAM | roles: data_warm"]
        end
        INGEST["ingest StatefulSet (2 replicas)\n4Gi RAM | roles: ingest"]
        ECK --> MASTER & HOT & WARM & INGEST
        M0 --> PVM0["PVC: 50Gi SSD"]
        H0 --> PVH0["PVC: 500Gi SSD"]
        W0 --> PVW0["PVC: 2Ti HDD"]
    end
    LB["Internal LoadBalancer\n(Kibana + client access)"] --> INGEST
    INGEST --> MASTER & HOT & WARM
```

<div class="quiz-card"><p class="quiz-q">Why run dedicated master-eligible nodes instead of letting data nodes also hold the master role?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>A data node under heavy query or indexing load can stall its JVM long enough to miss heartbeats to other nodes, triggering a false master election. Dedicated master nodes (with small heaps and no data) have predictable GC pauses and stable heartbeats, preventing split-brain and spurious re-elections.</div></div>

---

## Installing ECK

```bash
# Install CRDs and operator
kubectl create -f https://download.elastic.co/downloads/eck/2.13.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/2.13.0/operator.yaml

# Verify operator is running
kubectl -n elastic-system get pods
# elastic-operator-0   1/1   Running   0   2m
```

ECK runs as a single-replica StatefulSet in the `elastic-system` namespace. It watches all namespaces by default; restrict with `--namespaces` arg in the operator manifest for multi-tenant clusters.

---

## Elasticsearch Custom Resource

A production-grade hot/warm cluster with separated node roles:

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: prod-es
  namespace: elastic
spec:
  version: 8.14.0
  nodeSets:

  # --- Master-eligible nodes (3) ---
  - name: master
    count: 3
    config:
      node.roles: ["master"]
      xpack.security.enabled: true
    podTemplate:
      spec:
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
          command: ["sh", "-c", "sysctl -w vm.max_map_count=262144"]
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 4Gi
              cpu: "2"
            limits:
              memory: 4Gi
              cpu: "2"
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms2g -Xmx2g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: premium-ssd
        resources:
          requests:
            storage: 50Gi

  # --- Hot data nodes (3) ---
  - name: data-hot
    count: 3
    config:
      node.roles: ["data_hot", "data_content"]
      xpack.security.enabled: true
    podTemplate:
      spec:
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
          command: ["sh", "-c", "sysctl -w vm.max_map_count=262144"]
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 12Gi
              cpu: "6"
            limits:
              memory: 12Gi
              cpu: "6"
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms6g -Xmx6g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: premium-ssd
        resources:
          requests:
            storage: 500Gi

  # --- Warm data nodes (2) ---
  - name: data-warm
    count: 2
    config:
      node.roles: ["data_warm"]
      xpack.security.enabled: true
    podTemplate:
      spec:
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
          command: ["sh", "-c", "sysctl -w vm.max_map_count=262144"]
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 8Gi
              cpu: "4"
            limits:
              memory: 8Gi
              cpu: "4"
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms4g -Xmx4g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: standard-hdd
        resources:
          requests:
            storage: 2000Gi
```

Key rules:
- **Heap = 50% of container memory, max 32Gi** — beyond 32Gi compressed object pointers are disabled, GC overhead increases dramatically.
- **`vm.max_map_count=262144`** must be set on the host; the init container does this via a privileged sidecar.
- `node.roles` is an explicit list in ES 8.x — no more boolean flags like `node.master: true`.

---

## Node Role Separation

| Role | Responsibility | Recommended size |
|------|---------------|-----------------|
| `master` | Cluster state, shard allocation, index creation | 3 nodes, 4Gi RAM, small PVC (50Gi) |
| `data_hot` | Active indexing + searches on recent data | 3+ nodes, 12–32Gi RAM, NVMe SSD |
| `data_warm` | Searches on older, less-frequent data | 2+ nodes, 8–16Gi RAM, HDD or standard SSD |
| `data_cold` | Infrequent access — searchable snapshots possible | 2+ nodes, 4–8Gi RAM, HDD |
| `ingest` | Ingest pipeline processing (Logstash equivalent) | 2 nodes, stateless, 4–8Gi RAM |
| `coordinating` | Query fan-out and result merge — client-facing | Optional; reduces load on data nodes at high QPS |

---

## Index Lifecycle Management on Kubernetes

ILM policies tell Elasticsearch when to move indices from hot → warm → cold → delete. Apply the policy via the ES REST API (from inside the cluster using the internal service):

```bash
# Port-forward the ES HTTP service
kubectl -n elastic port-forward svc/prod-es-es-http 9200:9200 &
PASSWORD=$(kubectl -n elastic get secret prod-es-es-elastic-user -o jsonpath='{.data.elastic}' | base64 -d)

# Create ILM policy: hot 7 days, warm 30 days, delete at 90 days
curl -s -u "elastic:$PASSWORD" -k \
  -X PUT "https://localhost:9200/_ilm/policy/logs-policy" \
  -H 'Content-Type: application/json' -d '{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": { "max_age": "7d", "max_primary_shard_size": "50gb" },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "set_priority": { "priority": 50 },
          "migrate": {}
        }
      },
      "delete": {
        "min_age": "90d",
        "actions": { "delete": {} }
      }
    }
  }
}'
```

The `migrate` action in the warm phase automatically moves shards to nodes with the `data_warm` role. No manual shard moves required.

---

## Snapshot Repository

Store snapshots in S3 or GCS by wiring cloud credentials through ECK's `secureSettings`:

```yaml
# 1. Create a K8s Secret with cloud credentials
apiVersion: v1
kind: Secret
metadata:
  name: es-snapshot-creds
  namespace: elastic
stringData:
  s3.client.default.access_key: "AKIAIOSFODNN7EXAMPLE"
  s3.client.default.secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
```

```yaml
# 2. Reference in the Elasticsearch CR
spec:
  secureSettings:
  - secretName: es-snapshot-creds
```

```bash
# 3. Register the S3 repository (after ECK rolls the nodes to load the secret)
curl -s -u "elastic:$PASSWORD" -k \
  -X PUT "https://localhost:9200/_snapshot/s3-repo" \
  -H 'Content-Type: application/json' -d '{
  "type": "s3",
  "settings": {
    "bucket": "my-es-snapshots",
    "region": "us-east-1",
    "base_path": "prod-es"
  }
}'

# 4. Create an SLM policy for automated daily snapshots
curl -s -u "elastic:$PASSWORD" -k \
  -X PUT "https://localhost:9200/_slm/policy/daily-snapshots" \
  -H 'Content-Type: application/json' -d '{
  "schedule": "0 30 1 * * ?",
  "name": "<daily-snap-{now/d}>",
  "repository": "s3-repo",
  "config": { "indices": ["*"], "include_global_state": true },
  "retention": { "expire_after": "30d", "min_count": 5, "max_count": 50 }
}'

# List all snapshots
curl -s -u "elastic:$PASSWORD" -k "https://localhost:9200/_snapshot/s3-repo/_all" | jq '.snapshots[].snapshot'
```

---

## Rolling Upgrade Procedure

ECK orchestrates rolling upgrades automatically when you change `spec.version`. No manual StatefulSet editing needed.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>Step 1. Check current health.</strong>
      <p>Verify the cluster is green before starting: <code>GET /_cluster/health?wait_for_status=green&timeout=30s</code>. A yellow or red cluster means unassigned shards — fix before upgrading.</p>
    </div>
    <div class="stepper-panel">
      <strong>Step 2. Take a snapshot.</strong>
      <p>Manually trigger a snapshot: <code>POST /_slm/policy/daily-snapshots/_execute</code>. Confirm it completes successfully: <code>GET /_snapshot/s3-repo/_all?pretty</code>.</p>
    </div>
    <div class="stepper-panel">
      <strong>Step 3. Update spec.version in the CR.</strong>
      <p><code>kubectl -n elastic patch es prod-es --type=merge -p '{"spec":{"version":"8.15.0"}}'</code>. ECK immediately begins the upgrade sequence.</p>
    </div>
    <div class="stepper-panel">
      <strong>Step 4. ECK upgrades master nodes first.</strong>
      <p>Master nodes are upgraded one at a time (ordinal descending). ECK waits for each node to rejoin and the cluster to go green before proceeding. This preserves quorum throughout.</p>
    </div>
    <div class="stepper-panel">
      <strong>Step 5. ECK upgrades data nodes.</strong>
      <p>After all masters are on the new version, data nodes are upgraded one StatefulSet at a time, one pod at a time. Shard relocation happens automatically between steps.</p>
    </div>
    <div class="stepper-panel">
      <strong>Step 6. Verify.</strong>
      <p><code>kubectl -n elastic get elasticsearch prod-es</code> — status should show <code>health: green</code> and <code>version: 8.15.0</code>. Check: <code>GET /_nodes?filter_path=nodes.*.version</code> to confirm all nodes reported the new version.</p>
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Manual override**: If you need to pause the upgrade (e.g., a bad version), annotate the ES resource:
```bash
kubectl -n elastic annotate es prod-es eck.k8s.elastic.co/managed=false
# Make manual changes, then remove the annotation to hand control back to ECK
kubectl -n elastic annotate es prod-es eck.k8s.elastic.co/managed-
```

---

## PodDisruptionBudget

ECK automatically creates a PDB for each node set:

```yaml
# What ECK creates automatically — you don't write this:
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: prod-es-es-master-pdb
  namespace: elastic
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      elasticsearch.k8s.elastic.co/cluster-name: prod-es
      elasticsearch.k8s.elastic.co/node-set: master
```

`maxUnavailable: 1` means a node drain can only evict one master pod at a time. With 3 master nodes, 2 are always available — quorum is maintained. Without this PDB, a `kubectl drain` of two nodes simultaneously would destroy quorum and the cluster would stop accepting writes.

---

## Monitoring

Deploy the Prometheus elasticsearch-exporter as a sidecar or separate Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: es-exporter
  namespace: elastic
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: exporter
        image: prometheuscommunity/elasticsearch-exporter:v1.7.0
        args:
        - "--es.uri=https://prod-es-es-http:9200"
        - "--es.ssl-skip-verify"
        - "--es.all"
        env:
        - name: ES_USERNAME
          value: elastic
        - name: ES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: prod-es-es-elastic-user
              key: elastic
        ports:
        - containerPort: 9114
```

**Key metrics to alert on:**

| Metric | Alert threshold | Why |
|--------|----------------|-----|
| `elasticsearch_cluster_health_status` | `!= 0` (green=0, yellow=1, red=2) | Red = data loss risk |
| `elasticsearch_jvm_memory_used_bytes / elasticsearch_jvm_memory_max_bytes` | `> 0.85` | GC pressure; at 100% → OOM kill |
| `elasticsearch_cluster_health_unassigned_shards` | `> 0` for 5+ min | Indicates node failure or disk watermark hit |
| `elasticsearch_indices_search_query_time_seconds` | p99 > 2s | Slow queries — check for hot shards or under-provisioning |
| `elasticsearch_filesystem_data_available_bytes` | `< 15%` | Disk watermark: at 85% ES stops indexing to that node |

---

## Troubleshooting

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="unassigned" class="active">Unassigned Shards</button>
    <button data-tab="oom">JVM OOM / Heap</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="unassigned">
      <p><strong>Symptom:</strong> <code>elasticsearch_cluster_health_unassigned_shards &gt; 0</code>, cluster goes yellow or red.</p>
      <p><strong>Step 1 — Explain why:</strong></p>
      <pre><code>GET /_cluster/allocation/explain
{
  "index": "logs-2024.01.15",
  "shard": 0,
  "primary": false
}</code></pre>
      <p>Common reasons: <code>disk watermark exceeded</code> (node at 85%+ disk → free space or add nodes), <code>no_valid_shard_copy</code> (all copies on dead nodes → restore from snapshot), <code>node_left</code> (node exited, waiting for it to rejoin).</p>
      <p><strong>Step 2 — Disk watermark fix:</strong> Temporarily raise the threshold while adding storage:
      <code>PUT /_cluster/settings { "transient": { "cluster.routing.allocation.disk.watermark.high": "95%" } }</code></p>
      <p><strong>Step 3 — Force reroute:</strong> <code>POST /_cluster/reroute?retry_failed=true</code></p>
    </div>
    <div class="tab-panel" data-tab-panel="oom">
      <p><strong>Symptom:</strong> Node pod OOMKilled, or GC overhead alert, or "Data too large" exception in logs.</p>
      <p><strong>Heap sizing rules:</strong></p>
      <ul>
        <li>Set <code>Xms == Xmx</code> (no heap growth surprises)</li>
        <li>Max heap = 50% of container memory limit, hard max 32Gi (compressed oops boundary)</li>
        <li>If the container is 12Gi → heap = 6Gi: <code>ES_JAVA_OPTS: "-Xms6g -Xmx6g"</code></li>
      </ul>
      <p><strong>Diagnose:</strong></p>
      <pre><code>GET /_nodes/stats/jvm
# Check: jvm.mem.heap_used_percent > 85 is dangerous
# Check: jvm.gc.collectors.old.collection_time_in_millis growing fast → full GC</code></pre>
      <p><strong>Quick relief:</strong> Clear the fielddata cache if fielddata is the culprit:
      <code>POST /_cache/clear?fielddata=true</code></p>
      <p><strong>Root fix:</strong> Either reduce heap usage (avoid high-cardinality aggregations on text fields, use <code>keyword</code> + doc_values instead) or increase node memory in the ECK CR and let ECK rolling-restart the nodes.</p>
    </div>
  </div>
</div>

<div class="quiz-card"><p class="quiz-q">You want to upgrade from ES 8.13 to 8.15 (skipping 8.14). Is that safe with ECK?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>No. Elasticsearch's version skew policy requires upgrading one minor version at a time — 8.13 → 8.14 → 8.15. ECK will perform the upgrade, but skipping a version risks incompatible index format changes. Always go step-by-step and take a snapshot before each upgrade.</div></div>

<div class="quiz-card"><p class="quiz-q">Your disk usage on hot nodes reaches 85%. What does Elasticsearch do automatically, and what must you do to fix it?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>ES stops allocating new shards to that node (the high watermark is 85% by default). Existing shards remain readable but no new shards land there. To fix: free disk space (delete old indices or force-merge + ILM), add more hot nodes, or temporarily raise the watermark threshold. Raising the threshold buys time — add capacity to resolve it.</div></div>
