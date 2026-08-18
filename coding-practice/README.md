# Coding Practice — DSA for Backend/Infra Interviews

DSA problems that recur specifically in backend/infrastructure/platform engineering interviews — not generic LeetCode grinding. Every implementation ships in **both Go and Python** (full, working, tested — pick whichever tab matches your interview language), matching the practitioner-notes style of the rest of DevOpsIndex. The point is to understand the systems these structures back (caches, rate limiters, sharding, dedup, and the B-trees/skip lists behind [databases/](../databases/) itself) rather than memorize a solution. Every file also carries the repo's standard interactive treatment — step-through walkthroughs of inserts/splits/evictions, Mermaid diagrams, and knowledge-check quizzes (see [website/COMPONENTS.md](../website/COMPONENTS.md)) — and is rendered on the [website](../website/).

---

## Files

| File | Covers | Typical interview relevance |
|------|--------|------------------------------|
| [concurrent-patterns.md](./concurrent-patterns.md) | Thread-safe counter (mutex vs atomic), bounded worker pool, pub/sub via channels, debounce/throttle, goroutine/thread leak detection and fix | The highest-frequency category in Go-specific infra interviews; leak detection in particular is a common "find the bug" exercise |
| [btree.md](./btree.md) | B-tree vs B+tree from scratch, node-split-on-insert walkthrough, linked-leaf range scans | Tests whether you understand *why* the structure backing every Postgres/MySQL default index is disk-page-aligned rather than a plain binary tree — see [databases/postgres-internals.md](../databases/postgres-internals.md), [databases/mysql-internals.md](../databases/mysql-internals.md) |
| [skip-list.md](./skip-list.md) | Skip list from scratch, randomized-level insert/search traversal | Tests understanding of probabilistic balancing as an alternative to rebalancing trees — this is what backs Redis sorted sets, see [databases/redis-internals.md](../databases/redis-internals.md) |
| [lru-cache.md](./lru-cache.md) | LRU cache from scratch (doubly linked list + hashmap), thread-safe variant, LFU comparison, TTL eviction variant | Extremely common — "design an in-memory cache" shows up in nearly every backend/infra loop; tests whether you understand why two data structures are needed together, not just whether you can recite the algorithm |
| [rate-limiter-implementations.md](./rate-limiter-implementations.md) | Token bucket, leaky bucket, fixed window, sliding window log — all four from scratch, plus an HTTP middleware wrapper | Standard system-design-adjacent coding question; tests whether you can translate a system design concept (see [system-design/rate-limiting.md](../system-design/rate-limiting.md)) into working, thread-safe code |
| [consistent-hashing.md](./consistent-hashing.md) | Hash ring with virtual nodes, add/remove node walkthrough | Comes up when discussing sharding, distributed caches, or load balancer request routing; tests understanding of *why* naive modulo hashing fails at scale |
| [bloom-filter.md](./bloom-filter.md) | Bloom filter from scratch, false positive rate math with a worked example | Tests both coding ability and math/estimation skills; relevant to any "avoid expensive lookup" or dedup discussion (DB pre-checks, stream processing) |

---

## Read Order

No strict dependency between files, but if new to Go concurrency and the underlying tree/list structures specifically, read in this order:

```
concurrent-patterns.md        (Go concurrency primitives first)
btree.md                      (disk-oriented tree fundamentals — backs databases/postgres-internals.md, mysql-internals.md)
skip-list.md                  (probabilistic list fundamentals — backs databases/redis-internals.md)
lru-cache.md                  (data structure fundamentals + thread safety)
rate-limiter-implementations.md
consistent-hashing.md
bloom-filter.md
```

## How to Use This Section

Each file is self-contained: full working code in **Go and Python**, a test file for each, complexity analysis, and — where relevant — an explanation of the underlying systems problem (why the naive approach fails, what production systems actually use this for). Run the code locally to verify before an interview:

```bash
# Go
go mod init practice
go test ./...

# Python
python3 -m unittest
```

These are deliberately not "clever one-liner" solutions. Interviewers evaluating backend/infra candidates are usually checking for production-grade instincts — thread safety, bounded resource usage, correct edge-case handling — over algorithmic cleverness. Each file's "interview follow-ups" section calls out the specific probing questions an interviewer is likely to ask next.
