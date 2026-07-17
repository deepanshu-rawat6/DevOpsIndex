# Rate Limiter Implementations (Go)

Four algorithms from scratch — see [system-design/rate-limiting.md](../system-design/rate-limiting.md) for the conceptual/distributed-systems treatment. This file is the from-scratch, single-process, interview-whiteboard version of each, plus an HTTP middleware wrapper.

---

## 1. Token Bucket

Bucket refills continuously at `rate` tokens/sec up to `capacity`; each request consumes 1 token.

```go
package ratelimit

import (
	"sync"
	"time"
)

// TokenBucket allows bursts up to capacity, then throttles to the refill rate.
type TokenBucket struct {
	mu         sync.Mutex
	capacity   float64
	tokens     float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

func NewTokenBucket(capacity float64, refillRate float64) *TokenBucket {
	return &TokenBucket{
		capacity:   capacity,
		tokens:     capacity, // start full
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

// Allow reports whether a single request may proceed right now.
func (b *TokenBucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens = min(b.capacity, b.tokens+elapsed*b.refillRate)
	b.lastRefill = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
```

---

## 2. Leaky Bucket

Requests join a fixed-size queue; a background process drains (processes) at a fixed rate regardless of arrival rate. Shapes bursts into uniform output instead of passing them through.

```go
package ratelimit

import (
	"sync"
	"time"
)

// LeakyBucket queues requests and lets them "leak" out at a fixed rate.
// Unlike TokenBucket, it smooths bursts rather than passing them through.
type LeakyBucket struct {
	mu       sync.Mutex
	capacity int           // max queued requests
	queue    int           // current queue depth
	leakRate time.Duration // time between each leak (1 request drained)
	lastLeak time.Time
}

func NewLeakyBucket(capacity int, leakRate time.Duration) *LeakyBucket {
	return &LeakyBucket{
		capacity: capacity,
		leakRate: leakRate,
		lastLeak: time.Now(),
	}
}

// Allow reports whether the request can be queued (accepted into the bucket).
// It does NOT mean the request is processed immediately — only that it was
// admitted to the queue for eventual draining at leakRate.
func (b *LeakyBucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.drain(time.Now())

	if b.queue >= b.capacity {
		return false // queue full, reject
	}
	b.queue++
	return true
}

// drain removes completed "leaks" based on elapsed time since lastLeak.
func (b *LeakyBucket) drain(now time.Time) {
	elapsed := now.Sub(b.lastLeak)
	leaked := int(elapsed / b.leakRate)
	if leaked <= 0 {
		return
	}
	if leaked > b.queue {
		leaked = b.queue
	}
	b.queue -= leaked
	b.lastLeak = b.lastLeak.Add(time.Duration(leaked) * b.leakRate)
}
```

---

## 3. Fixed Window Counter

Simplest algorithm. Counts requests in discrete, non-overlapping time windows. Vulnerable to a 2x burst at window boundaries (see comparison table).

```go
package ratelimit

import (
	"sync"
	"time"
)

// FixedWindow counts requests per discrete time window.
type FixedWindow struct {
	mu          sync.Mutex
	limit       int
	windowSize  time.Duration
	windowStart time.Time
	count       int
}

func NewFixedWindow(limit int, windowSize time.Duration) *FixedWindow {
	return &FixedWindow{
		limit:       limit,
		windowSize:  windowSize,
		windowStart: time.Now(),
	}
}

func (w *FixedWindow) Allow() bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	now := time.Now()
	if now.Sub(w.windowStart) >= w.windowSize {
		// New window: reset counter and boundary.
		w.windowStart = now
		w.count = 0
	}

	if w.count >= w.limit {
		return false
	}
	w.count++
	return true
}
```

---

## 4. Sliding Window Log

Stores the timestamp of every accepted request; on each check, prunes timestamps older than `now - window` and counts what remains. Exact accuracy, O(n) memory per key.

```go
package ratelimit

import (
	"sync"
	"time"
)

// SlidingWindowLog is exact (no boundary burst) but stores one timestamp
// per request within the window — memory scales with request volume.
type SlidingWindowLog struct {
	mu         sync.Mutex
	limit      int
	windowSize time.Duration
	timestamps []time.Time
}

func NewSlidingWindowLog(limit int, windowSize time.Duration) *SlidingWindowLog {
	return &SlidingWindowLog{
		limit:      limit,
		windowSize: windowSize,
		timestamps: make([]time.Time, 0, limit),
	}
}

func (s *SlidingWindowLog) Allow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-s.windowSize)

	s.timestamps = pruneBefore(s.timestamps, cutoff)

	if len(s.timestamps) >= s.limit {
		return false
	}
	s.timestamps = append(s.timestamps, now)
	return true
}

// pruneBefore drops timestamps older than cutoff. Timestamps are appended
// in increasing order, so the surviving slice is always a suffix — this
// is O(k) where k is the number of expired entries, not a full O(n) scan
// with allocation per call.
func pruneBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && ts[i].Before(cutoff) {
		i++
	}
	return ts[i:]
}
```

---

## Comparison Table

| Algorithm | Memory | Accuracy | Burst handling | Best for |
|---|---|---|---|---|
| Token bucket | O(1) per key | High | Allows bursts up to `capacity`, then throttles to `rate` | API gateways, general-purpose default |
| Leaky bucket | O(1) per key (just a counter, not a real queue in this impl) | High | Smooths bursts to a uniform output rate — no burst passes through | Traffic shaping, protecting a fixed-capacity downstream (e.g. a DB) |
| Fixed window | O(1) per key | Low | Up to 2x limit can pass across a window boundary | Simple, non-critical counters where boundary burst is tolerable |
| Sliding window log | O(n) per key (n = requests in window) | Exact | None — hard cutoff, no boundary effect | Low-volume, high-precision limits (e.g. audit-sensitive admin APIs) |

---

## HTTP Middleware Wrapper

Any of the four implementations satisfy the same `Limiter` interface, so the middleware is decoupled from the algorithm choice.

```go
package ratelimit

import "net/http"

// Limiter is satisfied by TokenBucket, LeakyBucket, FixedWindow, and
// SlidingWindowLog — any algorithm above can be plugged into Middleware.
type Limiter interface {
	Allow() bool
}

// Middleware wraps an http.Handler, rejecting requests with 429 when the
// underlying Limiter denies them. In production this would key limiters
// per-client (see PerClientMiddleware below) rather than share one global
// limiter across all traffic.
func Middleware(limiter Limiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow() {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "429 Too Many Requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

### Per-client variant (keyed by IP or API key)

```go
package ratelimit

import (
	"net"
	"net/http"
	"sync"
)

// PerClientMiddleware maintains one Limiter per client key (e.g. IP address),
// lazily created on first request. limiterFactory lets the caller choose
// which of the four algorithms to instantiate per client.
type PerClientMiddleware struct {
	mu             sync.Mutex
	limiters       map[string]Limiter
	limiterFactory func() Limiter
}

func NewPerClientMiddleware(factory func() Limiter) *PerClientMiddleware {
	return &PerClientMiddleware{
		limiters:       make(map[string]Limiter),
		limiterFactory: factory,
	}
}

func (m *PerClientMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := clientKey(r)

		m.mu.Lock()
		limiter, ok := m.limiters[key]
		if !ok {
			limiter = m.limiterFactory()
			m.limiters[key] = limiter
		}
		m.mu.Unlock()

		if !limiter.Allow() {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "429 Too Many Requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Example wiring:
//
//   mw := NewPerClientMiddleware(func() Limiter {
//       return NewTokenBucket(20, 5) // burst 20, refill 5/sec, per client
//   })
//   http.Handle("/api/", mw.Wrap(apiHandler))
//   http.ListenAndServe(":8080", nil)
//
// Note: limiters map above grows unbounded as new clients appear — a
// production version needs an eviction policy (e.g. LRU from lru-cache.md,
// or a TTL sweep) to bound memory under a churn of unique client keys.
```
