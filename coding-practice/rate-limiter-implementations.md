# Rate Limiter Implementations (Go & Python)

Four algorithms from scratch — see [system-design/rate-limiting.md](../system-design/rate-limiting.md) for the conceptual/distributed-systems treatment. This file is the from-scratch, single-process, interview-whiteboard version of each, in both Go and Python, plus an HTTP middleware wrapper.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Token Bucket

Bucket refills continuously at `rate` tokens/sec up to `capacity`; each request consumes 1 token.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="tb-go" class="active">Go</button>
    <button data-tab="tb-py">Python</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="tb-go">
      <pre><code class="language-go">package ratelimit
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
	return &amp;TokenBucket{
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
	if b.tokens &lt; 1 {
		return false
	}
	b.tokens--
	return true
}
func min(a, b float64) float64 {
	if a &lt; b {
		return a
	}
	return b
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="tb-py">
      <pre><code class="language-python">import threading
import time
class TokenBucket:
    """Allows bursts up to capacity, then throttles to the refill rate."""
    def __init__(self, capacity: float, refill_rate: float) -&gt; None:
        self._lock = threading.Lock()
        self.capacity = capacity
        self.tokens = capacity  # start full
        self.refill_rate = refill_rate  # tokens per second
        self.last_refill = time.monotonic()
    def allow(self) -&gt; bool:
        """Return True if a single request may proceed right now."""
        with self._lock:
            now = time.monotonic()
            elapsed = now - self.last_refill
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
            self.last_refill = now
            if self.tokens &lt; 1:
                return False
            self.tokens -= 1
            return True
# asyncio variant: swap threading.Lock for asyncio.Lock and `allow` for an
# async def if callers are already inside an event loop instead of threads --
# the refill math is identical, only the mutual-exclusion primitive changes.</code></pre>
    </div>
  </div>
</div>

Every `Allow()` call does two things in order — refill based on elapsed time, then check-and-consume:

```mermaid
graph TD
    classDef step fill:#3498db,stroke:#2471a3,color:#fff
    classDef ok fill:#27ae60,stroke:#1e8449,color:#fff
    classDef bad fill:#e74c3c,stroke:#c0392b,color:#fff

    A["Request arrives"] --> B["Refill: tokens = min(capacity, tokens + elapsed * rate)"]:::step
    B --> C{"tokens >= 1?"}
    C -->|"yes"| D["tokens -= 1, allow request"]:::ok
    C -->|"no"| E["reject request (429)"]:::bad
```

<div class="quiz-card">
  <p class="quiz-q">A client that's been idle for a while sends 10 requests in the same instant against a bucket with capacity 5. How many get through, and why not more or fewer?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>5 get through. The bucket refills continuously up to <code>capacity</code>, so an idle client accumulates a full bucket — capacity 5 means at most 5 tokens can ever be sitting there waiting, no matter how long it's been idle. The first 5 requests each consume 1 token and succeed; by the 6th, <code>tokens &lt; 1</code> and <code>Allow()</code> returns false. This is exactly the "allows bursts up to capacity, then throttles to the refill rate" behavior described above.</div>
</div>

### Burst Scenario, Step by Step

A bucket with `capacity=5`, `refill_rate=1` token/sec, starting full, hit by a burst of 7 requests arriving back-to-back (elapsed time ≈ 0 between them):

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Start.</strong> Bucket is full: <code>tokens = 5.00</code> (capacity 5, refill rate 1/sec). No requests yet.
    </div>
    <div class="stepper-panel">
      <strong>2. Request #1 arrives.</strong> Refill adds ~0 tokens (elapsed ≈ 0). <code>tokens = 5.00 &gt;= 1</code> → allowed. <code>tokens</code> drops to <strong>4.00</strong>.
    </div>
    <div class="stepper-panel">
      <strong>3. Request #2.</strong> <code>tokens = 4.00 &gt;= 1</code> → allowed. <code>tokens</code> drops to <strong>3.00</strong>.
    </div>
    <div class="stepper-panel">
      <strong>4. Request #3.</strong> <code>tokens = 3.00 &gt;= 1</code> → allowed. <code>tokens</code> drops to <strong>2.00</strong>.
    </div>
    <div class="stepper-panel">
      <strong>5. Request #4.</strong> <code>tokens = 2.00 &gt;= 1</code> → allowed. <code>tokens</code> drops to <strong>1.00</strong>.
    </div>
    <div class="stepper-panel">
      <strong>6. Request #5.</strong> <code>tokens = 1.00 &gt;= 1</code> → allowed. <code>tokens</code> drops to <strong>0.00</strong>. The whole burst allowance (capacity 5) is now spent.
    </div>
    <div class="stepper-panel">
      <strong>7. Request #6 — REJECTED.</strong> <code>tokens = 0.00 &lt; 1</code> → <code>Allow()</code> returns false, client gets a 429. No headroom left this instant.
    </div>
    <div class="stepper-panel">
      <strong>8. One second later, request #7 arrives.</strong> Refill adds <code>elapsed * rate = 1 * 1 = 1.00</code> token → <code>tokens = 1.00 &gt;= 1</code> → allowed. <code>tokens</code> drops back to <strong>0.00</strong>. The client is now fully throttled to the 1/sec refill rate — it can send exactly one more request per second, no more bursting until it goes idle long enough to refill.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

---

## 2. Leaky Bucket

Requests join a fixed-size queue; a background process drains (processes) at a fixed rate regardless of arrival rate. Shapes bursts into uniform output instead of passing them through.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="lb-go" class="active">Go</button>
    <button data-tab="lb-py">Python</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="lb-go">
      <pre><code class="language-go">package ratelimit
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
	return &amp;LeakyBucket{
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
	if b.queue &gt;= b.capacity {
		return false // queue full, reject
	}
	b.queue++
	return true
}
// drain removes completed "leaks" based on elapsed time since lastLeak.
func (b *LeakyBucket) drain(now time.Time) {
	elapsed := now.Sub(b.lastLeak)
	leaked := int(elapsed / b.leakRate)
	if leaked &lt;= 0 {
		return
	}
	if leaked &gt; b.queue {
		leaked = b.queue
	}
	b.queue -= leaked
	b.lastLeak = b.lastLeak.Add(time.Duration(leaked) * b.leakRate)
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="lb-py">
      <pre><code class="language-python">import threading
import time
class LeakyBucket:
    """Queues requests and lets them "leak" out at a fixed rate.
    Unlike TokenBucket, it smooths bursts rather than passing them through.
    """
    def __init__(self, capacity: int, leak_rate: float) -&gt; None:
        """leak_rate: seconds between each leak (1 request drained)."""
        self._lock = threading.Lock()
        self.capacity = capacity
        self.queue = 0  # current queue depth
        self.leak_rate = leak_rate
        self.last_leak = time.monotonic()
    def allow(self) -&gt; bool:
        """Return True if the request can be queued (admitted to the bucket).
        Does NOT mean the request is processed immediately -- only that it
        was admitted to the queue for eventual draining at leak_rate.
        """
        with self._lock:
            self._drain(time.monotonic())
            if self.queue &gt;= self.capacity:
                return False  # queue full, reject
            self.queue += 1
            return True
    def _drain(self, now: float) -&gt; None:
        """Remove completed "leaks" based on elapsed time since last_leak."""
        elapsed = now - self.last_leak
        leaked = int(elapsed / self.leak_rate)
        if leaked &lt;= 0:
            return
        leaked = min(leaked, self.queue)
        self.queue -= leaked
        self.last_leak += leaked * self.leak_rate</code></pre>
    </div>
  </div>
</div>

Admission and draining are two separate concerns — a request can be *queued* immediately while still being *processed* much later, smoothly:

```mermaid
graph TD
    classDef step fill:#3498db,stroke:#2471a3,color:#fff
    classDef ok fill:#27ae60,stroke:#1e8449,color:#fff
    classDef bad fill:#e74c3c,stroke:#c0392b,color:#fff

    A["Request arrives"] --> B["Drain: leaked = elapsed / leakRate, queue -= leaked"]:::step
    B --> C{"queue < capacity?"}
    C -->|"yes"| D["queue += 1, request admitted"]:::ok
    C -->|"no"| E["queue full, reject (429)"]:::bad
    D --> F["Background drain keeps releasing<br/>one request at a time, at leakRate"]:::step
```

<div class="quiz-card">
  <p class="quiz-q">Both token bucket and leaky bucket can "allow" a burst of requests into the system. What's different about what happens to that burst afterward?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Token bucket lets an accepted burst through to the caller immediately, as fast as it arrives, up to the bucket's capacity — then throttles once tokens run out. Leaky bucket never passes a burst straight through at all: <code>Allow()</code> only admits the request into the queue, it does "NOT mean the request is processed immediately" — a background drain releases queued requests one at a time at a fixed <code>leakRate</code>, so the output rate is always uniform regardless of how bursty the arrivals were.</div>
</div>

---

## 3. Fixed Window Counter

Simplest algorithm. Counts requests in discrete, non-overlapping time windows. Vulnerable to a 2x burst at window boundaries (see comparison table).

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="fw-go" class="active">Go</button>
    <button data-tab="fw-py">Python</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="fw-go">
      <pre><code class="language-go">package ratelimit
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
	return &amp;FixedWindow{
		limit:       limit,
		windowSize:  windowSize,
		windowStart: time.Now(),
	}
}
func (w *FixedWindow) Allow() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	if now.Sub(w.windowStart) &gt;= w.windowSize {
		// New window: reset counter and boundary.
		w.windowStart = now
		w.count = 0
	}
	if w.count &gt;= w.limit {
		return false
	}
	w.count++
	return true
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="fw-py">
      <pre><code class="language-python">import threading
import time
class FixedWindow:
    """Counts requests per discrete time window."""
    def __init__(self, limit: int, window_size: float) -&gt; None:
        self._lock = threading.Lock()
        self.limit = limit
        self.window_size = window_size
        self.window_start = time.monotonic()
        self.count = 0
    def allow(self) -&gt; bool:
        with self._lock:
            now = time.monotonic()
            if now - self.window_start &gt;= self.window_size:
                # New window: reset counter and boundary.
                self.window_start = now
                self.count = 0
            if self.count &gt;= self.limit:
                return False
            self.count += 1
            return True</code></pre>
    </div>
  </div>
</div>

The boundary problem: each window resets its counter independently, so a burst timed right around the edge can slip two windows' worth of traffic past in a much shorter span than `windowSize`:

```mermaid
graph LR
    classDef window fill:#3498db,stroke:#2471a3,color:#fff
    classDef burst fill:#e74c3c,stroke:#c0392b,color:#fff

    subgraph W1["Window 1 -- count resets to 0 at windowStart, climbs to the limit"]
        R1["requests trickle in all window,<br/>count reaches limit right at the end"]:::window
    end
    subgraph W2["Window 2 -- new windowStart, count resets to 0 again"]
        R2["counter starts over at 0,<br/>even though W1 just ended at the limit"]:::window
    end
    B["Requests clustered right at the boundary can<br/>land close to 2x the limit in a short span"]:::burst
    R1 -->|"last requests of W1, just before the boundary"| B
    R2 -->|"first requests of W2, just after the boundary"| B
```

<div class="quiz-card">
  <p class="quiz-q">Fixed window's own limitation is called out as "vulnerable to a 2x burst at window boundaries." Why 2x specifically, rather than 3x or some unbounded multiple?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because <code>count</code> resets to 0 at each new <code>windowStart</code>, the worst case is a client spending its full <code>limit</code> right at the very end of one window, then immediately spending a full new <code>limit</code> right at the start of the next window — two windows' worth of allowance (2x limit), compressed into a span much shorter than <code>windowSize</code>. It can't exceed 2x because only two windows' counters are ever adjacent to any single point in time; a third window's allowance is never reachable within that same short burst.</div>
</div>

---

## 4. Sliding Window Log

Stores the timestamp of every accepted request; on each check, prunes timestamps older than `now - window` and counts what remains. Exact accuracy, O(n) memory per key.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="swl-go" class="active">Go</button>
    <button data-tab="swl-py">Python</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="swl-go">
      <pre><code class="language-go">package ratelimit
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
	return &amp;SlidingWindowLog{
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
	if len(s.timestamps) &gt;= s.limit {
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
	for i &lt; len(ts) &amp;&amp; ts[i].Before(cutoff) {
		i++
	}
	return ts[i:]
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="swl-py">
      <pre><code class="language-python">import threading
import time
from collections import deque
class SlidingWindowLog:
    """Exact (no boundary burst) but stores one timestamp per request
    within the window -- memory scales with request volume.
    """
    def __init__(self, limit: int, window_size: float) -&gt; None:
        self._lock = threading.Lock()
        self.limit = limit
        self.window_size = window_size
        self.timestamps: deque[float] = deque()
    def allow(self) -&gt; bool:
        with self._lock:
            now = time.monotonic()
            cutoff = now - self.window_size
            self._prune_before(cutoff)
            if len(self.timestamps) &gt;= self.limit:
                return False
            self.timestamps.append(now)
            return True
    def _prune_before(self, cutoff: float) -&gt; None:
        """Drop timestamps older than cutoff.
        Timestamps are appended in increasing order, so the surviving
        entries are always a suffix -- popleft() from a deque is O(1) per
        expired entry, not a full O(n) rebuild with allocation per call.
        """
        while self.timestamps and self.timestamps[0] &lt; cutoff:
            self.timestamps.popleft()</code></pre>
    </div>
  </div>
</div>

No reset boundary at all — the window continuously slides with `now`, so every check re-evaluates the true count of requests in the trailing `windowSize` interval:

```mermaid
graph TD
    classDef step fill:#3498db,stroke:#2471a3,color:#fff
    classDef ok fill:#27ae60,stroke:#1e8449,color:#fff
    classDef bad fill:#e74c3c,stroke:#c0392b,color:#fff

    A["Request arrives at time now"] --> B["cutoff = now - windowSize"]:::step
    B --> C["Prune: drop every stored timestamp older than cutoff"]:::step
    C --> D{"len(timestamps) < limit?"}
    D -->|"yes"| E["append now, allow request"]:::ok
    D -->|"no"| F["reject request (429)"]:::bad
```

<div class="quiz-card">
  <p class="quiz-q">Sliding window log is described as "exact accuracy, O(n) memory per key." What does the "n" actually count, and why does that make it a bad fit for a high-volume key?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>"n" is one timestamp stored per accepted request still inside the current window — the implementation literally keeps a <code>timestamps</code> slice/deque with one entry per request. There's no boundary-reset trick and no counter approximation, which is exactly why it's exact: it always knows the true count in the trailing window. But that same design means memory scales directly with request volume rather than staying O(1) like the other three algorithms — a high-volume key accumulates a correspondingly large number of live timestamp entries at any moment.</div>
</div>

---

## Comparison Table

| Algorithm | Memory | Accuracy | Burst handling | Best for |
|---|---|---|---|---|
| Token bucket | O(1) per key | High | Allows bursts up to `capacity`, then throttles to `rate` | API gateways, general-purpose default |
| Leaky bucket | O(1) per key (just a counter, not a real queue in this impl) | High | Smooths bursts to a uniform output rate — no burst passes through | Traffic shaping, protecting a fixed-capacity downstream (e.g. a DB) |
| Fixed window | O(1) per key | Low | Up to 2x limit can pass across a window boundary | Simple, non-critical counters where boundary burst is tolerable |
| Sliding window log | O(n) per key (n = requests in window) | Exact | None — hard cutoff, no boundary effect | Low-volume, high-precision limits (e.g. audit-sensitive admin APIs) |

<div class="quiz-card">
  <p class="quiz-q">Same burst of requests, same instant, hits all four implementations above with equivalent limits. Which ones let the burst through immediately, and which one(s) don't?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Token bucket and fixed window both let a burst through immediately — token bucket up to whatever's accumulated in the bucket (capacity), fixed window up to whatever's left of the current window's count (and, at a boundary, up to nearly 2x limit). Sliding window log also admits requests immediately but with a hard, exact cutoff at the true limit — no boundary bonus. Leaky bucket is the odd one out: <code>Allow()</code> only queues a request, it explicitly does not mean the request is processed immediately — the background drain still releases it at the fixed <code>leakRate</code>, so the burst never actually passes through to the downstream system faster than that rate.</div>
</div>

---

## HTTP Middleware Wrapper

Any of the four implementations satisfy the same `Limiter` interface, so the middleware is decoupled from the algorithm choice.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="mw-go" class="active">Go</button>
    <button data-tab="mw-py">Python</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="mw-go">
      <pre><code class="language-go">package ratelimit
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
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="mw-py">
      <pre><code class="language-python">from typing import Callable, Protocol
class Limiter(Protocol):
    """Satisfied by TokenBucket, LeakyBucket, FixedWindow, and
    SlidingWindowLog -- any algorithm above can be plugged into the
    middleware below.
    """
    def allow(self) -&gt; bool: ...
def rate_limit_middleware(limiter: Limiter, app: Callable) -&gt; Callable:
    """WSGI middleware: reject requests with 429 when the underlying
    Limiter denies them.
    In production this would key limiters per-client (see
    PerClientMiddleware below) rather than share one global limiter
    across all traffic.
    """
    def wrapped_app(environ, start_response):
        if not limiter.allow():
            start_response(
                "429 Too Many Requests",
                [("Content-Type", "text/plain"), ("Retry-After", "1")],
            )
            return [b"429 Too Many Requests"]
        return app(environ, start_response)
    return wrapped_app
# Flask equivalent, same decision, different plumbing:
#
#   @app.before_request
#   def check_rate_limit():
#       if not limiter.allow():
#           resp = make_response("429 Too Many Requests", 429)
#           resp.headers["Retry-After"] = "1"
#           return resp</code></pre>
    </div>
  </div>
</div>

### Per-client variant (keyed by IP or API key)

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="pc-go" class="active">Go</button>
    <button data-tab="pc-py">Python</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="pc-go">
      <pre><code class="language-go">package ratelimit
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
	return &amp;PerClientMiddleware{
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
// or a TTL sweep) to bound memory under a churn of unique client keys.</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="pc-py">
      <pre><code class="language-python">import threading
from typing import Callable, Dict
class PerClientMiddleware:
    """Maintains one Limiter per client key (e.g. IP address), lazily
    created on first request. limiter_factory lets the caller choose
    which of the four algorithms to instantiate per client.
    """
    def __init__(self, limiter_factory: Callable[[], "Limiter"]) -&gt; None:
        self._lock = threading.Lock()
        self.limiters: Dict[str, "Limiter"] = {}
        self.limiter_factory = limiter_factory
    def wrap(self, app: Callable) -&gt; Callable:
        def wrapped_app(environ, start_response):
            key = self._client_key(environ)
            with self._lock:
                limiter = self.limiters.get(key)
                if limiter is None:
                    limiter = self.limiter_factory()
                    self.limiters[key] = limiter
            if not limiter.allow():
                start_response(
                    "429 Too Many Requests",
                    [("Content-Type", "text/plain"), ("Retry-After", "1")],
                )
                return [b"429 Too Many Requests"]
            return app(environ, start_response)
        return wrapped_app
    @staticmethod
    def _client_key(environ) -&gt; str:
        return environ.get("REMOTE_ADDR", "unknown")
# Example wiring:
#
#   mw = PerClientMiddleware(lambda: TokenBucket(capacity=20, refill_rate=5))
#   app = mw.wrap(api_handler)  # burst 20, refill 5/sec, per client
#
# Note: limiters dict above grows unbounded as new clients appear -- a
# production version needs an eviction policy (e.g. LRU from lru-cache.md,
# or a TTL sweep) to bound memory under a churn of unique client keys.</code></pre>
    </div>
  </div>
</div>

