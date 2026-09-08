# System Design

Core patterns for designing scalable, reliable distributed systems. Covers the building blocks you need for both production engineering and system design interviews.

---

## Files

| File | Topics | Level |
|------|--------|-------|
| [scaling.md](./scaling.md) | 3-tier architecture, vertical vs horizontal, DB read replicas, sharding, resharding, consistent hashing, celebrity problem, fan-out, circuit breaker, backpressure | SDE-1/2 |
| [cap-pacelc.md](./cap-pacelc.md) | CAP theorem, CP vs AP, consistency models (linearizable→eventual), PACELC, quorum math, vector clocks, tunable consistency | SDE-2 |
| [rate-limiting.md](./rate-limiting.md) | Fixed window, sliding window, token bucket, leaky bucket, Redis Lua implementation, distributed rate limiting, nginx, AWS API GW | SDE-1/2 |
| [async-patterns.md](./async-patterns.md) | Message queues, pub/sub, DLQ, Saga (choreography/orchestration), outbox pattern, CQRS, event sourcing, idempotency, backpressure | SDE-2 |
| [api-design.md](./api-design.md) | REST vs GraphQL vs gRPC, versioning, pagination (cursor/keyset), idempotency keys, API gateway, auth patterns, webhooks, OpenAPI | SDE-1/2 |
| [distributed-transactions.md](./distributed-transactions.md) | Dual-write problem, 2PC, Saga, outbox pattern, CDC/Debezium, distributed locking (Redlock), optimistic concurrency, TCC, Spanner/TrueTime commit-wait | SDE-2 |
| [file-transfer-storage.md](./file-transfer-storage.md) | Presigned URLs, multipart/resumable upload (tus), chunking + content-addressable dedup, replication vs erasure coding, metadata service design, CDN delivery | SDE-2 |
| [realtime-chat.md](./realtime-chat.md) | WebSocket/long-polling/SSE, connection registry + cross-server relay, delivery guarantees, presence, multi-device fan-out, MQTT, WebRTC calling | SDE-2 |
| [end-to-end-encryption.md](./end-to-end-encryption.md) | Signal Protocol (X3DH, Double Ratchet), hybrid symmetric/asymmetric model, Sender Keys for group chat, multi-device encryption, encrypted backups, server-visibility architecture | SDE-2 |
| [distributed-id-generation.md](./distributed-id-generation.md) | UUID v4 vs ULID/UUIDv7, Twitter Snowflake bit layout, clock-drift handling, ticket servers, range/segment allocation | SDE-2 |
| [geospatial-services.md](./geospatial-services.md) | Geohashing, quadtrees, S2 geometry, Redis GEO commands, ride-hailing matching, KNN vs radius search | SDE-2 |
| [probabilistic-data-structures.md](./probabilistic-data-structures.md) | Bloom filter recap, HyperLogLog cardinality estimation (live simulator), Count-Min Sketch frequency estimation | SDE-2 |

**Read order:** scaling → cap-pacelc → rate-limiting → async-patterns → api-design → distributed-transactions → file-transfer-storage → realtime-chat → end-to-end-encryption → distributed-id-generation → geospatial-services → probabilistic-data-structures

---

## Mental Model

```
User Request
    │
    ▼
CDN / Edge Cache  ──── (static assets, public API responses)
    │ miss
    ▼
Load Balancer (L7)
    │
    ▼
Stateless App Servers ──── Rate Limiter ──── Auth (JWT/OAuth2)
    │
    ├──► Cache (Redis) ──── cache-aside, TTL, eviction
    │
    ├──► Database (primary) ──── write path
    │       └── Read Replicas ──── read scaling
    │       └── Shards ──── write scaling
    │
    ├──► Message Queue ──── async jobs, fan-out, retry
    │       └── Workers
    │
    └──► External APIs ──── circuit breaker, timeout, retry
```

## When to Apply Each Pattern

| Symptom | Pattern |
|---------|---------|
| App servers are CPU-bound | Horizontal scale + LB |
| DB reads are slow | Read replicas + Redis cache |
| DB writes are slow | Vertical scale → sharding |
| Single key getting hammered | Celebrity problem → key splitting / L1 cache |
| Slow synchronous operations (email, resize) | Async queue + workers |
| Downstream service is flaky | Circuit breaker + exponential backoff |
| Need distributed transaction | Saga + outbox pattern (avoid 2PC) |
| Need to prevent duplicate processing | Idempotency keys + dedup table |
| API is getting hammered | Rate limiting (token bucket) |
| Strong consistency required | CP system + quorum reads |
| High availability over consistency | AP system + eventual consistency |
