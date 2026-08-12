# API Design

Production-focused reference for REST, versioning, pagination, idempotency, and API gateways.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. REST Principles

REST (Representational State Transfer) is an architectural style, not a protocol.

| Constraint | Meaning |
|---|---|
| **Stateless** | Each request contains all info needed. No server-side session. |
| **Client-Server** | UI and data storage concerns are separated. |
| **Uniform Interface** | Resources identified by URI; manipulation via representations. |
| **Cacheable** | Responses must declare themselves cacheable or not. |
| **Layered System** | Client can't tell if it's talking to origin or intermediary. |

**HTTP Methods:**

| Method | Idempotent | Safe | Use |
|---|---|---|---|
| GET | ✅ | ✅ | Read resource |
| POST | ❌ | ❌ | Create resource, non-idempotent action |
| PUT | ✅ | ❌ | Full replace |
| PATCH | ❌ | ❌ | Partial update |
| DELETE | ✅ | ❌ | Remove resource |

**HATEOAS** (Hypermedia As The Engine Of Application State): responses include links to related actions. Rarely implemented in practice outside hypermedia APIs.

```json
{
  "id": "123",
  "status": "pending",
  "_links": {
    "cancel": { "href": "/orders/123/cancel", "method": "POST" },
    "self":   { "href": "/orders/123",        "method": "GET"  }
  }
}
```

<div class="quiz-card">
  <p class="quiz-q">The HTTP methods table marks DELETE as idempotent. But calling DELETE /orders/9 twice returns 204 the first time and 404 the second — different responses. Doesn't that break idempotency?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No — idempotent describes the effect on server <em>state</em>, not the HTTP
    response code. After the first DELETE, the resource is gone. Every
    subsequent DELETE leaves the server in that exact same state (still gone),
    even though the status code differs because the second call has nothing
    left to delete. Idempotent means "N identical requests leave the resource
    exactly as one request would" — not "N identical requests get identical
    responses."
  </div>
</div>

---

## 2. URL Design

**Nouns, not verbs.** The HTTP method is the verb.

```
❌ POST /createUser
✅ POST /users

❌ GET  /getUserById?id=5
✅ GET  /users/5

❌ POST /deleteOrder/9
✅ DELETE /orders/9
```

**Plural resource names** consistently:
```
/users, /orders, /products
```

**Hierarchy** for ownership/containment (max 2-3 levels deep):
```
/users/{userId}/orders
/users/{userId}/orders/{orderId}
/users/{userId}/orders/{orderId}/items
```

**Path params vs Query params:**

| Use Path Params | Use Query Params |
|---|---|
| Identifying a specific resource | Filtering, sorting, pagination |
| Required to locate the resource | Optional modifiers |
| `/users/123` | `/users?role=admin&sort=created_at` |
| `/orders/456/items` | `/orders?status=pending&limit=20` |

```
GET /products/{id}              # path: required identifier
GET /products?category=shoes&sort=price&limit=20   # query: optional filters
```

<div class="quiz-card">
  <p class="quiz-q">You need an endpoint for a user's pending orders. Should "pending" be a path segment (<code>/users/5/orders/pending</code>) or a query parameter (<code>/users/5/orders?status=pending</code>)?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Query parameter. Per the path-vs-query table, path params are for
    identifying/locating a specific resource — required to even find it — while
    query params are for filtering, sorting, and pagination: optional modifiers
    on a resource collection you can already locate. "Pending" is a filter on
    the orders collection, not part of what identifies it, so it belongs after
    the <code>?</code>.
  </div>
</div>

---

## 3. HTTP Status Codes

### 2xx — Success

| Code | Name | When to use |
|---|---|---|
| 200 | OK | GET, PUT, PATCH success with body |
| 201 | Created | POST that creates a resource. Include `Location` header. |
| 202 | Accepted | Request accepted, processing async. Poll for result. |
| 204 | No Content | DELETE or action with no response body |

### 4xx — Client Error

| Code | Name | When to use |
|---|---|---|
| 400 | Bad Request | Malformed syntax, invalid JSON |
| 401 | Unauthorized | Missing or invalid auth credentials |
| 403 | Forbidden | Authenticated but not authorized |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate resource, optimistic lock conflict |
| 422 | Unprocessable Entity | Valid syntax but semantic validation failed |
| 429 | Too Many Requests | Rate limit exceeded |

### 5xx — Server Error

| Code | Name | When to use |
|---|---|---|
| 500 | Internal Server Error | Unexpected server-side failure |
| 502 | Bad Gateway | Upstream service returned invalid response |
| 503 | Service Unavailable | Server overloaded or in maintenance |
| 504 | Gateway Timeout | Upstream service timed out |

### Common Mistakes

```json
// ❌ 200 with error in body — breaks clients, monitoring, and HTTP semantics
HTTP/1.1 200 OK
{ "status": "error", "message": "User not found" }

// ✅ Use the correct status code
HTTP/1.1 404 Not Found
{ "error": { "code": "USER_NOT_FOUND", "message": "User not found" } }
```

```json
// ❌ 401 vs 403 confusion
401 = "I don't know who you are" (missing/invalid token)
403 = "I know who you are, you can't do this" (valid token, wrong permissions)
```

<div class="quiz-card">
  <p class="quiz-q">A request arrives with a valid, unexpired auth token, but that user's role doesn't allow the action. Is the correct status 401 or 403?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    403 Forbidden. 401 means the server can't identify the caller at all
    (missing or invalid credentials) — "I don't know who you are." 403 means
    the server knows exactly who's calling and that identity just isn't
    allowed to do this — "I know who you are, you can't do this." A valid
    token with insufficient permissions is always 403, never 401.
  </div>
</div>

---

## 4. REST vs GraphQL vs gRPC

| | REST | GraphQL | gRPC |
|---|---|---|---|
| **Protocol** | HTTP/1.1+ | HTTP/1.1+ | HTTP/2 |
| **Payload** | JSON (verbose) | JSON (fetch only what you need) | Protobuf (binary, compact) |
| **Type Safety** | ❌ (OpenAPI optional) | ✅ (schema enforced) | ✅ (`.proto` enforced) |
| **Streaming** | SSE / WebSocket (workaround) | Subscriptions | Native bidirectional |
| **Over/Underfetching** | Common problem | Solved by design | N/A (precise RPCs) |
| **Browser Support** | ✅ Native | ✅ Native | ❌ Needs grpc-web proxy |
| **Caching** | ✅ HTTP cache (GET) | ❌ All POST by default | ❌ No HTTP caching |
| **Learning Curve** | Low | Medium | Medium-High |
| **Best For** | Public APIs, CRUD, simple clients | Complex frontends, mobile, BFF | Internal microservices, low-latency |

**Decision guide:**
- Public API for third parties → **REST**
- Mobile app with many endpoints, bandwidth-sensitive → **GraphQL**
- Internal service-to-service, high throughput, streaming → **gRPC**
- Mix: GraphQL BFF layer over gRPC internal services is common

<div class="quiz-card">
  <p class="quiz-q">Why is a GraphQL API generally harder to cache with standard HTTP infrastructure (CDNs, browser cache) than a REST API?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Per the comparison table, REST gets HTTP caching for free on GET requests
    — the URL itself is the cache key. GraphQL sends nearly all operations as
    POST to a single <code>/graphql</code> endpoint with the query in the body,
    so there's no distinct, cacheable URL per request and standard HTTP
    caches (which key on method + URL) have nothing to key off. Caching
    GraphQL responses requires an application-level cache instead.
  </div>
</div>

---

## 5. API Versioning Strategies

### URL Path (recommended for public APIs)
```
GET /v1/users/123
GET /v2/users/123
```
- ✅ Explicit, easy to route, visible in logs, bookmarkable
- ✅ Works with all HTTP clients without custom headers
- ❌ "Dirty" URL (purists argue URI should be stable)

### Header Versioning
```
GET /users/123
Accept-Version: v2
# or
API-Version: 2024-01-01
```
- ✅ Clean URL
- ❌ Harder to test in browser, invisible in logs
- Used by: Stripe (date-based), GitHub

### Query Parameter
```
GET /users/123?version=2
```
- ✅ Easy to test
- ❌ Cache behavior inconsistent (URL varies), easy to forget

### Recommendation

| API Type | Strategy |
|---|---|
| Public API | URL path (`/v1/`) |
| Internal / microservices | Header or path |
| Stripe-style (evolutionary) | Date-based headers |

**Sunset policy:** when deprecating, add:
```
Deprecation: Sun, 01 Jan 2025 00:00:00 GMT
Sunset: Sun, 01 Jul 2025 00:00:00 GMT
Link: <https://docs.example.com/migration>; rel="deprecation"
```

<div class="quiz-card">
  <p class="quiz-q">Header versioning gives you a "clean" URL. Why does the recommendation table still favor URL-path versioning (<code>/v1/</code>) for public APIs?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Because header versioning's downsides hit public, third-party consumers
    especially hard: the version is invisible in server logs (harder to debug
    which clients are on which version), harder to test directly in a browser,
    and requires every client library to support custom headers. URL-path
    versioning is explicit, shows up in logs and bookmarks, and works with
    literally any HTTP client with zero special handling — worth the "dirty
    URL" purists object to.
  </div>
</div>

---

## 6. Pagination Strategies

Three ways to page through a list, each trading off jump-to-page ability against stability under concurrent writes.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="offset" class="active">Offset / Limit</button>
    <button data-tab="cursor">Cursor-Based</button>
    <button data-tab="keyset">Keyset</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="offset">
      <p><strong>Simple — request the same page shape as SQL's OFFSET/LIMIT.</strong></p>
      <pre><code>GET /posts?offset=40&amp;limit=20</code></pre>
      <pre><code>{
  "data": [...],
  "total": 1000,
  "offset": 40,
  "limit": 20
}</code></pre>
      <p>
        ✅ Easy to implement, jump to any page.<br/>
        ❌ <strong>Drift problem</strong>: if a row is inserted/deleted between
        requests, you get duplicates or skip items.<br/>
        ❌ <code>OFFSET N</code> in SQL scans and discards N rows — slow for
        large N, even with an index on the sort column, because OFFSET can't
        use that index to jump straight to row N.
      </p>
    </div>
    <div class="tab-panel" data-tab-panel="cursor">
      <p><strong>Stable, recommended default.</strong></p>
      <pre><code>GET /posts?cursor=eyJpZCI6MTAwfQ&amp;limit=20</code></pre>
      <pre><code>{
  "data": [...],
  "next_cursor": "eyJpZCI6MTIwfQ",
  "has_more": true
}</code></pre>
      <p>
        Cursor is typically a base64-encoded opaque value (e.g.
        <code>{"id": 100, "created_at": "..."}</code>).
      </p>
      <pre><code>-- Server decodes cursor and queries:
SELECT * FROM posts WHERE id &gt; 100 ORDER BY id LIMIT 20;</code></pre>
      <p>
        ✅ Stable (inserts/deletes don't affect position).<br/>
        ✅ O(1) with index — no offset scan, the <code>WHERE id &gt; 100</code>
        predicate seeks directly via the index.<br/>
        ❌ Can't jump to an arbitrary page.<br/>
        ❌ Client must treat the cursor as opaque — never decode or construct
        one itself.
      </p>
    </div>
    <div class="tab-panel" data-tab-panel="keyset">
      <p><strong>Cursor's plain-fields sibling.</strong></p>
      <pre><code>GET /posts?after_id=100&amp;limit=20
# or for multi-column sort:
GET /events?after_created_at=2024-01-15T10:00:00Z&amp;after_id=500&amp;limit=20</code></pre>
      <p>
        Same benefits as cursor-based, but uses explicit fields instead of an
        encoded token — trades opacity for readability. Requires a composite
        index on the sort columns (e.g. <code>(created_at, id)</code>) so the
        multi-column comparison stays index-eligible instead of falling back
        to a sequential scan.
      </p>
    </div>
  </div>
</div>

### Comparison

| Strategy | Jump to page | Stable | Large offsets | Complexity |
|---|---|---|---|---|
| Offset/Limit | ✅ | ❌ | ❌ slow | Low |
| Cursor-based | ❌ | ✅ | ✅ | Medium |
| Keyset | ❌ | ✅ | ✅ | Medium |

Use **offset** for admin UIs with small datasets. Use **cursor/keyset** for feeds, infinite scroll, APIs.

<div class="quiz-card">
  <p class="quiz-q">Why does <code>OFFSET 100000</code> stay slow even on a table with an index on the sort column, while cursor pagination's <code>WHERE id &gt; 100000</code> stays fast?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    <code>OFFSET N</code> tells the database "skip the first N matching rows"
    — it still has to walk and discard all N of them before it can return row
    N+1, regardless of any index. A <code>WHERE id &gt; 100000</code> predicate,
    by contrast, is a normal indexed range condition: the index lets the
    database seek directly to the first qualifying row in O(log n), with no
    rows scanned and thrown away. That's the whole reason cursor/keyset
    pagination stays O(1)-ish at any depth while offset pagination gets
    linearly slower the deeper you page.
  </div>
</div>

---

## 7. Idempotency Keys

POST and PATCH are not idempotent by default — retrying on network failure creates duplicates.

### Flow

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. First attempt arrives.</strong> Client sends
      <code>POST /payments</code> with header
      <code>Idempotency-Key: uuid-1234</code>. Server checks its store for
      that key and finds nothing — this is a genuinely new request.
    </div>
    <div class="stepper-panel">
      <strong>2. Server processes it.</strong> The payment is processed
      exactly once — charge the card, write the order row, whatever the
      operation actually does.
    </div>
    <div class="stepper-panel">
      <strong>3. Server stores the result and responds.</strong> The full
      response (status code + body) is stored as
      <code>{uuid-1234 → response}</code> with a 24h TTL, and
      <code>201 Created</code> goes back to the client.
    </div>
    <div class="stepper-panel">
      <strong>4. Network error, client retries.</strong> The client never
      saw the response (timeout, dropped connection, whatever) so it retries
      the exact same logical operation — reusing the <em>same</em>
      <code>Idempotency-Key: uuid-1234</code>, not a freshly generated one.
    </div>
    <div class="stepper-panel">
      <strong>5. Server replays, doesn't reprocess.</strong> This time the
      store lookup finds the key already present. The server returns the
      cached response — same <code>201 Created</code>, same body — without
      charging the card a second time.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

### Implementation

```python
# Client: generate UUID per logical operation (not per retry)
import uuid
idempotency_key = str(uuid.uuid4())

# Include in header
headers = {"Idempotency-Key": idempotency_key}
# Retry with SAME key
```

```python
# Server: check before processing
def handle_payment(request):
    key = request.headers.get("Idempotency-Key")
    if key:
        cached = redis.get(f"idem:{key}")
        if cached:
            return cached  # replay

    result = process_payment(request.body)

    if key:
        redis.setex(f"idem:{key}", ttl=86400, value=result)

    return result
```

**Rules:**
- Client generates the key (UUID v4), not the server
- Store key → full response (status code + body)
- TTL: 24 hours is standard
- Return `409 Conflict` if same key is received while first request is still processing
- Scope by user/tenant: `f"idem:{tenant_id}:{key}"`

<div class="quiz-card">
  <p class="quiz-q">If a client generates a brand-new UUID for every retry instead of reusing the same idempotency key, what breaks?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The entire mechanism. The server has no way to recognize the retry as
    "the same logical operation" — each new key looks like a genuinely new
    request, so it processes the payment again. The key must be generated
    once per logical operation on the client and reused verbatim across every
    retry of that same operation; only then can the server's store lookup
    catch the duplicate and replay the cached response instead of reprocessing.
  </div>
</div>

---

## 8. Rate Limiting Headers

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 1000        # requests allowed per window
X-RateLimit-Remaining: 42      # requests left in current window
X-RateLimit-Reset: 1735689600  # UTC epoch when window resets
```

On limit exceeded:
```
HTTP/1.1 429 Too Many Requests
Retry-After: 30                # seconds until client can retry
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1735689600
```

**Rate limiting algorithms:**

| Algorithm | Pros | Cons |
|---|---|---|
| Fixed window | Simple | Burst at window boundary |
| Sliding window log | Accurate | Memory-intensive |
| Sliding window counter | Efficient, smooth | Approximate |
| Token bucket | Allows controlled bursts | More complex |
| Leaky bucket | Smooth output rate | No burst tolerance |

Token bucket is most common (AWS API GW, nginx).

<div class="quiz-card">
  <p class="quiz-q">Token bucket and leaky bucket are both described as "smooth" in some sense. What's the actual difference in behavior when a client sends a sudden burst of requests?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Token bucket <strong>allows controlled bursts</strong> — unused capacity
    accumulates as tokens up to the bucket size, so a client that's been idle
    can fire off a burst all at once as long as it has saved-up tokens. Leaky
    bucket enforces a strictly smooth output rate with <strong>no burst
    tolerance</strong> — requests queue up and drain at a fixed rate no matter
    how bursty the arrivals were. If your API needs to tolerate the occasional
    spike, token bucket is the one that lets it through; leaky bucket flattens
    it out regardless.
  </div>
</div>

---

## 9. API Gateway Pattern

Single entry point for all client requests. Handles cross-cutting concerns so services don't have to.

```mermaid
graph TD
    classDef client fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef step fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef service fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    CLIENT["Client"]:::client --> AUTH

    subgraph GW["API Gateway — single entry point for every request"]
        AUTH["Auth<br/>validate JWT / API key"]:::step --> RL["Rate Limit<br/>per-client / per-IP quota"]:::step
        RL --> ROUTE["Route<br/>path/header-based dispatch"]:::step
        ROUTE --> XFORM["Transform<br/>reshape request/response"]:::step
        XFORM --> LOGT["Log and Trace<br/>inject trace ID, log centrally"]:::step
        LOGT --> CB["Circuit Break<br/>skip unhealthy upstreams"]:::step
    end

    CB --> USERS["Users Service"]:::service
    CB --> ORDERS["Orders Service"]:::service
    CB --> PRODUCTS["Products Service"]:::service
    CB --> PAYMENTS["Payments Service"]:::service
```

**Responsibilities:**

| Concern | Detail |
|---|---|
| **Authentication** | Validate JWT/API key before forwarding |
| **Rate Limiting** | Per-client, per-IP, per-route quotas |
| **Request Routing** | Path/header-based routing to upstream services |
| **SSL Termination** | TLS at gateway, plain HTTP to internal services |
| **Request/Response Transform** | Add/strip headers, reshape payloads |
| **Logging & Tracing** | Inject trace IDs, log all requests centrally |
| **Circuit Breaker** | Stop forwarding to unhealthy upstreams |
| **Caching** | Cache GET responses at gateway edge |

### Options Comparison

| | Kong | AWS API Gateway | nginx |
|---|---|---|---|
| **Type** | OSS / Enterprise | Managed SaaS | OSS reverse proxy |
| **Config** | Declarative YAML / Admin API | AWS Console / Terraform | `nginx.conf` |
| **Plugins** | 100+ (auth, rate limit, transform) | Built-in + Lambda authorizers | Lua / custom modules |
| **Latency overhead** | ~1ms | ~5-10ms | <1ms |
| **Best for** | Self-hosted, plugin-rich | AWS-native, serverless | High-perf, simple routing |
| **Cost** | Free (OSS) | Pay per million calls | Free |

<div class="quiz-card">
  <p class="quiz-q">Why does the responsibilities table put SSL/TLS termination at the gateway rather than leaving each backend service to handle its own TLS?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Terminating TLS once at the gateway means certificates only need to be
    managed and rotated in one place, and every internal service is freed
    from the decryption/handshake cost — they talk plain HTTP behind the
    gateway. It's the same "handle cross-cutting concerns centrally so
    services don't have to" principle the gateway pattern is built on, just
    applied to TLS instead of auth or rate limiting.
  </div>
</div>

---

## 10. Authentication Patterns

### API Key (simple)
```
GET /data
X-API-Key: sk_live_abc123
# or
Authorization: Bearer sk_live_abc123
```
- ✅ Simple to implement and use
- ❌ No expiry, no scopes, hard to rotate
- Use for: server-to-server, developer APIs (not user-facing)

### JWT (stateless)
```
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig
```
```json
// Decoded payload
{
  "sub": "user123",
  "exp": 1735689600,
  "roles": ["read", "write"],
  "iss": "https://auth.example.com"
}
```
- ✅ Stateless — no DB lookup, scales horizontally
- ✅ Claims embedded (user ID, roles)
- ❌ Can't invalidate before expiry without a blocklist
- Use short-lived access tokens (15 min) + refresh tokens

### OAuth2 (delegated authorization)
```
1. Client redirects user → Authorization Server
2. User approves → Auth Server returns code
3. Client exchanges code → access_token + refresh_token
4. Client uses access_token for API calls
```

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as Client app
    participant AS as Authorization Server
    participant API as Resource API

    CLI->>AS: Redirect to authorize endpoint, with PKCE code_challenge
    AS->>U: Prompt login and consent
    U-->>AS: Approves
    AS-->>CLI: Redirect back with authorization code
    CLI->>AS: Exchange code and code_verifier for tokens
    AS-->>CLI: access_token and refresh_token
    CLI->>API: Request with Authorization, Bearer access_token
    API-->>CLI: Protected response
```

Flows:
- **Authorization Code + PKCE**: web/mobile apps (user-facing)
- **Client Credentials**: service-to-service (no user)
- Never use Implicit flow (deprecated)

### mTLS (mutual TLS, service-to-service)
```
Both client AND server present certificates.
Certificates issued by internal CA (Vault PKI, cert-manager).
```
- ✅ Strongest — cryptographic identity, no token to steal
- ✅ Used in service mesh (Istio auto-injects)
- ❌ Certificate lifecycle management overhead
- Use for: internal microservice auth, zero-trust networks

<div class="quiz-card">
  <p class="quiz-q">A user's JWT access token is stolen. Can you immediately revoke just that token?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Not directly. JWTs are stateless by design — there's no server-side
    session to invalidate, and the token stays valid until it expires unless
    you maintain a blocklist (which gives back the DB lookup statelessness
    was supposed to avoid). This is exactly why the recommendation is
    short-lived access tokens (~15 min) paired with separately revocable
    refresh tokens: you can't kill the stolen access token early, but you can
    make sure it dies soon and revoke the refresh token so it can't be
    renewed.
  </div>
</div>

---

## 11. Error Response Format

Consistent error structure across all endpoints — clients should never parse error messages.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "email", "issue": "must be a valid email address" },
      { "field": "age",   "issue": "must be >= 18" }
    ],
    "request_id": "req_01HX4K2N3P5Q"
  }
}
```

| Field | Purpose |
|---|---|
| `code` | Machine-readable constant — use in `switch` statements |
| `message` | Human-readable, safe to display |
| `details` | Array of field-level errors for validation |
| `request_id` | Correlates to server logs for support |

**Rules:**
- ❌ Never include stack traces, SQL errors, or internal paths in responses
- ❌ Never return `{ "success": false }` with 200 status
- ✅ `code` must be a stable constant, not a number that shifts with refactors
- ✅ Log full error server-side; return only safe subset to client

```json
// ❌ Leaking internals
{
  "error": "NullPointerException at UserService.java:142\nDB: SELECT * FROM users..."
}

// ✅ Safe error
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred",
    "request_id": "req_01HX4K2N"
  }
}
```

<div class="quiz-card">
  <p class="quiz-q">Why should the error <code>code</code> field be a fixed string like <code>VALIDATION_ERROR</code> instead of a numeric error code the team assigns internally?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Because numbers shift when errors get reorganized or renumbered during a
    refactor, silently breaking any client code that switches on them —
    while a stable string constant keeps meaning the same thing release after
    release. That's exactly the rule the field table and checklist both call
    out: <code>code</code> is machine-readable and meant to be used in a
    client's <code>switch</code> statement, so it has to be a value that never
    quietly changes underneath the client.
  </div>
</div>

---

## 12. Backward Compatibility

### Safe (additive) changes — no versioning required
- Add new optional fields to response
- Add new optional request parameters
- Add new endpoints
- Add new enum values (caveat: tolerant reader must handle unknowns)

```json
// v1 response
{ "id": 1, "name": "Alice" }

// safe addition — existing clients ignore unknown fields
{ "id": 1, "name": "Alice", "email": "alice@example.com" }
```

### Breaking changes — require new version
- Remove or rename a field
- Change a field's type (`string` → `int`)
- Change semantics of an existing field
- Make optional field required
- Remove an endpoint

### Tolerant Reader Pattern

Clients should:
- Ignore unknown fields (don't fail on new additions)
- Handle missing optional fields gracefully
- Not hardcode enum values — use a default for unknowns

```python
# ❌ Brittle
status = response["status"]  # KeyError if field removed

# ✅ Tolerant
status = response.get("status", "unknown")
```

### Additive-Only API Evolution

Design responses to be extensible:
```json
// ✅ Wrap in envelope — can add metadata without breaking clients
{
  "data": { "id": 1, "name": "Alice" },
  "meta": { "version": "1.2" }
}
```

<div class="quiz-card">
  <p class="quiz-q">Adding a new possible value to an existing enum field is listed under "safe (additive) changes." Is it actually always safe, with no client-side risk?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No — it's safe only conditionally, and the file flags exactly that
    caveat: the tolerant reader must handle unknown values. A client that
    hardcodes a <code>switch</code>/<code>if</code> over the old enum values
    with no default case will break the moment the new value shows up, even
    though the API technically didn't remove or rename anything. "Additive"
    changes are only non-breaking if every client actually follows the
    Tolerant Reader Pattern — the API author can't guarantee that on the
    client's behalf.
  </div>
</div>

---

## 13. OpenAPI / Swagger

**Spec-first design**: write the contract before writing code. Generated docs, mocks, and client SDKs follow.

```yaml
# openapi.yaml
openapi: "3.1.0"
info:
  title: Orders API
  version: "1.0.0"

paths:
  /orders/{orderId}:
    get:
      summary: Get order by ID
      parameters:
        - name: orderId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Order found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
        "404":
          $ref: "#/components/responses/NotFound"

components:
  schemas:
    Order:
      type: object
      required: [id, status]
      properties:
        id:
          type: string
        status:
          type: string
          enum: [pending, confirmed, shipped, delivered]
        total:
          type: number
```

**Workflow:**
1. Write `openapi.yaml` first (contract review with stakeholders)
2. Generate server stubs (openapi-generator)
3. Generate client SDKs for consumers
4. Run contract tests in CI (Dredd, Schemathesis)
5. Publish docs via Swagger UI / Redoc

**Contract testing** catches breaking changes:
```bash
# Schemathesis: fuzz API against OpenAPI spec
schemathesis run openapi.yaml --url http://localhost:8080
```

<div class="quiz-card">
  <p class="quiz-q">In spec-first API design, what's the very first artifact produced — before any server code is written?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The <code>openapi.yaml</code> contract itself, reviewed with stakeholders
    before implementation starts. Per the workflow, everything else — server
    stubs, client SDKs, published docs, contract tests — is generated
    <em>from</em> that spec afterward. Spec-first means the contract is the
    source of truth the code is derived from, not documentation written after
    the fact to describe code that already exists.
  </div>
</div>

---

## 14. Long-Running Operations

For operations that take > ~2 seconds (ML inference, report generation, bulk imports):

### Pattern: 202 Accepted + Poll

```bash
# 1. Submit job
POST /reports/generate
Content-Type: application/json
{"start_date": "2024-01-01", "end_date": "2024-12-31"}

# Response
HTTP/1.1 202 Accepted
Location: /operations/op_01HX4K2N3P

{
  "operation_id": "op_01HX4K2N3P",
  "status": "pending",
  "poll_url": "/operations/op_01HX4K2N3P"
}
```

```bash
# 2. Poll for status
GET /operations/op_01HX4K2N3P

# Still running
HTTP/1.1 200 OK
{ "status": "running", "progress": 42, "eta_seconds": 15 }

# Completed
HTTP/1.1 200 OK
{
  "status": "completed",
  "result_url": "/reports/report_abc123",
  "expires_at": "2024-02-01T00:00:00Z"
}

# Failed
HTTP/1.1 200 OK
{
  "status": "failed",
  "error": { "code": "PROCESSING_ERROR", "message": "Invalid date range" }
}
```

```bash
# 3. Fetch result
GET /reports/report_abc123
HTTP/1.1 200 OK
{ "data": [...] }
```

```mermaid
sequenceDiagram
    participant C as Client
    participant API as API
    participant W as Background worker

    C->>API: POST /reports/generate
    API->>W: enqueue job
    API-->>C: 202 Accepted, operation_id + poll_url

    loop poll with exponential backoff, 1s to 4s, capped at 30s
        C->>API: GET /operations/op_01HX4K2N3P
        API-->>C: 200 OK, status running, progress 42
    end

    W-->>API: job finishes
    C->>API: GET /operations/op_01HX4K2N3P
    API-->>C: 200 OK, status completed, result_url set
    C->>API: GET /reports/report_abc123
    API-->>C: 200 OK, report data
```

**Polling guidance:**
- Include `Retry-After` header on 202 to suggest poll interval
- Use exponential backoff for polling (1s → 2s → 4s → cap at 30s)
- Clean up operation records after TTL (24–48h)
- Return `303 See Other` + `Location` once done as an alternative to polling

<div class="quiz-card">
  <p class="quiz-q">The poll response for a failed job returns <code>HTTP/1.1 200 OK</code> with <code>{"status": "failed", "error": {...}}</code> in the body. Doesn't that contradict the earlier rule in this file that error responses should never be 200?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No — those are two different requests. The earlier rule is about the
    request that's actually failing (e.g. bad input) still returning 200
    instead of the correct 4xx/5xx. Here, the <code>GET /operations/{id}</code>
    call itself succeeded — the server correctly found and returned the
    operation resource, so 200 is exactly right for that HTTP exchange. The
    "failed" status is just data <em>inside</em> that successful response,
    describing the outcome of the underlying async job, not an error in the
    polling request. The job failing and the poll call failing are
    independent things.
  </div>
</div>

---

## 15. Webhook Design

Webhooks are server-to-server HTTP callbacks — your server calls the consumer's endpoint on events.

### Event Payload Structure

```json
{
  "id": "evt_01HX4K2N3P5Q",
  "type": "order.completed",
  "created_at": "2024-01-15T10:30:00Z",
  "api_version": "2024-01-01",
  "data": {
    "object": "order",
    "id": "ord_789",
    "status": "completed",
    "total": 99.99
  }
}
```

- Always include `id` (for deduplication), `type`, `created_at`
- Wrap actual payload in `data.object` — enables envelope evolution
- Include `api_version` — consumer can handle multiple versions

### Signature Verification (HMAC-SHA256)

```python
# Sender: sign the payload
import hmac, hashlib

def sign_payload(payload: bytes, secret: str) -> str:
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return f"sha256={sig}"

headers["X-Webhook-Signature"] = sign_payload(raw_body, webhook_secret)
headers["X-Webhook-Timestamp"] = str(int(time.time()))  # replay protection
```

```python
# Receiver: verify before processing
def verify_webhook(raw_body: bytes, signature: str, timestamp: str, secret: str):
    # 1. Reject stale events (replay protection)
    if abs(time.time() - int(timestamp)) > 300:  # 5 minute window
        raise ValueError("Webhook timestamp too old")

    # 2. Compute expected signature
    expected = sign_payload(raw_body, secret)

    # 3. Constant-time comparison (prevents timing attacks)
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Invalid signature")
```

### Retry with Exponential Backoff

Consumers must return 2xx within timeout (5–30s). On failure, sender retries:

```
Attempt 1:  immediate
Attempt 2:  5s delay
Attempt 3:  30s delay
Attempt 4:  5 min delay
Attempt 5:  30 min delay
Max attempts: 24h window, then mark as failed
```

```mermaid
sequenceDiagram
    participant S as Sender (your service)
    participant C as Consumer endpoint

    S->>C: POST webhook, attempt 1, immediate
    C--xS: no 2xx within timeout window
    Note over S: schedule retry, exponential backoff

    S->>C: POST webhook, attempt 2, 5s delay
    C--xS: still failing
    S->>C: POST webhook, attempt 3, 30s delay
    C--xS: still failing
    S->>C: POST webhook, attempt 4, 5 min delay
    C--xS: still failing
    S->>C: POST webhook, attempt 5, 30 min delay
    C-->>S: 2xx received, delivered

    rect rgb(65, 40, 40)
    Note over S,C: alternate ending, every attempt in the 24h window fails
    S->>S: mark event permanently failed, surface in dashboard or dead-letter queue
    end
```

Because delivery is retried on any non-2xx or timeout, the consumer may see
the exact same event more than once — which is exactly why the next section's
deduplication rule isn't optional.

### Delivery Guarantees

**At-least-once delivery** is standard (network failures cause retries → duplicates possible).

Consumer must be **idempotent**:
```python
def handle_webhook(event):
    # Deduplicate by event ID
    if db.exists(f"webhook:{event['id']}"):
        return  # already processed

    process_event(event)
    db.set(f"webhook:{event['id']}", ttl=7 * 86400)
```

### Consumer Best Practices

```python
# ✅ Respond 200 immediately, process async
def webhook_handler(request):
    verify_webhook(...)
    queue.enqueue(process_event, request.body)  # async
    return Response(status=200)  # fast ack
    # ❌ Don't do slow DB work synchronously — risk timeout → retry storm
```

**Webhook event types** should follow `resource.action` pattern:
```
order.created, order.updated, order.completed, order.cancelled
payment.succeeded, payment.failed
user.verified
```

<div class="quiz-card">
  <p class="quiz-q">A webhook consumer's database write succeeds, but the process crashes before it can return a 2xx response. What happens next, and how must the consumer be built to handle it safely?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The sender never saw a 2xx, so — per at-least-once delivery — it retries
    with exponential backoff, meaning the consumer will receive that exact
    same event again. Since the handler already applied the effect once, it
    must deduplicate by the event's <code>id</code> before processing (the
    <code>db.exists(...)</code> check in the handler) rather than assume
    every delivery is a first delivery. Skip that check and an
    already-applied side effect — like crediting an account or charging a
    card — gets applied twice.
  </div>
</div>

---

## Quick Reference

### Design Checklist

- [ ] Nouns in URLs, HTTP methods as verbs
- [ ] Consistent error format with `request_id`
- [ ] Correct status codes (no 200 with error body)
- [ ] Pagination on all list endpoints (cursor-based for feeds)
- [ ] Idempotency keys on POST/PATCH for non-idempotent operations
- [ ] Rate limit headers on all responses
- [ ] API versioned from day one
- [ ] OpenAPI spec committed alongside code
- [ ] Auth checked at gateway before reaching services
- [ ] No stack traces / internals in error responses
- [ ] Webhooks: HMAC signature, idempotent consumer, async ack

### Status Code Decision Tree

```mermaid
graph TD
    classDef decision fill:#34495e,stroke:#22303e,color:#fff,rx:6
    classDef clienterr fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef servererr fill:#e74c3c,stroke:#c0392b,color:#fff,rx:6
    classDef success fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    START["Request received"]:::decision --> BAD{"Client sent bad data?"}:::decision

    BAD -->|"Missing / malformed syntax"| C400["400 Bad Request"]:::clienterr
    BAD -->|"Not authenticated"| C401["401 Unauthorized"]:::clienterr
    BAD -->|"Authenticated, no permission"| C403["403 Forbidden"]:::clienterr
    BAD -->|"Resource doesn't exist"| C404["404 Not Found"]:::clienterr
    BAD -->|"Duplicate resource"| C409["409 Conflict"]:::clienterr
    BAD -->|"Semantic validation fail"| C422["422 Unprocessable Entity"]:::clienterr
    BAD -->|"Rate limited"| C429["429 Too Many Requests"]:::clienterr
    BAD -->|"No"| SERR{"Server error?"}:::decision

    SERR -->|"Unexpected crash"| C500["500 Internal Server Error"]:::servererr
    SERR -->|"Upstream bad response"| C502["502 Bad Gateway"]:::servererr
    SERR -->|"Server overloaded"| C503["503 Service Unavailable"]:::servererr
    SERR -->|"Upstream timeout"| C504["504 Gateway Timeout"]:::servererr
    SERR -->|"No — success"| OK{"Success type?"}:::decision

    OK -->|"GET / no async"| C200["200 OK"]:::success
    OK -->|"POST created resource"| C201["201 Created"]:::success
    OK -->|"Accepted, processing"| C202["202 Accepted"]:::success
    OK -->|"Success, no body"| C204["204 No Content"]:::success
```
