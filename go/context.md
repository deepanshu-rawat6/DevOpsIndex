# Go context.Context — Cancellation, Deadlines, and Propagation

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Context Tree / Propagation Model

Every `context.Context` is derived from a parent — cancelling a parent cancels every descendant. There is no way to cancel "upward" or affect siblings.

```mermaid
flowchart TB
    BG["context.Background()<br/>root, never cancelled"]
    REQ["ctx1 = WithTimeout(bg, 5s)<br/>e.g. HTTP request"]
    DB["ctx2 = WithCancel(ctx1)<br/>DB query goroutine"]
    CACHE["ctx3 = WithCancel(ctx1)<br/>cache lookup goroutine"]
    RETRY["ctx4 = WithTimeout(ctx2, 1s)<br/>single DB retry attempt"]

    BG --> REQ
    REQ --> DB
    REQ --> CACHE
    DB --> RETRY
```

**Propagation rules:**
- Cancelling `ctx1` (timeout fires, or explicit cancel) cancels `ctx2`, `ctx3`, `ctx4` — the entire subtree.
- Cancelling `ctx2` cancels `ctx4` but does **not** affect `ctx3` (sibling) or `ctx1` (parent).
- A child's deadline is capped by its parent's — `WithTimeout(ctx1, 10s)` where `ctx1` already has a 5s deadline still fires at 5s, not 10s.
- Values set with `context.WithValue` are visible to all descendants, never to parents or siblings.

```go
bg := context.Background()
ctx1, cancel1 := context.WithTimeout(bg, 5*time.Second)
defer cancel1()

ctx2, cancel2 := context.WithCancel(ctx1)
defer cancel2()

cancel1() // cancels ctx1 AND ctx2 (and any children of ctx2)
<-ctx2.Done()
fmt.Println(ctx2.Err()) // context.Canceled — inherited from parent
```

<div class="quiz-card">
  <p class="quiz-q">What happens to child contexts when a parent context is cancelled — and can a child's cancellation propagate upward to the parent?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>When a parent context is cancelled (by explicit <code>cancel()</code>, timeout, or deadline), the Go runtime closes the Done channel on <em>every</em> descendant in the subtree — children, grandchildren, etc. — simultaneously. This cascade is automatic and does not require any action from the child. However, cancellation is strictly one-directional: cancelling a child has <em>no</em> effect on its parent or any sibling contexts. A child's deadline is also capped by its parent's — a <code>WithTimeout(parent, 10s)</code> where <code>parent</code> already has a 5s deadline will fire at 5s, not 10s.</div>
</div>

---

## WithCancel / WithTimeout / WithDeadline

| Function | Cancels when | `Err()` after firing | Use when |
|----------|--------------|------------------------|----------|
| `WithCancel(parent)` | `cancel()` called explicitly | `context.Canceled` | You control the cancellation trigger (user action, first-error-wins, shutdown signal) |
| `WithTimeout(parent, d)` | `d` elapses, or `cancel()` called early | `context.DeadlineExceeded` (or `Canceled` if cancelled early) | You know a relative max duration ("this call gets 3s") |
| `WithDeadline(parent, t)` | wall-clock time `t` is reached, or `cancel()` called early | `context.DeadlineExceeded` (or `Canceled` if cancelled early) | You know an absolute point in time (e.g., "must finish before the client's own deadline") |

`WithTimeout(parent, d)` is implemented as `WithDeadline(parent, time.Now().Add(d))` — identical mechanics, different ergonomics.

```go
// WithCancel — manual trigger
ctx, cancel := context.WithCancel(context.Background())
go func() {
    if userClickedStop() {
        cancel()
    }
}()

// WithTimeout — relative duration
ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
defer cancel() // ALWAYS defer cancel, even if the timeout fires naturally — releases timer resources

// WithDeadline — absolute time (e.g. propagate an upstream deadline)
deadline := time.Now().Add(500 * time.Millisecond)
ctx, cancel := context.WithDeadline(context.Background(), deadline)
defer cancel()
```

**Always call `cancel()`, even on success.** Every `WithCancel`/`WithTimeout`/`WithDeadline` starts an internal goroutine or timer that only stops when `cancel()` runs or the parent is cancelled — skipping `defer cancel()` leaks that resource until the parent context (possibly `Background()`, i.e. never) is cancelled.

<div class="quiz-card">
  <p class="quiz-q">What is the difference between <code>context.WithTimeout</code> and <code>context.WithDeadline</code>? When would you use each?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>WithTimeout(parent, d)</code> cancels after a <em>relative</em> duration from now; <code>WithDeadline(parent, t)</code> cancels at an <em>absolute</em> wall-clock time. <code>WithTimeout</code> is implemented as <code>WithDeadline(parent, time.Now().Add(d))</code> — identical mechanics, different ergonomics. Use <code>WithTimeout</code> when you know "this call gets 3 seconds." Use <code>WithDeadline</code> when you're propagating an upstream deadline ("the client gave us until T, so our downstream call must also finish by T").</div>
</div>

<div class="quiz-card">
  <p class="quiz-q">When does <code>ctx.Err()</code> return <code>context.DeadlineExceeded</code> vs <code>context.Canceled</code>?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>ctx.Err()</code> returns <code>context.DeadlineExceeded</code> when the context expired because a timeout or deadline fired automatically. It returns <code>context.Canceled</code> when an explicit <code>cancel()</code> call triggered the cancellation (including a cancel propagated from a parent). If you call <code>cancel()</code> before the deadline fires, you get <code>Canceled</code>, not <code>DeadlineExceeded</code> — the explicit cancel wins. Both mean the context is done; the distinction tells you <em>why</em> it ended, which matters for logging, metrics, and deciding whether to retry.</div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Why must the <code>cancel</code> function returned by <code>WithCancel</code>/<code>WithTimeout</code>/<code>WithDeadline</code> always be called — even if the timeout fires on its own?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Each <code>With*</code> call registers the new context as a child of its parent, which involves allocating internal state (a channel, timer for timeouts, and a reference in the parent's child list). Calling <code>cancel()</code> releases all of this: it closes the Done channel, stops the timer, and removes the child entry from the parent. If <code>cancel()</code> is never called, these resources stay alive until the <em>parent</em> context is cancelled — which may be <code>context.Background()</code>, meaning never. On the success path (no timeout), the timer never fires and the internal goroutine/timer resource leaks for the process lifetime. <code>defer cancel()</code> is cheap and ensures cleanup regardless of exit path.</div>
</div>

---

## context.Value — Anti-Patterns and When It's Appropriate

`context.Value` is a loosely-typed, per-request key-value bag propagated down the call tree. It is **not** a general-purpose parameter-passing mechanism.

### Anti-Patterns

```go
// BAD: passing required business parameters through context
ctx = context.WithValue(ctx, "userID", 123)         // string key — collides across packages
ctx = context.WithValue(ctx, "db", dbConn)          // dependency injection via context — hides the dependency
func process(ctx context.Context) {
    userID := ctx.Value("userID").(int)              // no compile-time safety, panics if missing/wrong type
}
```

Why this is bad:
- **Hidden dependencies** — a function's signature no longer tells you what it needs; you have to read the body to find `ctx.Value` calls.
- **No type safety** — `ctx.Value` returns `any`; a typo'd key or wrong type assertion is a runtime panic, not a compile error.
- **String keys collide** — two packages both using `"userID"` as a key will silently overwrite each other unless you use unexported custom key types.
- **Required inputs should be parameters.** If a function cannot do its job without a value, put it in the signature.

### When It's Actually Appropriate

Request-scoped metadata that's optional, cross-cutting, and doesn't change the function's core logic — tracing IDs, request-scoped loggers, auth principal for audit logging.

```go
type ctxKey int
const requestIDKey ctxKey = iota // unexported type + const — prevents collisions across packages

func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

func RequestIDFromContext(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(requestIDKey).(string)
    return id, ok
}

// Usage: middleware injects it, deep handlers/loggers optionally read it
func LoggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := uuid.NewString()
        ctx := WithRequestID(r.Context(), id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func handler(w http.ResponseWriter, r *http.Request) {
    if id, ok := RequestIDFromContext(r.Context()); ok {
        log.Printf("[%s] handling request", id)
    }
}
```

**Rule:** if removing the value from context would break correctness (not just observability/tracing), it belongs in the function signature instead.

<div class="quiz-card">
  <p class="quiz-q">What does <code>ctx.Value(key)</code> retrieve, and why should the key be an unexported custom type rather than a plain string?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>ctx.Value(key)</code> walks up the context tree from the current context to the root, comparing each node's key using <code>==</code>. It returns the value associated with the first matching key, or <code>nil</code> if none is found. The return type is <code>any</code>, requiring a type assertion to use. <br><br>If string keys are used (<code>"userID"</code>), any two packages using the same string key will silently collide — one package's <code>ctx.Value("userID")</code> would return the value set by the other package's middleware. An unexported custom type (<code>type ctxKey int; const requestIDKey ctxKey = iota</code>) prevents this: since the type is unexported, no other package can even construct a value of that type to use as a key — the key is only accessible via the package's own accessor functions, making collisions structurally impossible.</div>
</div>

---

## Cancellation Propagation Through Goroutine Trees

```mermaid
sequenceDiagram
    participant Caller
    participant ctx as context (WithCancel)
    participant G1 as Goroutine A
    participant G2 as Goroutine B (child of A)

    Caller->>ctx: ctx, cancel := WithCancel(parent)
    Caller->>G1: go worker(ctx)
    G1->>G2: go subWorker(ctx)
    Note over G1,G2: both select on <-ctx.Done()

    Caller->>ctx: cancel()
    ctx->>G1: Done() channel closes
    ctx->>G2: Done() channel closes (same tree)
    G1->>G1: sees ctx.Done(), cleans up, returns
    G2->>G2: sees ctx.Done(), cleans up, returns
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Parent creates context with deadline.</strong> <code>ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)</code> — a new context node is registered in the context tree with a timer that fires at T+2s.
    </div>
    <div class="stepper-panel">
      <strong>2. Context passed to child via function argument.</strong> <code>go worker(ctx, id)</code> — the same context pointer is shared; no copy of the deadline is made. The child sees the exact same expiry.
    </div>
    <div class="stepper-panel">
      <strong>3. Child goroutine selects on <code>ctx.Done()</code>.</strong> Inside the worker, <code>select { case &lt;-ctx.Done(): return }</code> — the goroutine parks, waiting for the Done channel to close. Meanwhile other work proceeds normally.
    </div>
    <div class="stepper-panel">
      <strong>4. Parent deadline fires at T+2s.</strong> The internal timer goroutine calls <code>cancel()</code> automatically. This closes the Done channel on <code>ctx</code> and sets <code>ctx.Err()</code> to <code>context.DeadlineExceeded</code>.
    </div>
    <div class="stepper-panel">
      <strong>5. All derived contexts' Done channels close simultaneously.</strong> Any child or grandchild context derived from this one also has its Done channel closed — the cancellation cascades down the entire subtree, but never upward to the parent.
    </div>
    <div class="stepper-panel">
      <strong>6. Child goroutine unblocks and exits cleanly.</strong> The worker's <code>select</code> case on <code>&lt;-ctx.Done()</code> fires. It reads <code>ctx.Err()</code> to distinguish timeout from explicit cancel, logs the reason, and returns — no goroutine leak.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

Closing the `Done()` channel is a broadcast — every goroutine holding that context (or any context derived from it) observes it in the same instant. There's no ordering guarantee for which goroutine notices first, but all of them eventually do.

```go
func worker(ctx context.Context, id int) {
    for {
        select {
        case <-ctx.Done():
            fmt.Printf("worker %d: stopping, %v\n", id, ctx.Err())
            return
        case <-time.After(500 * time.Millisecond):
            fmt.Printf("worker %d: working\n", id)
        }
    }
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()

    for i := 1; i <= 3; i++ {
        go worker(ctx, i) // all 3 share the same ctx tree — all stop together at 2s
    }
    <-ctx.Done()
    time.Sleep(100 * time.Millisecond) // give workers time to print their stop message
}
```

<div class="quiz-card">
  <p class="quiz-q">Why should <code>context.Background()</code> only be used at the top level of a program (e.g., <code>main</code>, test setup, or HTTP handler root)?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>context.Background()</code> is a root context that is never cancelled, has no deadline, and carries no values. If you create it deep inside a call stack (e.g., inside a helper function that should respect the caller's timeout), you break the cancellation chain: the caller's context deadline or cancel signal will not propagate into any child contexts derived from your new <code>Background()</code>. The whole point of threading <code>context.Context</code> through function arguments is to allow a single cancellation at the top to flow down to every I/O or blocking operation. Using <code>Background()</code> below the top level silently opts out of that contract. Use <code>context.TODO()</code> as a temporary placeholder during refactoring to signal intent to wire up a real context later.</div>
</div>

---

## errgroup — Fan-Out with Early Cancellation on First Error

`golang.org/x/sync/errgroup` runs a group of goroutines, collects the first non-nil error, and (with `WithContext`) cancels the shared context as soon as any goroutine fails — so siblings stop early instead of finishing wasted work.

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "golang.org/x/sync/errgroup"
)

func fetch(ctx context.Context, url string) (int, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return 0, err
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return 0, fmt.Errorf("fetching %s: %w", url, err)
    }
    defer resp.Body.Close()
    return resp.StatusCode, nil
}

func fetchAll(ctx context.Context, urls []string) ([]int, error) {
    g, ctx := errgroup.WithContext(ctx) // derived ctx is cancelled on first error
    statuses := make([]int, len(urls))

    for i, url := range urls {
        i, url := i, url // capture loop vars (pre Go 1.22 requirement; harmless on 1.22+)
        g.Go(func() error {
            status, err := fetch(ctx, url) // uses the errgroup's ctx — sees cancellation
            if err != nil {
                return err
            }
            statuses[i] = status
            return nil
        })
    }

    if err := g.Wait(); err != nil { // blocks until all goroutines return; returns first error
        return nil, err
    }
    return statuses, nil
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    urls := []string{
        "https://example.com",
        "https://httpstat.us/500", // will fail
        "https://example.org",
    }

    statuses, err := fetchAll(ctx, urls)
    if err != nil {
        fmt.Println("failed:", err) // other in-flight fetches are cancelled via ctx as soon as this returns
        return
    }
    fmt.Println(statuses)
}
```

**Why this matters operationally:** without `errgroup.WithContext`, a failed goroutine in a fan-out just returns an error while its siblings keep running to completion — wasting downstream calls, DB connections, and time. `WithContext` turns "one failure" into "stop everything else immediately."

<div class="quiz-card">
  <p class="quiz-q">In <code>errgroup.WithContext</code>, what context is passed to goroutines launched via <code>g.Go(...)</code>, and what happens to it when one goroutine returns a non-nil error?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>errgroup.WithContext(parent)</code> creates a derived context (<code>ctx</code>) and an internal cancel function. All goroutines launched via <code>g.Go</code> should use this derived <code>ctx</code> (not the original parent) for their I/O calls. When any goroutine returns a non-nil error, <code>errgroup</code> immediately calls the internal cancel function — closing <code>ctx.Done()</code> for all sibling goroutines simultaneously. Siblings that are blocked in context-aware calls (HTTP requests, DB queries using <code>NewRequestWithContext</code>) will be interrupted. <code>g.Wait()</code> blocks until all goroutines return, then returns the first non-nil error. This pattern ensures that a single failure stops wasted work across all siblings.</div>
</div>

### errgroup with Limited Concurrency (Go 1.24+ / recent x/sync)

```go
g, ctx := errgroup.WithContext(ctx)
g.SetLimit(10) // cap concurrent goroutines — acts like a worker pool with early-cancel semantics

for _, item := range items {
    item := item
    g.Go(func() error {
        return process(ctx, item)
    })
}
if err := g.Wait(); err != nil {
    // handle first error; all others already cancelled via ctx
}
```

---

## Context in HTTP Servers

`net/http` gives every incoming request a context tied to the connection. When the client disconnects (closes the connection, hits a browser timeout, or the load balancer cuts it), `r.Context()` is cancelled automatically — your handler can react instead of doing wasted work.

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context() // cancelled automatically if the client disconnects

    result, err := slowDBQuery(ctx)
    if err != nil {
        if errors.Is(err, context.Canceled) {
            // client already gone — don't bother writing a response
            log.Printf("client disconnected before query finished")
            return
        }
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    json.NewEncoder(w).Encode(result)
}

func slowDBQuery(ctx context.Context) (Result, error) {
    row := db.QueryRowContext(ctx, "SELECT ...") // aborts the query server-side too, not just client-side
    // ...
}
```

Adding a server-side timeout on top of client disconnect handling:

```go
func withTimeout(next http.HandlerFunc, d time.Duration) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx, cancel := context.WithTimeout(r.Context(), d)
        defer cancel()
        next(w, r.WithContext(ctx))
    }
}

http.HandleFunc("/report", withTimeout(reportHandler, 10*time.Second))
```

`http.TimeoutHandler` does something similar built-in, but writes a fallback response on timeout — useful for guaranteeing a response even if the handler ignores `ctx.Done()`.

<div class="quiz-card">
  <p class="quiz-q">In an HTTP handler, when does <code>r.Context()</code> get cancelled automatically — and why does this matter for downstream calls like DB queries?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>r.Context()</code> is cancelled by the <code>net/http</code> server when the client disconnects — the TCP connection closes, the client times out, or a load balancer severs the connection. This is detected server-side and the Done channel closes automatically without any extra code. This matters because if you pass <code>r.Context()</code> (or a child of it) into every downstream call — <code>db.QueryRowContext(ctx, ...)</code>, <code>http.NewRequestWithContext(ctx, ...)</code>, etc. — those operations will abort as soon as the client is gone. Without context propagation, a handler might finish a 5-second DB query after the client has already moved on, wasting DB connections and CPU. With it, the query is cancelled server-side the moment it becomes pointless.</div>
</div>

---

## Common Mistakes

### 1. Storing Contexts in Structs

```go
// BAD — a context captured at construction time becomes stale;
// cancellation from a later, different request-scoped context is invisible to it
type Service struct {
    ctx context.Context // don't do this
}

func NewService(ctx context.Context) *Service {
    return &Service{ctx: ctx}
}

func (s *Service) DoWork() error {
    return doSomething(s.ctx) // wrong context — not the caller's actual request context
}
```

```go
// GOOD — pass context explicitly through every call that needs it
type Service struct{}

func (s *Service) DoWork(ctx context.Context) error {
    return doSomething(ctx)
}
```

The one narrow exception the stdlib itself allows: types with an explicit "lives across the whole program, not tied to a single request" lifetime (rare — most services don't have this).

### 2. Passing nil Context

```go
// BAD — panics inside anything that calls ctx.Done(), ctx.Value(), etc.
resp, err := http.NewRequestWithContext(nil, http.MethodGet, url, nil)
```

```go
// GOOD — always pass a real context; use context.TODO() only as a temporary
// placeholder while refactoring, never in shipped code
resp, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
```

### 3. Context Leak from Missing cancel()

```go
// BAD — cancel is never called; the internal timer goroutine for WithTimeout
// leaks until the parent (context.Background(), i.e. forever) is done
func fetch(url string) {
    ctx, _ := context.WithTimeout(context.Background(), 5*time.Second) // cancel discarded!
    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    http.DefaultClient.Do(req)
}
```

```go
// GOOD
func fetch(url string) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel() // always — even though the timeout would eventually fire on its own,
                    // defer cancel() releases the timer immediately on the success path
    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    http.DefaultClient.Do(req)
}
```

`go vet` catches the common case of an unused cancel func with the `lostcancel` check — run it in CI.

```bash
go vet ./...
# ./main.go:12:2: the cancel function returned by context.WithTimeout should be called, not discarded, to avoid a context leak
```

<div class="quiz-card">
  <p class="quiz-q">Why is storing a <code>context.Context</code> in a struct field almost always wrong — what specific problem does it create?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>A <code>context.Context</code> is meant to represent the lifetime of a single <em>operation</em> or <em>request</em> — not the lifetime of an object. When stored in a struct at construction time, the context becomes "stale": it reflects the cancellation state at the moment the struct was created, not the current caller's request. A later call to a method on that struct will use the wrong context — it may already be cancelled (from a previous request), or it will never be cancelled (because it was <code>context.Background()</code> at construction). The correct pattern is to accept <code>ctx context.Context</code> as the first argument of every method that does I/O, so the calling goroutine can control cancellation per-call.</div>
</div>

---

## Real-World Example: Queue Consumer with Per-Message Timeout (Nack/Requeue on Timeout)

Models a RabbitMQ-style consumer: each message gets a bounded processing timeout; on timeout the message is nacked and requeued instead of acked, and a shutdown signal stops the consumer loop gracefully.

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "math/rand"
    "os/signal"
    "syscall"
    "time"
)

// Message models an incoming queue delivery (e.g., amqp.Delivery in a real RabbitMQ client).
type Message struct {
    ID   string
    Body []byte
}

// Queue is a minimal interface a real client (amqp091-go, etc.) would satisfy.
type Queue interface {
    Consume(ctx context.Context) (<-chan Message, error)
    Ack(id string) error
    Nack(id string, requeue bool) error
}

const perMessageTimeout = 2 * time.Second

func handleMessage(ctx context.Context, m Message) error {
    // Simulate variable processing time — sometimes exceeds the timeout.
    workDone := make(chan error, 1)
    go func() {
        delay := time.Duration(rand.Intn(3000)) * time.Millisecond
        time.Sleep(delay)
        workDone <- nil // pretend processing succeeded
    }()

    select {
    case err := <-workDone:
        return err
    case <-ctx.Done():
        return ctx.Err() // context.DeadlineExceeded (per-message timeout) or context.Canceled (shutdown)
    }
}

func consume(ctx context.Context, q Queue) error {
    deliveries, err := q.Consume(ctx)
    if err != nil {
        return fmt.Errorf("starting consumer: %w", err)
    }

    for {
        select {
        case <-ctx.Done():
            log.Println("shutdown signal received, stopping consumer loop")
            return ctx.Err()

        case m, ok := <-deliveries:
            if !ok {
                return errors.New("delivery channel closed unexpectedly")
            }

            msgCtx, cancel := context.WithTimeout(ctx, perMessageTimeout)
            err := handleMessage(msgCtx, m)
            cancel() // release the per-message timer immediately, don't wait for defer at loop scope

            switch {
            case err == nil:
                if ackErr := q.Ack(m.ID); ackErr != nil {
                    log.Printf("ack failed for %s: %v", m.ID, ackErr)
                }
            case errors.Is(err, context.DeadlineExceeded):
                log.Printf("message %s timed out after %v, nacking + requeueing", m.ID, perMessageTimeout)
                if nackErr := q.Nack(m.ID, true); nackErr != nil { // requeue=true
                    log.Printf("nack failed for %s: %v", m.ID, nackErr)
                }
            case errors.Is(err, context.Canceled):
                // Shutdown mid-message — requeue so another consumer (or this one, after restart) picks it up.
                log.Printf("message %s cancelled by shutdown, nacking + requeueing", m.ID)
                _ = q.Nack(m.ID, true)
            default:
                log.Printf("message %s failed: %v, nacking without requeue (poison message)", m.ID, err)
                _ = q.Nack(m.ID, false) // don't requeue — avoid infinite redelivery of a bad message
            }
        }
    }
}

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    var q Queue // real implementation would wrap amqp091-go's Channel
    if err := consume(ctx, q); err != nil && !errors.Is(err, context.Canceled) {
        log.Fatalf("consumer exited: %v", err)
    }
}
```

**Key decisions in this pattern:**
- Per-message context is derived from the loop's `ctx` — a shutdown signal cancels in-flight message processing too, not just future deliveries.
- `context.DeadlineExceeded` (message-specific timeout) and `context.Canceled` (process shutdown) are handled differently: both requeue, but only the timeout case is a "this message specifically is slow" signal versus "we're shutting down."
- A generic processing error nacks **without** requeue — requeueing a poison message that always fails causes an infinite redelivery loop; that's what a dead-letter exchange/queue is for in production.

<div class="quiz-card">
  <p class="quiz-q">In the queue consumer pattern, why is <code>context.DeadlineExceeded</code> handled differently from <code>context.Canceled</code> even though both result in a nack+requeue?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>context.DeadlineExceeded</code> means this specific message exceeded its per-message timeout — the message itself might be slow, or the downstream service is degraded. Requeuing it is appropriate (another consumer or a later attempt might process it faster), but it's a signal about <em>that message's</em> processing time and should be logged/metered separately. <code>context.Canceled</code> (here triggered by SIGTERM/SIGINT) means the <em>process</em> is shutting down, not that the message is bad — the message was simply caught mid-flight and should be requeued for another instance to pick up. Distinguishing them lets you build separate alerting: rising <code>DeadlineExceeded</code> nacks indicate processing slowdowns; <code>Canceled</code> nacks are expected during rolling deployments and should not page anyone.</div>
</div>

---

## Quick Reference

```
Root context, never cancelled           → context.Background()
Manual cancellation trigger             → context.WithCancel
Relative max duration                   → context.WithTimeout
Absolute wall-clock deadline            → context.WithDeadline
Request-scoped optional metadata only   → context.WithValue + unexported key type
Cancel entire subtree                   → cancel() on an ancestor context
React to client disconnect in HTTP      → r.Context()
Fan-out, stop all on first error        → errgroup.WithContext + g.Go + g.Wait
Cap fan-out concurrency                 → errgroup.SetLimit(n)
Always after WithCancel/Timeout/Deadline → defer cancel()
Never                                    → store ctx in a struct field, pass nil context
Catch missing cancel() in CI             → go vet (lostcancel check)
Per-message timeout + safe redelivery    → context.WithTimeout(ctx, d) per item + nack(requeue) on DeadlineExceeded
```
