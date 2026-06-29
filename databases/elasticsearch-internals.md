# Elasticsearch Internals

Distributed search and analytics engine built on Apache Lucene. Horizontally scalable, schema-flexible, and optimized for full-text search and near-real-time analytics.

---

## 1. What Elasticsearch Is

- **Search engine**: inverted index for full-text search with relevance scoring
- **Analytics engine**: aggregations over large datasets (like SQL GROUP BY but distributed)
- **Document store**: JSON documents, schemaless or schema-controlled via mappings
- **Built on Lucene**: each shard is a Lucene index; ES adds distribution, replication, and a REST API

Not a primary database — no ACID transactions, no joins across indexes. Use it for search, log analytics (ELK stack), and metrics aggregation.

---

## 2. Core Architecture

| Concept | Description |
|---------|-------------|
| **Cluster** | One or more nodes sharing the same `cluster.name` |
| **Node** | Single running ES instance |
| **Index** | Logical namespace for documents (like a database table) |
| **Shard** | Physical unit — a single Lucene index. Index is split into N primary shards |
| **Replica** | Copy of a primary shard for HA and read scaling |

### Node Types

| Role | Responsibility |
|------|---------------|
| **Master** | Manages cluster state: node join/leave, index create/delete, shard allocation |
| **Data** | Stores shards, executes queries and indexing |
| **Ingest** | Pre-processes documents (pipelines) before indexing |
| **Coordinating** | Routes requests, merges results — every node is coordinating by default |
| **ML** | Runs machine learning jobs (X-Pack) |

A node can have multiple roles. In production, dedicate master and data nodes.

---

## 3. Cluster Topology Diagram

```mermaid
graph TD
    Client -->|REST API| Coord[Coordinating Node]
    Coord --> DN1[Data Node 1]
    Coord --> DN2[Data Node 2]
    Coord --> DN3[Data Node 3]

    MN1[Master Node 1 active] --- MN2[Master Node 2 standby]
    MN1 --- MN3[Master Node 3 standby]

    DN1 --> P0[Primary Shard 0]
    DN1 --> R1[Replica Shard 1]
    DN2 --> P1[Primary Shard 1]
    DN2 --> R2[Replica Shard 2]
    DN3 --> P2[Primary Shard 2]
    DN3 --> R0[Replica Shard 0]

    Ingest[Ingest Node] -->|pipeline| DN1
```

---

## 4. Inverted Index

Traditional databases index rows → fields. Lucene inverts this: **term → list of document IDs**.

### Tokenization Example

Input text: `"The quick brown fox"`

**Analysis pipeline:**
1. **Char filter** — strip HTML, map chars (e.g., `&` → `and`)
2. **Tokenizer** — split on whitespace: `[The, quick, brown, fox]`
3. **Token filters** — lowercase, stop words, stemming: `[quick, brown, fox]` (`the` removed as stop word)

**Resulting inverted index:**

| Term | Doc IDs | Positions |
|------|---------|-----------|
| `quick` | [1, 3] | [1, 2] |
| `brown` | [1] | [2] |
| `fox` | [1, 4] | [3] |

When you search for `"quick fox"`:
1. Tokenize query → `[quick, fox]`
2. Look up each term in inverted index
3. Intersect doc ID lists → `[1, 4]` for `quick` ∩ `[1]` for `fox` = `[1]`
4. Score by TF-IDF or BM25

The `keyword` field type skips analysis — stored as-is for exact matching, sorting, and aggregations.

---

## 5. Index Segments

A Lucene index (shard) is composed of **immutable segments**.

### How segments work

- **Write**: documents first go to an in-memory buffer + translog
- **Refresh** (default every 1s): memory buffer flushes to a new on-disk segment → document becomes searchable
- **Flush** (triggered by translog size or time): fsync segments + translog to disk, clear translog
- **Merge**: background merging combines small segments into larger ones, physically deletes documents marked in the delete bitmap

### Why writes are near-real-time, not real-time

The refresh operation (buffer → segment) happens every second by default. Documents are not searchable until the next refresh. For immediate visibility, use `refresh=true` on the index request (expensive — avoid in bulk).

### Deleted documents

ES marks deletes in a **bitmap** (`.del` file). The document still occupies disk until a merge physically removes it. `_forcemerge` compacts this.

### Segment merge

```
Segment 1 (100 docs)  ─┐
Segment 2 (80 docs)   ─┼─► Merged Segment (170 docs, deletes purged)
Segment 3 (40 docs)   ─┘
```

Merges are CPU/IO intensive. During bulk indexing, set `refresh_interval: -1` and `number_of_replicas: 0`, then restore after.

---

## 6. Write Path Sequence Diagram

```mermaid
sequenceDiagram
    participant C as Client
    participant CN as Coordinating Node
    participant PN as Primary Node
    participant RN as Replica Node

    C->>CN: PUT /index/_doc/1
    CN->>CN: Route via hash(doc_id) % num_shards
    CN->>PN: Forward to primary shard owner
    PN->>PN: Write to translog
    PN->>PN: Write to in-memory buffer
    PN->>RN: Replicate to replica shard
    RN-->>PN: ACK
    PN-->>CN: ACK success
    CN-->>C: 201 Created

    Note over PN: Every refresh_interval (1s default)
    PN->>PN: Flush buffer to new Lucene segment
    Note over PN: Document now searchable

    Note over PN: On flush trigger
    PN->>PN: fsync segments + translog
    PN->>PN: Clear translog
```

---

## 7. Sharding

### Shard routing

```
shard_id = hash(document_id) % number_of_primary_shards
```

This is why **primary shard count is fixed at index creation** — changing it would invalidate the routing formula for all existing documents. To resize, use `_reindex` into a new index with different shard count, or use `_split`/`_shrink` API.

### Primary vs Replica

- **Primary**: handles all writes, replicates to replicas
- **Replica**: serves read requests, promoted to primary if primary fails
- Replicas are never on the same node as their primary (cluster moves them automatically)

### Shard sizing rule

- Target **20–50 GB per shard**
- Too small: overhead from too many small Lucene indexes
- Too large: slow recovery, rebalancing is expensive
- Rule of thumb: `num_shards = total_data_size / 30GB`

---

## 8. Replication

### Write flow (sync)

1. Client writes to primary shard
2. Primary validates and writes locally
3. Primary forwards to all in-sync replica shards in parallel
4. Waits for all replicas to ACK (controlled by `wait_for_active_shards`)
5. Returns success to client

### In-Sync Replicas (ISR)

ES tracks which replicas are "in sync" with the primary. Lagging replicas are removed from ISR. Primary only waits for ISR replicas.

### Primary failure

1. Master detects primary is down
2. Promotes an in-sync replica to new primary
3. Assigns a new replica on another node
4. Old primary (if it recovers) is fenced — must re-sync before serving writes

---

## 9. Cluster States

| State | Meaning |
|-------|---------|
| 🟢 **Green** | All primary AND replica shards assigned and active |
| 🟡 **Yellow** | All primary shards active, but ≥1 replica unassigned |
| 🔴 **Red** | ≥1 primary shard unassigned — some data unavailable |

### What triggers each

**Yellow** (most common in single-node clusters):
- Only 1 node — no place to put replicas
- Node left the cluster and its replicas are unassigned
- Fix: add nodes, or set `number_of_replicas: 0` for dev

**Red**:
- Node with primary shard(s) is down and no in-sync replica exists
- Corrupt shard data
- Fix: restore from snapshot, or use `_cluster/reroute` to allocate stale replica

```bash
# Check cluster health
GET /_cluster/health

# See unassigned shards
GET /_cat/shards?v&h=index,shard,prirep,state,node,unassigned.reason

# Explain why a shard is unassigned
GET /_cluster/allocation/explain
```

---

## 10. Mappings

### Dynamic vs Explicit

**Dynamic mapping**: ES auto-detects types on first document. Risky — a string `"123"` maps to `long`, next doc with `"abc"` fails.

**Explicit mapping**: Define upfront, prevents surprises in production.

```json
PUT /products
{
  "mappings": {
    "properties": {
      "name":        { "type": "text", "analyzer": "english" },
      "sku":         { "type": "keyword" },
      "price":       { "type": "float" },
      "created_at":  { "type": "date", "format": "strict_date_optional_time" },
      "tags":        { "type": "keyword" },
      "location":    { "type": "geo_point" },
      "embedding":   { "type": "dense_vector", "dims": 768 },
      "attributes":  { "type": "object" },
      "variants": {
        "type": "nested",
        "properties": {
          "color": { "type": "keyword" },
          "stock": { "type": "integer" }
        }
      }
    }
  }
}
```

### Key field types

| Type | Use case |
|------|----------|
| `text` | Full-text search (analyzed, not aggregatable) |
| `keyword` | Exact match, sort, aggregations (not analyzed) |
| `date` | Date/datetime, supports math (`now-1d`) |
| `object` | Nested JSON object (flattened internally) |
| `nested` | Array of objects where each object is independently queryable |
| `geo_point` | Lat/lon for geo distance queries |
| `dense_vector` | ML embeddings for k-NN/ANN search |

### object vs nested

`object` fields are flattened — cross-field correlation is lost:
```
variants.color: [red, blue]
variants.stock: [10, 0]
```
ES cannot tell that `red → 10` and `blue → 0` are pairs. Use `nested` when you need to query object arrays as independent documents.

### Analyzer chain

```
"The quick brown fox!" 
  → char_filter: strip punctuation → "The quick brown fox"
  → tokenizer: standard         → ["The", "quick", "brown", "fox"]
  → token_filter: lowercase     → ["the", "quick", "brown", "fox"]
  → token_filter: stop          → ["quick", "brown", "fox"]
  → token_filter: stemmer       → ["quick", "brown", "fox"]
```

---

## 11. Analysis

### Standard analyzer (default)

Tokenizes on whitespace/punctuation, lowercases, removes some punctuation. No stemming.

### Custom analyzer

```json
PUT /my_index
{
  "settings": {
    "analysis": {
      "char_filter": {
        "html_strip": { "type": "html_strip" }
      },
      "tokenizer": {
        "my_tokenizer": { "type": "standard" }
      },
      "filter": {
        "my_stemmer": { "type": "stemmer", "language": "english" },
        "my_stop":    { "type": "stop", "stopwords": "_english_" }
      },
      "analyzer": {
        "my_analyzer": {
          "type":        "custom",
          "char_filter": ["html_strip"],
          "tokenizer":   "my_tokenizer",
          "filter":      ["lowercase", "my_stop", "my_stemmer"]
        }
      }
    }
  }
}
```

### _analyze API — debug tokenization

```json
GET /my_index/_analyze
{
  "analyzer": "my_analyzer",
  "text": "The <b>Quick</b> Brown Foxes!"
}
```

Response shows each token, its position, and offset — essential for debugging why a search isn't matching.

---

## 12. Query DSL

### match — full-text search

```json
GET /products/_search
{
  "query": {
    "match": {
      "name": { "query": "quick brown", "operator": "and" }
    }
  }
}
```

### term — exact match (keyword fields)

```json
{ "term": { "sku": "ABC-123" } }
```

### range

```json
{ "range": { "price": { "gte": 10, "lte": 100 } } }
{ "range": { "created_at": { "gte": "now-7d/d", "lt": "now/d" } } }
```

### bool — combining queries

```json
{
  "query": {
    "bool": {
      "must":     [{ "match": { "name": "laptop" } }],
      "filter":   [{ "term": { "in_stock": true } }, { "range": { "price": { "lte": 2000 } } }],
      "should":   [{ "term": { "brand": "apple" } }],
      "must_not": [{ "term": { "discontinued": true } }],
      "minimum_should_match": 0
    }
  }
}
```

`filter` clauses do not affect relevance score and are cached — always use `filter` for exact/range matches.

### nested

```json
{
  "query": {
    "nested": {
      "path": "variants",
      "query": {
        "bool": {
          "must": [
            { "term": { "variants.color": "red" } },
            { "range": { "variants.stock": { "gt": 0 } } }
          ]
        }
      }
    }
  }
}
```

### function_score — custom relevance

```json
{
  "query": {
    "function_score": {
      "query": { "match": { "name": "laptop" } },
      "functions": [
        { "field_value_factor": { "field": "rating", "factor": 1.2, "modifier": "sqrt" } },
        { "gauss": { "created_at": { "origin": "now", "scale": "30d", "decay": 0.5 } } }
      ],
      "score_mode": "multiply",
      "boost_mode": "multiply"
    }
  }
}
```

### script_score — arbitrary scoring

```json
{
  "query": {
    "script_score": {
      "query": { "match_all": {} },
      "script": { "source": "cosineSimilarity(params.query_vector, 'embedding') + 1.0",
                  "params": { "query_vector": [0.1, 0.2, ...] } }
    }
  }
}
```

---

## 13. Aggregations

Aggregations run alongside queries. Always use `filter` context queries to limit the agg dataset.

### terms — group by field

```json
{
  "aggs": {
    "by_brand": {
      "terms": { "field": "brand", "size": 10 },
      "aggs": {
        "avg_price": { "avg": { "field": "price" } }
      }
    }
  }
}
```

### date_histogram — time series

```json
{
  "aggs": {
    "sales_over_time": {
      "date_histogram": { "field": "created_at", "calendar_interval": "1d" },
      "aggs": {
        "revenue": { "sum": { "field": "price" } }
      }
    }
  }
}
```

### cardinality — unique count (HyperLogLog)

```json
{ "aggs": { "unique_users": { "cardinality": { "field": "user_id", "precision_threshold": 1000 } } } }
```

Approximate — error ~0.5% at default precision. Exact cardinality requires loading all values into memory.

### percentiles — latency distribution

```json
{ "aggs": { "latency_pcts": { "percentiles": { "field": "response_ms", "percents": [50, 95, 99] } } } }
```

### pipeline aggregations

```json
{
  "aggs": {
    "daily_revenue": {
      "date_histogram": { "field": "date", "calendar_interval": "1d" },
      "aggs": { "revenue": { "sum": { "field": "price" } } }
    },
    "revenue_moving_avg": {
      "moving_avg": { "buckets_path": "daily_revenue>revenue", "window": 7 }
    },
    "revenue_derivative": {
      "derivative": { "buckets_path": "daily_revenue>revenue" }
    }
  }
}
```

---

## 14. Performance Tuning

### Bulk indexing

Never index one doc at a time. Use `_bulk` API.

```bash
POST /_bulk
{ "index": { "_index": "products", "_id": "1" } }
{ "name": "Laptop", "price": 999 }
{ "index": { "_index": "products", "_id": "2" } }
{ "name": "Phone", "price": 699 }
```

Optimal bulk size: **5–15 MB per request**, not by doc count. Test and tune.

### Bulk indexing settings

```json
PUT /products/_settings
{
  "index": {
    "refresh_interval": "-1",
    "number_of_replicas": "0"
  }
}
```

After bulk load, restore:

```json
PUT /products/_settings
{
  "index": {
    "refresh_interval": "1s",
    "number_of_replicas": "1"
  }
}
POST /products/_forcemerge?max_num_segments=1
```

### doc_values vs fielddata

| | doc_values | fielddata |
|--|------------|-----------|
| **Type** | `keyword`, `numeric`, `date` | `text` |
| **Storage** | On disk (columnar) | In heap memory |
| **Default** | Enabled | Disabled |
| **Use** | Sort, agg, script | Agg on analyzed text (avoid) |

Never enable `fielddata: true` on text fields in production — causes heap pressure. Instead, use a `keyword` sub-field for aggregations:

```json
"name": {
  "type": "text",
  "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } }
}
```

### Index sorting

Pre-sort segments for common sort patterns, speeds up queries and early termination:

```json
PUT /logs
{
  "settings": {
    "index.sort.field": ["@timestamp"],
    "index.sort.order": ["desc"]
  }
}
```

### Heap sizing

- Set `Xms` = `Xmx` (avoid heap resizing)
- Max **31 GB** — above this, JVM can't use compressed ordinary object pointers (COOPs), memory usage jumps
- Use **50% of RAM** for ES heap, leave the rest for OS page cache (Lucene uses it heavily)

```bash
# elasticsearch.yml / jvm.options
-Xms16g
-Xmx16g
```

### Shard sizing

- Target 20–50 GB per shard
- Too many small shards: overhead per shard (metadata, threads, memory)
- Rule: `ceil(total_data_GB / 30) = num_primary_shards`
- For time-series data: use ILM with rollover to keep shard sizes bounded

---

## 15. Common Issues

| Issue | Symptoms | Root Cause | Fix |
|-------|----------|------------|-----|
| **Yellow cluster** | `status: yellow` | Replicas unassigned | Add nodes or reduce `number_of_replicas` |
| **Split brain (pre-7.x)** | Two master nodes | `minimum_master_nodes` misconfigured | ES 7+ uses Raft-based consensus, no config needed |
| **High heap usage** | GC pressure, slow queries | fielddata enabled, too many shards, large aggs | Disable fielddata, reduce shards, tune circuit breakers |
| **Slow queries** | High latency on search | Missing filters in bool, using `query` instead of `filter` | Add `filter` for non-scoring clauses; use `_profile` API |
| **Mapping explosion** | Dynamic mapping on high-cardinality keys | Indexing JSON with unknown keys (e.g., user attributes) | Use `dynamic: strict`, explicit mappings, or `flattened` type |
| **Unassigned shards** | Red/yellow cluster | Node left, disk full, shard allocation settings | Check `_cluster/allocation/explain`, free disk, adjust watermarks |
| **Hot shards** | One shard at 100% CPU | All docs routing to same shard | Use custom routing, or check if `_id` is monotonically increasing |

```bash
# Profile slow queries
GET /products/_search
{
  "profile": true,
  "query": { "match": { "name": "laptop" } }
}

# Check circuit breakers
GET /_nodes/stats/breaker

# Check disk watermarks
GET /_cluster/settings
```

---

## 16. Index Lifecycle Management (ILM)

ILM automates moving indices through hot/warm/cold/delete phases based on age or size.

```mermaid
graph LR
    Hot[Hot Phase active writes + searches] -->|rollover at 50GB or 30d| Warm[Warm Phase read-only reduced replicas]
    Warm -->|after 60d| Cold[Cold Phase mounted from snapshot searchable]
    Cold -->|after 180d| Delete[Delete Phase index removed]
```

### ILM Policy

```json
PUT /_ilm/policy/logs_policy
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": { "max_size": "50gb", "max_age": "30d" },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "30d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "allocate": { "number_of_replicas": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "60d",
        "actions": {
          "searchable_snapshot": { "snapshot_repository": "my_s3_repo" },
          "set_priority": { "priority": 0 }
        }
      },
      "delete": {
        "min_age": "180d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

### Index template with ILM

```json
PUT /_index_template/logs_template
{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 2,
      "number_of_replicas": 1,
      "index.lifecycle.name": "logs_policy",
      "index.lifecycle.rollover_alias": "logs"
    }
  }
}
```

### Bootstrap the first index

```json
PUT /logs-000001
{
  "aliases": {
    "logs": { "is_write_index": true }
  }
}
```

Write to the `logs` alias — ILM rolls over automatically creating `logs-000002`, `logs-000003`, etc.

### Check ILM status

```bash
GET /logs-*/_ilm/explain
GET /_ilm/status
```

---

## Quick Reference

```bash
# Cluster health
GET /_cluster/health?level=shards

# Node stats
GET /_nodes/stats?metric=jvm,indices,os

# Index stats
GET /products/_stats

# Pending tasks
GET /_cluster/pending_tasks

# Hot threads
GET /_nodes/hot_threads

# Flush all
POST /_flush

# Force merge (run off-peak)
POST /products/_forcemerge?max_num_segments=1
```

---

## 17. Relevance Scoring — BM25

ES uses **BM25** (Best Match 25) by default since ES 5.0. Understanding it explains why results rank the way they do.

### BM25 Formula

```
score(q, d) = Σ IDF(qi) * TF(qi, d)

IDF(t) = log(1 + (N - df + 0.5) / (df + 0.5))
         N  = total documents in index
         df = documents containing term t
         High IDF = rare term = more discriminating

TF(t, d) = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * |d| / avgdl))
           freq  = term frequency in document
           k1    = term frequency saturation (default 1.2) — diminishing returns on repetition
           b     = field length normalization (default 0.75) — shorter docs rank higher
           |d|   = document field length
           avgdl = average field length across index
```

**Key intuition:**
- `IDF`: "laptop" in 100/1M docs scores higher than "the" in 900K/1M docs
- `TF saturation`: mentioning "laptop" 10x vs 5x barely matters (k1 controls this)
- `b=0.75`: a short product title matching "laptop" ranks higher than a long description matching "laptop"

### Tuning scoring

```json
PUT /products/_mapping
{
  "properties": {
    "name":        { "type": "text", "similarity": "BM25", "boost": 3 },
    "description": { "type": "text", "similarity": "BM25", "boost": 1 }
  }
}
```

### Explain scoring

```bash
GET /products/_explain/1
{ "query": { "match": { "name": "laptop" } } }
```

---

## 18. Pagination Strategies

### from/size (avoid for deep pagination)

```json
GET /_search
{ "from": 10000, "size": 10, "query": { "match_all": {} } }
```

ES must fetch `from + size` docs from every shard, sort them on the coordinating node, then discard the first `from`. At `from=10000`, ES processes 10010 docs × N shards. Max default is 10,000 (`index.max_result_window`).

### search_after (recommended for deep pagination)

Uses the sort values of the last result as a cursor. No skip overhead.

```json
GET /_search
{
  "size": 20,
  "query": { "match": { "category": "electronics" } },
  "sort": [{ "price": "asc" }, { "_id": "asc" }],   // must include a tiebreaker
  "search_after": [999.99, "doc_id_xyz"]              // from last page's last hit
}
```

### Point In Time (PIT) — consistent pagination

Results can change between pages if new docs are indexed. PIT freezes a view:

```bash
# Open PIT
POST /products/_pit?keep_alive=5m

# Use PIT with search_after
GET /_search
{
  "pit": { "id": "<pit_id>", "keep_alive": "5m" },
  "sort": [{ "price": "asc" }, { "_id": "asc" }],
  "search_after": [999.99, "doc_id_xyz"]
}

# Close PIT when done
DELETE /_pit
{ "id": "<pit_id>" }
```

### scroll (deprecated — use search_after + PIT instead)

Old approach for bulk export. Keeps a search context open server-side. Expensive at scale. Still useful for one-time full data exports:

```json
POST /products/_search?scroll=2m
{ "size": 1000, "query": { "match_all": {} } }

POST /_search/scroll
{ "scroll": "2m", "scroll_id": "<id>" }
```

---

## 19. Ingest Pipelines

Pre-process documents before they're indexed. Runs on ingest nodes.

```json
PUT /_ingest/pipeline/access_log_pipeline
{
  "description": "Parse nginx access logs",
  "processors": [
    {
      "grok": {
        "field": "message",
        "patterns": ["%{IPORHOST:client_ip} .* \\[%{HTTPDATE:timestamp}\\] \"%{WORD:method} %{URIPATHPARAM:path}\" %{NUMBER:status_code:int} %{NUMBER:bytes:long}"]
      }
    },
    { "date": { "field": "timestamp", "formats": ["dd/MMM/yyyy:HH:mm:ss Z"] } },
    { "geoip": { "field": "client_ip" } },
    { "user_agent": { "field": "user_agent" } },
    { "remove": { "field": "message" } },
    { "set": { "field": "environment", "value": "production" } }
  ],
  "on_failure": [
    { "set": { "field": "_index", "value": "failed-{{ _index }}" } }
  ]
}
```

```bash
# Test pipeline without indexing
POST /_ingest/pipeline/access_log_pipeline/_simulate
{
  "docs": [{ "_source": { "message": "192.168.1.1 - - [01/Jan/2026:12:00:00 +0000] \"GET /api/health HTTP/1.1\" 200 42" } }]
}

# Use pipeline on index
POST /logs/_doc?pipeline=access_log_pipeline
{ "message": "..." }

# Set default pipeline on index
PUT /logs/_settings
{ "index.default_pipeline": "access_log_pipeline" }
```

Common processors: `grok`, `date`, `geoip`, `user_agent`, `set`, `remove`, `rename`, `convert`, `split`, `join`, `gsub` (regex replace), `foreach`, `enrich` (lookup from another index), `fingerprint` (dedup hash).

---

## 20. k-NN / Vector Search

Used for semantic search, recommendation, image similarity. Requires `dense_vector` field.

```json
PUT /articles
{
  "mappings": {
    "properties": {
      "title":     { "type": "text" },
      "embedding": {
        "type":       "dense_vector",
        "dims":       768,
        "index":      true,
        "similarity": "cosine"     // cosine | dot_product | l2_norm
      }
    }
  }
}
```

### Exact k-NN (brute force — small datasets)

```json
GET /articles/_search
{
  "knn": {
    "field":         "embedding",
    "query_vector":  [0.1, 0.2, ...],   // 768 dims
    "k":             10,
    "num_candidates": 100
  }
}
```

### Approximate nearest neighbor (ANN) — uses HNSW index

ES uses **HNSW** (Hierarchical Navigable Small World) graphs for ANN. Orders of magnitude faster than brute force at scale.

```json
PUT /articles
{
  "mappings": {
    "properties": {
      "embedding": {
        "type":       "dense_vector",
        "dims":       768,
        "index":      true,
        "similarity": "cosine",
        "index_options": {
          "type":          "hnsw",
          "m":             16,      // connections per node, higher = better recall, more memory
          "ef_construction": 100    // size of candidate list during indexing
        }
      }
    }
  }
}
```

### Hybrid search — combine BM25 + vector

```json
GET /articles/_search
{
  "query": {
    "bool": {
      "should": [
        { "match": { "title": "machine learning" } }
      ]
    }
  },
  "knn": {
    "field":         "embedding",
    "query_vector":  [...],
    "k":             10,
    "num_candidates": 100,
    "boost":         0.5
  }
}
```

---

## 21. Runtime Fields

Compute fields at query time without reindexing. Useful for prototyping mappings or one-off calculations.

```json
GET /logs/_search
{
  "runtime_mappings": {
    "response_time_seconds": {
      "type": "double",
      "script": {
        "source": "emit(doc['response_ms'].value / 1000.0)"
      }
    }
  },
  "query": {
    "range": { "response_time_seconds": { "gt": 1.0 } }
  },
  "fields": ["response_time_seconds"]
}
```

Persistent runtime field (added to mapping, no reindex):

```json
PUT /logs/_mapping
{
  "runtime": {
    "day_of_week": {
      "type": "keyword",
      "script": { "source": "emit(doc['@timestamp'].value.dayOfWeekEnum.getDisplayName(TextStyle.FULL, Locale.ROOT))" }
    }
  }
}
```

---

## 22. Cross-Cluster Search (CCS) & Cross-Cluster Replication (CCR)

### Cross-Cluster Search — query across multiple clusters

```json
// Configure remote cluster
PUT /_cluster/settings
{
  "persistent": {
    "cluster.remote.eu_cluster.seeds": ["eu-es-node1:9300"],
    "cluster.remote.us_cluster.seeds": ["us-es-node1:9300"]
  }
}

// Query across clusters
GET /eu_cluster:logs-*,us_cluster:logs-*,logs-*/_search
{
  "query": { "range": { "@timestamp": { "gte": "now-1h" } } }
}
```

### Cross-Cluster Replication — replicate index to another cluster

Used for disaster recovery, geo-distribution, and keeping a read replica in another region.

```json
PUT /follower-logs/_ccr/follow
{
  "remote_cluster":  "eu_cluster",
  "leader_index":    "logs-000001",
  "settings": {
    "number_of_replicas": 1
  }
}
```

Follower index is read-only. Replicates ops from leader in near-real-time. To promote follower to leader (DR failover):

```bash
POST /follower-logs/_ccr/pause_follow
POST /follower-logs/_close
POST /follower-logs/_ccr/unfollow
# follower is now a normal writable index
```

---

## 23. Snapshot & Restore

### Register a repository (S3)

```json
PUT /_snapshot/my_s3_repo
{
  "type": "s3",
  "settings": {
    "bucket":   "my-es-snapshots",
    "region":   "us-east-1",
    "base_path": "elasticsearch/backups"
  }
}
```

### Take snapshot

```json
PUT /_snapshot/my_s3_repo/snapshot_2026_01_01
{
  "indices":            "products,users",
  "include_global_state": false,
  "metadata": { "taken_by": "ops-team", "reason": "pre-migration" }
}

// Check status
GET /_snapshot/my_s3_repo/snapshot_2026_01_01
```

### Restore

```json
POST /_snapshot/my_s3_repo/snapshot_2026_01_01/_restore
{
  "indices": "products",
  "rename_pattern":     "(.+)",
  "rename_replacement": "restored_$1"     // restore as "restored_products"
}
```

### Automated snapshots with SLM (Snapshot Lifecycle Management)

```json
PUT /_slm/policy/daily_snapshots
{
  "schedule":   "0 0 2 * * ?",            // daily at 02:00
  "name":       "<daily-snap-{now/d}>",
  "repository": "my_s3_repo",
  "config": {
    "indices":              ["*"],
    "include_global_state": true
  },
  "retention": {
    "expire_after":   "30d",
    "min_count":      5,
    "max_count":      30
  }
}

// Execute immediately
POST /_slm/policy/daily_snapshots/_execute
```

---

## 24. Security

### TLS + Authentication

```yaml
# elasticsearch.yml
xpack.security.enabled: true
xpack.security.transport.ssl.enabled: true
xpack.security.transport.ssl.keystore.path: elastic-certificates.p12
xpack.security.http.ssl.enabled: true
xpack.security.http.ssl.keystore.path: http.p12
```

```bash
# Generate certs
./bin/elasticsearch-certutil ca
./bin/elasticsearch-certutil cert --ca elastic-stack-ca.p12

# Set built-in user passwords
./bin/elasticsearch-setup-passwords interactive
```

### RBAC — Role-based access control

```json
PUT /_security/role/logs_reader
{
  "indices": [{
    "names":      ["logs-*"],
    "privileges": ["read", "view_index_metadata"]
  }]
}

PUT /_security/user/bob
{
  "password": "changeme",
  "roles":    ["logs_reader"],
  "full_name": "Bob Smith"
}
```

### Field-level and document-level security

```json
PUT /_security/role/restricted_reader
{
  "indices": [{
    "names":      ["orders"],
    "privileges": ["read"],
    "field_security": {
      "grant": ["order_id", "status", "created_at"]   // only these fields visible
    },
    "query": "{ \"term\": { \"region\": \"EU\" } }"   // only EU docs visible
  }]
}
```

---

## 25. Transforms & Rollups

### Transforms — materialize aggregations into a new index

```json
PUT /_transform/daily_sales_summary
{
  "source": { "index": "orders" },
  "dest":   { "index": "orders_daily" },
  "pivot": {
    "group_by": {
      "date":     { "date_histogram": { "field": "created_at", "calendar_interval": "1d" } },
      "category": { "terms": { "field": "category" } }
    },
    "aggregations": {
      "total_revenue": { "sum": { "field": "price" } },
      "order_count":   { "value_count": { "field": "_id" } }
    }
  },
  "sync": {
    "time": { "field": "created_at", "delay": "60s" }   // continuous transform
  }
}

POST /_transform/daily_sales_summary/_start
```

Transforms replace rollups (deprecated). Use them for pre-aggregated dashboards, summary indexes, and reducing query load on high-cardinality indexes.
