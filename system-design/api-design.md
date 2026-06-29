# API Design

Production-focused reference for REST, versioning, pagination, idempotency, and API gateways.

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

---

## 6. Pagination Strategies

### Offset / Limit (simple)
```
GET /posts?offset=40&limit=20
```
```json
{
  "data": [...],
  "total": 1000,
  "offset": 40,
  "limit": 20
}
```
- ✅ Easy to implement, jump to any page
- ❌ **Drift problem**: if a row is inserted/deleted between requests, you get duplicates or skip items
- ❌ `OFFSET N` in SQL scans and discards N rows — slow for large N

### Cursor-Based Pagination (stable, recommended)
```
GET /posts?cursor=eyJpZCI6MTAwfQ&limit=20
```
```json
{
  "data": [...],
  "next_cursor": "eyJpZCI6MTIwfQ",
  "has_more": true
}
```
Cursor is typically a base64-encoded opaque value (e.g., `{"id": 100, "created_at": "..."}`).

```sql
-- Server decodes cursor and queries:
SELECT * FROM posts WHERE id > 100 ORDER BY id LIMIT 20;
```
- ✅ Stable (inserts/deletes don't affect position)
- ✅ O(1) with index — no offset scan
- ❌ Can't jump to arbitrary page
- ❌ Client must treat cursor as opaque

### Keyset Pagination (variant of cursor)
```
GET /posts?after_id=100&limit=20
# or for multi-column sort:
GET /events?after_created_at=2024-01-15T10:00:00Z&after_id=500&limit=20
```
- Same benefits as cursor-based, but uses explicit fields instead of encoded token
- Requires composite index on sort columns

### Comparison

| Strategy | Jump to page | Stable | Large offsets | Complexity |
|---|---|---|---|---|
| Offset/Limit | ✅ | ❌ | ❌ slow | Low |
| Cursor-based | ❌ | ✅ | ✅ | Medium |
| Keyset | ❌ | ✅ | ✅ | Medium |

Use **offset** for admin UIs with small datasets. Use **cursor/keyset** for feeds, infinite scroll, APIs.

---

## 7. Idempotency Keys

POST and PATCH are not idempotent by default — retrying on network failure creates duplicates.

### Flow

```
Client                          Server
  │                               │
  │  POST /payments               │
  │  Idempotency-Key: uuid-1234   │
  │──────────────────────────────>│
  │                               │  1. Check store: key unknown
  │                               │  2. Process payment
  │                               │  3. Store {uuid-1234 → response} TTL 24h
  │<──────────────────────────────│
  │  201 Created                  │
  │                               │
  │  [network error, retry]       │
  │                               │
  │  POST /payments               │
  │  Idempotency-Key: uuid-1234   │
  │──────────────────────────────>│
  │                               │  1. Check store: key EXISTS
  │                               │  2. Return cached response
  │<──────────────────────────────│
  │  201 Created (replayed)       │
```

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

---

## 9. API Gateway Pattern

Single entry point for all client requests. Handles cross-cutting concerns so services don't have to.

```
Client
  │
  ▼
┌─────────────────────────────────────────┐
│              API Gateway                │
│  ┌─────────────────────────────────┐   │
│  │ Auth → Rate Limit → Route →     │   │
│  │ Transform → Log → Circuit Break │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
  │         │         │         │
  ▼         ▼         ▼         ▼
Users    Orders   Products   Payments
Service  Service  Service    Service
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

**Polling guidance:**
- Include `Retry-After` header on 202 to suggest poll interval
- Use exponential backoff for polling (1s → 2s → 4s → cap at 30s)
- Clean up operation records after TTL (24–48h)
- Return `303 See Other` + `Location` once done as an alternative to polling

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

```
Request received
├── Client sent bad data?
│   ├── Missing/malformed syntax → 400
│   ├── Not authenticated       → 401
│   ├── Authenticated, no perm  → 403
│   ├── Resource doesn't exist  → 404
│   ├── Duplicate resource      → 409
│   ├── Semantic validation fail→ 422
│   └── Rate limited            → 429
├── Server error?
│   ├── Unexpected crash        → 500
│   ├── Upstream bad response   → 502
│   ├── Server overloaded       → 503
│   └── Upstream timeout        → 504
└── Success
    ├── GET / no async          → 200
    ├── POST created resource   → 201
    ├── Accepted, processing    → 202
    └── Success, no body        → 204
```
