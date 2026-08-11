# Caching — Deep Dive Reference

From fundamentals to production patterns.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Why Cache

| Access Type | Latency | Notes |
|-------------|---------|-------|
| L1 CPU cache | ~1 ns | Per core |
| L2/L3 CPU cache | 4–40 ns | Shared across cores |
| RAM | ~100 ns | Main memory |
| Redis (local) | ~0.1–1 ms | In-process network |
| SSD disk | ~100 µs | NVMe |
| HDD disk | ~5–10 ms | Rotational |
| DB query (cold) | 5–50 ms | Index + disk I/O |
| Cross-region network | 50–200 ms | Geographic distance |

**Read amplification**: a single app query can fan out to dozens of DB reads. A cache short-circuits this.

**Cost reduction**: DB CPU is expensive; Redis/Memcached nodes are cheap per RPS served.

<div class="quiz-card">
  <p class="quiz-q">A DB query (cold) takes 5–50ms and Redis takes ~0.1–1ms. Why is the DB so much slower even though both are ultimately reading from fast storage?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>A "cold" DB query pays for index lookups plus disk I/O (or at best a DB-side page cache) on every request, and often does more work per query (joins, locking, planning). Redis is a purpose-built in-memory key-value lookup with none of that overhead — it's not that the DB's storage is slow, it's that a cache short-circuits the whole query-execution path down to a single memory lookup.</div>
</div>

---

## 2. Cache Tier Hierarchy

Each tier trades latency for sharing scope: the faster a cache is, the fewer things can see what's in it. CPU cache is invisible outside one core; an in-process cache is invisible outside one app instance; only the distributed tier is actually shared state across a fleet.

```mermaid
graph TD
    classDef client fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6
    classDef edge fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef app fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef cache fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef db fill:#2c3e50,stroke:#1a252f,color:#fff,rx:6
    classDef cpu fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    Client["Client Browser<br/>issues the request"]:::client

    subgraph EDGE["Edge Tier — global, per-PoP"]
        CDN["CDN Edge Cache<br/>~5ms, geographic"]:::edge
    end

    subgraph APP["Application Tier — per instance"]
        CPU["CPU L1/L2/L3 Cache<br/>1–40ns, per core"]:::cpu
        AppL1["App In-Process Cache<br/>~0.01ms, per instance heap"]:::app
    end

    subgraph SHARED["Shared Cache Tier — fleet-wide"]
        Redis["Distributed Cache<br/>Redis / Memcached<br/>~0.5ms, shared"]:::cache
    end

    subgraph DBT["Database Tier"]
        DBQueryCache["DB Query Cache<br/>~1ms, per DB node"]:::db
        DB["Database Disk<br/>~10ms+"]:::db
    end

    Client -->|"request"| CDN
    CDN -->|"miss: forward"| AppL1
    CPU -.->|"used transparently<br/>by the app process"| AppL1
    AppL1 -->|"miss: fan out"| Redis
    Redis -->|"miss: query"| DBQueryCache
    DBQueryCache -->|"miss: disk read"| DB
```

<div class="quiz-card">
  <p class="quiz-q">Why can't an app in-process cache just replace the shared Redis/Memcached tier entirely, given it's ~50x faster (0.01ms vs 0.5ms)?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Scope, not speed, is the tradeoff: an in-process cache lives in one app instance's heap, so every other instance in the fleet has its own separate, inconsistent copy (or no copy at all). The distributed tier is slower per lookup but is the only tier that gives every instance the same shared view of the data — which is exactly what's needed for anything beyond single-instance hot data.</div>
</div>

---

## 3. Cache-Aside (Lazy Loading)

The application owns the cache interaction.

```mermaid
sequenceDiagram
    participant App
    participant Cache
    participant DB

    App->>Cache: GET key
    alt cache hit
        Cache-->>App: return value
        Note over App: DB never touched — fast path
    else cache miss (cold key or expired TTL)
        Cache-->>App: nil
        App->>DB: SELECT ...
        DB-->>App: row data
        App->>Cache: SET key value EX ttl
        Note over Cache: key now warm until TTL expiry
        App-->>App: return value
    end
    Note over App,DB: Risk: if another process updates the DB directly,<br/>this cache entry goes stale until TTL expiry
```

**Code pattern (Python/Redis):**
```python
def get_user(user_id):
    key = f"user:{user_id}"
    data = redis.get(key)
    if data:
        return json.loads(data)
    user = db.query("SELECT * FROM users WHERE id = %s", user_id)
    redis.setex(key, 300, json.dumps(user))
    return user
```

**Pros:** Only caches what's actually read. Cache failures don't break writes.

**Cons:** First read is always slow (cold miss). Stale data possible if DB changes outside the app.

**Thundering herd risk:** Many requests miss simultaneously on cold start or expiry — all hit DB at once. See §11.

<div class="quiz-card">
  <p class="quiz-q">A cache-aside app updates a row directly in the DB via a one-off admin script, bypassing the application code entirely. What happens to reads of that row?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>They keep returning the old, stale cached value until the TTL expires — cache-aside only refreshes the cache on the read path, inside the app's own get logic. Anything that changes the DB outside that code path (a direct DB write, another service, a manual script) has no way to invalidate the cached entry, which is exactly the staleness risk called out for this pattern.</div>
</div>

---

## 4. Write-Through

Every write goes to cache AND DB in the same operation.

```mermaid
sequenceDiagram
    participant App
    participant Cache
    participant DB
    participant App2 as Another App Instance

    App->>Cache: SET key value
    activate Cache
    Cache->>DB: INSERT/UPDATE (synchronous)
    DB-->>Cache: ack
    Cache-->>App: ack
    deactivate Cache
    Note over App,DB: Write latency = cache write + DB write,<br/>paid on every write regardless of future reads

    App2->>Cache: GET key
    Cache-->>App2: return value (already fresh)
    Note over App2: No stale read possible —<br/>cache was updated in the same operation as the DB
```

**Pros:** Cache is always consistent with DB. No stale reads after writes.

**Cons:** Write latency = cache latency + DB latency. Cache fills with data that may never be read.

---

## 5. Write-Behind (Write-Back)

Write to cache immediately; flush to DB asynchronously.

```mermaid
sequenceDiagram
    participant App
    participant Cache
    participant Queue as Dirty-Key Queue
    participant DB

    App->>Cache: SET key value
    Cache-->>App: ack (fast — DB not involved yet)
    Cache->>Queue: enqueue dirty key
    Note over Queue: keys batch up until<br/>flush interval or batch size hit

    par periodic flush
        Queue->>DB: batched INSERT/UPDATE
        DB-->>Queue: ack
        Queue->>Queue: mark keys clean
    end

    Note over Cache,DB: Risk: if Cache/Queue crashes before flush,<br/>queued writes are lost — the client already got "ack"
```

**Pros:** Extremely fast writes. Batch DB writes reduce I/O.

**Cons:** Data loss if cache crashes before flush. Complexity in failure handling.

<div class="quiz-card">
  <p class="quiz-q">The app already received "ack" for a write-behind SET. Ten seconds later, the cache process crashes before its next batch flush. Is that write safe?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — the ack only confirmed the write landed in the cache/queue, not the DB. Write-behind's whole speed advantage comes from acknowledging before the DB write happens, so any dirty key still sitting in the queue when the cache crashes is lost permanently, even though the client was already told the write succeeded. This is the core tradeoff versus write-through, which pays extra latency specifically to avoid this gap.</div>
</div>

---

## 6. Read-Through

Cache sits in front of DB and fetches transparently on miss.

```mermaid
sequenceDiagram
    participant App
    participant Cache as Cache + Loader<br/>(e.g. Spring @Cacheable)
    participant DB

    App->>Cache: GET key
    alt cache hit
        Cache-->>App: value
    else cache miss
        Note over Cache,DB: The cache itself calls the DB —<br/>App code never sees this branch
        Cache->>DB: SELECT ...
        DB-->>Cache: data
        Cache->>Cache: store fetched value
        Cache-->>App: data
    end
    Note over App: App's code is identical on hit or miss —<br/>always just "GET key"
```

**Difference from cache-aside:** App only talks to cache. Cache library/provider handles DB fetching. Example: Spring Cache with `@Cacheable`.

---

## 7. All 4 Patterns — Side-by-Side

Solid arrows are synchronous (the caller waits); dashed arrows are asynchronous (the caller already moved on). That one visual distinction is most of what separates write-through's safety from write-behind's speed.

```mermaid
graph LR
    classDef app fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef cache fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef db fill:#2c3e50,stroke:#1a252f,color:#fff,rx:6

    subgraph CacheAside["Cache-Aside — app owns both paths"]
        CA_App["App"]:::app -->|"read: GET"| CA_Cache["Cache"]:::cache
        CA_App -->|"on miss: SELECT"| CA_DB["DB"]:::db
        CA_App -->|"on miss: SET"| CA_Cache
        CA_App -->|"write: UPDATE"| CA_DB
    end

    subgraph WriteThrough["Write-Through — sync, consistent"]
        WT_App["App"]:::app -->|"write: SET"| WT_Cache["Cache"]:::cache
        WT_Cache -->|"sync write"| WT_DB["DB"]:::db
    end

    subgraph WriteBehind["Write-Behind — fast, eventually consistent"]
        WB_App["App"]:::app -->|"write: SET"| WB_Cache["Cache"]:::cache
        WB_Cache -.->|"async flush"| WB_DB["DB"]:::db
    end

    subgraph ReadThrough["Read-Through — cache owns the DB fetch"]
        RT_App["App"]:::app -->|"read: GET"| RT_Cache["Cache"]:::cache
        RT_Cache -->|"on miss: SELECT"| RT_DB["DB"]:::db
    end
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="ptn-aside" class="active">Cache-Aside</button>
    <button data-tab="ptn-through">Write-Through</button>
    <button data-tab="ptn-behind">Write-Behind</button>
    <button data-tab="ptn-readthrough">Read-Through</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="ptn-aside">
      <strong>Pros:</strong> Only caches what's actually read. Cache failures don't break writes.<br/>
      <strong>Cons:</strong> First read is always slow (cold miss). Stale data possible if DB changes outside the app.
    </div>
    <div class="tab-panel" data-tab-panel="ptn-through">
      <strong>Pros:</strong> Cache is always consistent with DB. No stale reads after writes.<br/>
      <strong>Cons:</strong> Write latency = cache latency + DB latency. Cache fills with data that may never be read.
    </div>
    <div class="tab-panel" data-tab-panel="ptn-behind">
      <strong>Pros:</strong> Extremely fast writes. Batch DB writes reduce I/O.<br/>
      <strong>Cons:</strong> Data loss if cache crashes before flush. Complexity in failure handling.
    </div>
    <div class="tab-panel" data-tab-panel="ptn-readthrough">
      <strong>Pros:</strong> App only talks to cache — simpler application code, no manual miss-handling.<br/>
      <strong>Cons:</strong> Locked into whatever the cache library/provider's loader supports (e.g. Spring Cache's <code>@Cacheable</code>) — less control than hand-rolled cache-aside.
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">You need the fastest possible writes and can tolerate losing the last few seconds of data on a crash. Which of the 4 patterns fits, and which is the wrong choice for the same requirement?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Write-behind fits — it acks the client immediately and flushes to the DB asynchronously in batches, trading some crash-safety for speed. Write-through is the wrong choice here: it deliberately pays cache latency + DB latency on every write specifically to guarantee zero data loss, which is the opposite tradeoff from "fastest writes, some loss is fine."</div>
</div>

---

## 8. Eviction Policies

### Algorithms

| Policy | Description | Use Case |
|--------|-------------|----------|
| LRU | Evict least recently used | General purpose |
| LFU | Evict least frequently used | Skewed access patterns |
| FIFO | Evict oldest inserted key | Simple queues |
| TTL | Expire after time-to-live | Session data, tokens |
| Random | Evict random key | When access is uniform |
| LRU-K | LRU using K-th most recent access | Avoids one-time scan pollution |
| 2Q | Two queues: probationary + protected | Better than LRU for scan resistance |

### Redis `maxmemory-policy` options

```
# redis.conf
maxmemory 2gb
maxmemory-policy allkeys-lru
```

| Policy | Behavior |
|--------|----------|
| `noeviction` | Return error when memory full |
| `allkeys-lru` | Evict any key by LRU |
| `volatile-lru` | Evict keys with TTL set, by LRU |
| `allkeys-lfu` | Evict any key by LFU |
| `volatile-lfu` | Evict keys with TTL set, by LFU |
| `allkeys-random` | Evict any key randomly |
| `volatile-random` | Evict TTL keys randomly |
| `volatile-ttl` | Evict keys with shortest TTL first |

**Rule of thumb:** Use `allkeys-lru` for pure caches. Use `volatile-ttl` when mixing persistent and ephemeral keys.

<div class="quiz-card">
  <p class="quiz-q">A Redis instance stores both session cache keys (with TTLs) and a permanent feature-flag hash (no TTL) that must never be evicted. Which maxmemory-policy fits, and why would allkeys-lru be wrong here?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>volatile-ttl (or another volatile-* policy) fits, because it only ever evicts keys that have a TTL set — the permanent feature-flag hash has none, so it's never a candidate for eviction. allkeys-lru would be wrong: it evicts by recency across every key regardless of TTL, so a rarely-accessed but permanent feature-flag key could get evicted under memory pressure right alongside disposable session keys.</div>
</div>

---

## 9. Redis Data Structures for Caching

### String — simple key-value
```bash
SET user:1001 '{"name":"alice","role":"admin"}' EX 300
GET user:1001
INCR page:views:home   # atomic counter
```

### Hash — object fields without JSON serialization
```bash
HSET user:1001 name alice role admin age 30
HGET user:1001 name
HGETALL user:1001
# Update one field without fetching/re-serializing whole object
HSET user:1001 age 31
```

### Sorted Set — leaderboards, rate limiting
```bash
# Leaderboard
ZADD leaderboard 9500 player:alice
ZADD leaderboard 8200 player:bob
ZREVRANGE leaderboard 0 9 WITHSCORES   # top 10

# Sliding window rate limit (requests in last 60s)
ZADD rate:user:1001 1719651233 req:uuid1
ZREMRANGEBYSCORE rate:user:1001 -inf (now-60)
ZCARD rate:user:1001   # current count
```

### List — queues, recent activity
```bash
LPUSH recent:user:1001 "viewed:product:42"
LTRIM recent:user:1001 0 99   # keep last 100
LRANGE recent:user:1001 0 -1
```

### Bitmap — feature flags, daily active users
```bash
# User 1001 active today (bit at offset = user_id)
SETBIT dau:2026-06-29 1001 1
BITCOUNT dau:2026-06-29   # total DAU
GETBIT dau:2026-06-29 1001
```

### HyperLogLog — unique count (approximate, 0.81% error)
```bash
PFADD unique:visitors:home user:1001 user:1002 user:1001
PFCOUNT unique:visitors:home   # returns 2, not 3
```
Uses ~12KB regardless of cardinality — far cheaper than a Set for billions of IDs.

---

## 10. Redis vs Memcached

| Feature | Redis | Memcached |
|---------|-------|-----------|
| Data structures | String, Hash, List, Set, ZSet, Stream, Geo, HLL | String only |
| Persistence | RDB snapshots + AOF | None |
| Replication | Primary-replica, async | No built-in |
| Cluster | Redis Cluster (hash slots) | Client-side sharding only |
| Pub/Sub | Yes | No |
| Lua scripting | Yes (`EVAL`) | No |
| Transactions | MULTI/EXEC + WATCH | No |
| Memory efficiency | Higher overhead per key (object metadata) | Lower overhead, better for simple KV at scale |
| Multi-threading | Single-threaded command loop (I/O multi-threaded since 6.0) | Multi-threaded |
| Max value size | 512 MB | 1 MB |

**Choose Memcached when:** pure string caching, extreme memory efficiency matters, multi-threaded performance on many cores.

**Choose Redis when:** you need persistence, replication, complex data structures, pub/sub, or Lua atomicity.

<div class="quiz-card">
  <p class="quiz-q">A team needs a sliding-window rate limiter and a leaderboard, both backed by the same cache layer. Why does that requirement alone rule out Memcached?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Both of those need a Sorted Set (ZADD/ZRANGE/ZREMRANGEBYSCORE) — Memcached only supports plain strings, with no native structured data types at all. Redis's richer data structures (Hash, List, Set, ZSet, Stream, Geo, HLL) are exactly the differentiator here; building a sliding-window rate limiter on Memcached would mean reimplementing sorted-set semantics yourself on top of raw strings.</div>
</div>

---

## 11. Cache Stampede / Thundering Herd

**Problem:** A hot key expires. Thousands of requests all miss simultaneously, all hit DB at once, DB collapses.

```mermaid
sequenceDiagram
    participant R1 as Request 1
    participant R2 as Request 2
    participant R3 as Request N
    participant Cache
    participant DB

    R1->>Cache: GET hot_key → miss
    R2->>Cache: GET hot_key → miss
    R3->>Cache: GET hot_key → miss
    R1->>DB: SELECT (stampede)
    R2->>DB: SELECT (stampede)
    R3->>DB: SELECT (stampede)
```

### Solution 1: Mutex / Distributed Lock
```python
def get_with_lock(key):
    val = redis.get(key)
    if val:
        return val
    lock_key = f"lock:{key}"
    if redis.set(lock_key, "1", nx=True, ex=5):  # acquire lock
        try:
            val = db.fetch(key)
            redis.setex(key, 300, val)
            return val
        finally:
            redis.delete(lock_key)
    else:
        time.sleep(0.05)        # wait and retry
        return get_with_lock(key)
```

### Solution 2: XFetch (Probabilistic Early Expiration)
Recompute before expiry based on probability that increases as TTL decreases.

```python
import math, random, time

def xfetch(key, ttl, beta=1.0):
    value, delta, expiry = cache_get_with_metadata(key)
    if time.time() - beta * delta * math.log(random.random()) >= expiry:
        # probabilistically recompute early
        value = db.fetch(key)
        cache_set_with_metadata(key, value, ttl)
    return value
```

### Solution 3: Stale-While-Revalidate
Return stale value immediately; refresh in background.
```python
def get_stale_ok(key, ttl, stale_ttl=60):
    val = redis.get(key)
    if val:
        return val
    # Check extended stale window
    stale = redis.get(f"stale:{key}")
    if stale:
        threading.Thread(target=refresh, args=(key, ttl)).start()
        return stale
    return refresh_sync(key, ttl)
```

### Solution 4: Background Refresh
Cron/worker refreshes hot keys before they expire. Works well for known-hot keys.

---

## 12. Cache Warming

**Why it matters:** A cold cache after deploy → all traffic hits DB → DB overload → cascading failure.

### Strategies

**Pre-warming on deploy (best for known hot keys):**
```bash
# During deploy pipeline, before shifting traffic
python warm_cache.py --keys top_products,homepage,config
```

**Lazy warming:** Cache-aside naturally warms on first reads. Acceptable if DB can handle initial cold traffic.

**Scheduled warming job:**
```python
# K8s CronJob, runs every 5 min for known-hot queries
def warm():
    top_products = db.query("SELECT * FROM products ORDER BY views DESC LIMIT 100")
    for p in top_products:
        redis.setex(f"product:{p.id}", 600, json.dumps(p))
```

**Shadow traffic replay:** Replay recent production logs against new cache before cutover.

**Rule:** Never deploy a stateful cache service without a warm-up phase. Use feature flags or canary to shift traffic gradually.

---

## 13. Cache Invalidation Patterns

> "There are only two hard things in computer science: cache invalidation and naming things." — Phil Karlton

### TTL-Based
Simplest. Set `EX` on every key. Accept eventual staleness.
```bash
SET product:42 '...' EX 300
```

### Event-Driven Invalidation
DB triggers or application events delete cache entries on writes.
```python
def update_product(product_id, data):
    db.execute("UPDATE products SET ... WHERE id = %s", product_id)
    redis.delete(f"product:{product_id}")          # invalidate
    redis.delete(f"product:list:category:{data.category_id}")  # invalidate list
```

### Tag-Based Invalidation
Group related keys under a tag; invalidate all by tag.
```python
# On write: record tag → keys mapping
redis.sadd("tag:category:5", "product:42", "product:43")
# On category update:
keys = redis.smembers("tag:category:5")
redis.delete(*keys)
redis.delete("tag:category:5")
```

### Version Keys (Cache Busting)
Append a version to the key. Old keys expire naturally via TTL.
```python
version = redis.get("product:42:version") or 1
key = f"product:42:v{version}"
data = redis.get(key)
# To invalidate:
redis.incr("product:42:version")
```

---

## 14. Distributed Cache Consistency

### The Write Race Problem

Two app instances update the same key simultaneously — last write wins but may overwrite a newer value.

```mermaid
sequenceDiagram
    participant A as App Instance A
    participant B as App Instance B
    participant Cache

    A->>Cache: GET user:1 → v1
    B->>Cache: GET user:1 → v1
    A->>Cache: SET user:1 v2
    B->>Cache: SET user:1 v3 (overwrites v2)
    Note over Cache: v2 lost
```

### Redis WATCH / MULTI / EXEC (Optimistic Locking)
```bash
WATCH user:1
val = GET user:1
MULTI
  SET user:1 <new_value>
EXEC   # returns nil if user:1 changed since WATCH → retry
```

```python
def safe_update(key, transform):
    with redis.pipeline() as pipe:
        while True:
            try:
                pipe.watch(key)
                current = pipe.get(key)
                new_val = transform(current)
                pipe.multi()
                pipe.set(key, new_val)
                pipe.execute()
                break
            except redis.WatchError:
                continue  # retry on conflict
```

### Compare-and-Swap with Lua (atomic)
```lua
-- SET only if value matches expected
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
```
```bash
EVAL "<script>" 1 user:1 expected_val new_val
```

---

## 15. CDN vs Application Cache vs DB Cache

| Dimension | CDN Edge Cache | App In-Process Cache | Distributed Cache Redis | DB Query Cache |
|-----------|---------------|---------------------|------------------------|----------------|
| What it caches | Static assets, rendered HTML, API responses | Hot objects in heap | Shared computed data, sessions | Query result sets |
| Scope | Global, per-PoP | Per app instance | Shared across all instances | Per DB node |
| Latency | ~5–50ms (geographic) | ~0.01ms (local RAM) | ~0.5–2ms (network) | ~1ms (shared memory) |
| Invalidation | Purge API, TTL, surrogate keys | In-memory eviction, restart | DEL/EXPIRE, event-driven | AUTO on write (MySQL 8 removed it) |
| Use when | Public static/cacheable content | Single-instance hot data | Multi-instance shared state | Read-heavy reporting queries |
| Cost | CDN egress pricing | Free (heap memory) | Redis node cost | Included with DB |
| Risk | Stale public content | No sharing across pods | Network latency + connection pool | MySQL removed query cache in 8.0 |

---

## 16. Sizing & Monitoring

### Working Set Estimation
```
working_set = hot_keys × avg_value_size × replication_factor
# Example: 1M hot keys × 2KB avg × 2 replicas = 4 GB
```

### Hit Rate Math
```
hit_rate = keyspace_hits / (keyspace_hits + keyspace_misses)
effective_latency = hit_rate × cache_latency + (1 - hit_rate) × db_latency

# Example: 90% hit, 1ms cache, 20ms DB:
# = 0.9 × 1 + 0.1 × 20 = 0.9 + 2 = 2.9ms avg
# vs no cache: 20ms avg
```

### Redis Monitoring
```bash
redis-cli INFO stats | grep -E "keyspace_hits|keyspace_misses|evicted_keys|expired_keys"
redis-cli INFO memory | grep used_memory_human
redis-cli INFO keyspace
```

Key metrics:
- `keyspace_hits` / `keyspace_misses` → compute hit rate; target > 90%
- `evicted_keys` > 0 → memory pressure, increase `maxmemory` or evict more aggressively
- `used_memory_rss` >> `used_memory` → memory fragmentation (see §17)
- `connected_clients` near `maxclients` (default 10000) → connection pool exhaustion

### Prometheus / Grafana
Use `redis_exporter`. Key PromQL:
```promql
# Hit rate
rate(redis_keyspace_hits_total[5m]) /
  (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]))

# Eviction rate
rate(redis_evicted_keys_total[5m])

# Memory fragmentation ratio (>1.5 = fragmented)
redis_memory_used_rss_bytes / redis_memory_used_bytes
```

---

## 17. Common Issues

### Cache Poisoning
Attacker inserts malicious data into cache (e.g., via HTTP response splitting, unvalidated key construction).

**Fix:** Validate and sanitize all keys. Never build cache keys from raw user input without normalization. Use signed tokens for sensitive cache values.

### Stale Reads After Write
Write updates DB but forgets to invalidate cache. Reads return old data.

**Fix:** Always pair DB writes with cache invalidation in the same transaction scope (or use write-through). Use short TTLs as a safety net.

### Memory Fragmentation
Redis allocates memory in chunks; after many DEL/EXPIRE cycles, RSS grows above `used_memory`.
```bash
# Check fragmentation ratio (>1.5 is concerning)
redis-cli INFO memory | grep mem_fragmentation_ratio

# Enable active defragmentation (Redis 4+)
# redis.conf
activedefrag yes
active-defrag-ignore-bytes 100mb
active-defrag-threshold-lower 10   # start at 10% fragmentation
active-defrag-threshold-upper 100
```

### Hot Keys
A single key receives millions of requests/sec, saturating a single Redis shard.

**Detection:**
```bash
redis-cli --hotkeys   # requires maxmemory-policy != noeviction
redis-cli monitor | head -100   # live command stream
```

**Fix:** Local L1 shadow cache in each app instance for the hot key (small TTL, 1–5s):
```python
local_cache = {}  # in-process dict

def get_hot(key):
    if key in local_cache and time.time() < local_cache[key]['exp']:
        return local_cache[key]['val']
    val = redis.get(key)
    local_cache[key] = {'val': val, 'exp': time.time() + 1}  # 1s local TTL
    return val
```

Alternative: replicate hot keys across multiple Redis nodes with a prefix shard (`hot:0:key`, `hot:1:key`, ...) and randomly select a shard on read.

### Connection Pool Exhaustion
Each app thread holding a Redis connection; pool depleted under load.

**Fix:**
```python
# redis-py with connection pool
pool = redis.ConnectionPool(host='redis', port=6379, max_connections=50)
r = redis.Redis(connection_pool=pool)
```
- Set `max_connections` to (app_threads × 0.5) as a starting point
- Monitor `connected_clients` in Redis
- Use pipelining to batch commands and reduce round-trips

---

## Quick Reference

```
Cache-aside    → app manages read/write, lazy population
Write-through  → sync write to cache + DB, no stale reads
Write-behind   → fast writes, async DB flush, data loss risk
Read-through   → cache handles DB fetch transparently

LRU            → general purpose
LFU            → skewed/Zipf access patterns
volatile-ttl   → mixed persistent + ephemeral keys

Stampede fix   → mutex lock OR XFetch probabilistic OR stale-while-revalidate
Invalidation   → TTL (simple) → event-driven (consistent) → tag-based (grouped)
Hot key fix    → L1 local shadow cache with short TTL
Fragmentation  → activedefrag yes in redis.conf
```
