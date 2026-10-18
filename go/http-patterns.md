# Go HTTP Server Patterns

<div class="prereq-chips">
  <span class="prereq-chip">go/error-handling.md</span>
  <span class="prereq-chip">go/context.md</span>
</div>

`net/http` ships in the standard library and is capable of serving production traffic without a framework. Understanding the patterns here lets you build maintainable HTTP services and — if you later reach for gorilla/mux or chi — understand what the framework is doing for you.

---

## net/http Server Basics

```go
package main

import (
    "fmt"
    "log/slog"
    "net/http"
    "os"
)

func main() {
    mux := http.NewServeMux()

    mux.HandleFunc("GET /users/{id}", getUser)
    mux.HandleFunc("POST /users", createUser)

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    slog.Info("server starting", "addr", srv.Addr)
    if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        slog.Error("server error", "err", err)
        os.Exit(1)
    }
}

func getUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id") // Go 1.22+: path parameter extraction
    fmt.Fprintf(w, "user %s\n", id)
}

func createUser(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusCreated)
}
```

**Go 1.22 routing improvements:** The stdlib mux now supports method-prefixed patterns (`GET /path`) and path parameters (`{id}`). For most services this is sufficient — reach for chi or gorilla/mux only when you need regex constraints, subrouters, or more complex middleware.

**Why set timeouts:** Without timeouts, a slow client holds the goroutine and connection open indefinitely. `ReadTimeout` caps reading the request headers+body; `WriteTimeout` caps writing the response. `IdleTimeout` caps keep-alive connections waiting for the next request.

---

## Middleware Chaining

Middleware wraps `http.Handler` — it runs before and/or after the inner handler:

```go
type Middleware func(http.Handler) http.Handler

// logging middleware
func logging(logger *slog.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            // wrap ResponseWriter to capture status code
            rw := &responseWriter{ResponseWriter: w, status: 200}
            next.ServeHTTP(rw, r)
            logger.Info("request",
                "method", r.Method,
                "path", r.URL.Path,
                "status", rw.status,
                "duration", time.Since(start),
            )
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}

// chain applies middleware left to right (outermost first)
func chain(h http.Handler, middleware ...Middleware) http.Handler {
    for i := len(middleware) - 1; i >= 0; i-- {
        h = middleware[i](h)
    }
    return h
}
```

Usage:

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /users/{id}", getUser)

handler := chain(mux,
    logging(logger),
    requestID,
    recover,
)

srv := &http.Server{Handler: handler}
```

Middleware executes in the order you pass to `chain` (logging runs first, sees request before handler, and sees response after).

---

## Request Context

`r.Context()` carries request-scoped values through the call chain. Use it to pass request IDs, authenticated users, database connections:

```go
type contextKey string

const (
    requestIDKey contextKey = "requestID"
    userKey      contextKey = "user"
)

// middleware injects request ID
func requestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := r.Header.Get("X-Request-ID")
        if id == "" {
            id = uuid.New().String()
        }
        ctx := context.WithValue(r.Context(), requestIDKey, id)
        w.Header().Set("X-Request-ID", id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// helper to read from context — avoids repeating the type assertion
func GetRequestID(ctx context.Context) string {
    v, _ := ctx.Value(requestIDKey).(string)
    return v
}

// handler reads the value
func getUser(w http.ResponseWriter, r *http.Request) {
    reqID := GetRequestID(r.Context())
    slog.Info("handling request", "request_id", reqID)
    // ...
}
```

**Why unexported contextKey type:** using a custom type instead of `string` prevents key collisions between packages. If two packages both use `"userID"` as a string key, they clobber each other. With a package-private type, only your package can read or write the key.

---

## Graceful Shutdown

On SIGTERM/SIGINT, stop accepting new connections and let in-flight requests complete:

```go
func main() {
    srv := &http.Server{Addr: ":8080", Handler: mux}

    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            slog.Error("listen error", "err", err)
            os.Exit(1)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit
    slog.Info("shutting down")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        slog.Error("shutdown error", "err", err)
    }
    slog.Info("server stopped")
}
```

`Shutdown()` closes the listener (no new connections), then waits for active connections to finish. After the timeout, it forces-closes remaining connections. The `ListenAndServe` goroutine returns `http.ErrServerClosed` — this is expected, not an error.

---

## HTTP Client Patterns

Always reuse `http.Client` — it manages a connection pool internally. Creating a new client per request bypasses pooling:

```go
// create once, reuse everywhere
var client = &http.Client{
    Timeout: 10 * time.Second,
    Transport: &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        IdleConnTimeout:     90 * time.Second,
    },
}

func fetchUser(ctx context.Context, id int) (*User, error) {
    req, err := http.NewRequestWithContext(ctx, "GET",
        fmt.Sprintf("https://api.example.com/users/%d", id), nil)
    if err != nil {
        return nil, fmt.Errorf("build request: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+token)

    resp, err := client.Do(req)
    if err != nil {
        return nil, fmt.Errorf("do request: %w", err)
    }
    defer resp.Body.Close() // always close the body

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
    }

    var user User
    if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
        return nil, fmt.Errorf("decode response: %w", err)
    }
    return &user, nil
}
```

**Always pass context:** `http.NewRequestWithContext` is preferred over `http.NewRequest` — the context carries cancellation and deadlines from the caller's context chain.

---

## Common Pitfalls

| Pitfall | Why it breaks | Fix |
|---|---|---|
| Not closing `resp.Body` | Goroutine and connection leak — pool exhausted | `defer resp.Body.Close()` after nil check |
| `http.Get(url)` in a hot path | Bypasses shared pool, creates new connection per call | Use a package-level `*http.Client` |
| Missing `WriteTimeout` | Slow client holds goroutine open indefinitely | Set `WriteTimeout` on `http.Server` |
| `w.WriteHeader` after `w.Write` | `Write` implicitly sends 200; subsequent `WriteHeader` is a no-op | Call `WriteHeader` before any `Write` |
| Reading body after response | `resp.Body` is a network stream; reading after close panics | Decode immediately, don't store the body |
| Not checking `resp.StatusCode` | A 4xx/5xx silently decodes as an empty struct | Always check status before decoding |
| Creating goroutines without context | Goroutine can't be canceled when request completes | Pass `r.Context()` into spawned goroutines |
| `http.DefaultServeMux` in tests | Package-level mux is shared across tests | Use `http.NewServeMux()` per test |

---

## Testing HTTP Handlers

`net/http/httptest` lets you test handlers without starting a real server:

```go
func TestGetUser(t *testing.T) {
    // set up a real mux with real handler
    mux := http.NewServeMux()
    mux.HandleFunc("GET /users/{id}", getUser)

    // create a test server — picks a random port, shuts down with Close()
    ts := httptest.NewServer(mux)
    defer ts.Close()

    resp, err := ts.Client().Get(ts.URL + "/users/42")
    if err != nil {
        t.Fatal(err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        t.Fatalf("got %d, want 200", resp.StatusCode)
    }
}

// for unit tests of a single handler without a server
func TestGetUserUnit(t *testing.T) {
    req := httptest.NewRequest("GET", "/users/42", nil)
    req = req.WithContext(context.WithValue(req.Context(), requestIDKey, "test-id"))
    w := httptest.NewRecorder()

    getUser(w, req)

    res := w.Result()
    if res.StatusCode != http.StatusOK {
        t.Fatalf("got %d, want 200", res.StatusCode)
    }
}
```

**`httptest.NewServer` vs `httptest.NewRecorder`:**
- `NewServer` starts a real TCP listener — use it for integration tests that cover middleware, routing, or client behavior
- `NewRecorder` is in-process — use it for unit tests of a single handler function

---

## Complete Working Example

A production-ready server with middleware chain, graceful shutdown, and typed error responses:

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

var ErrNotFound = errors.New("not found")

type apiError struct {
    Status  int    `json:"status"`
    Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
    switch {
    case errors.Is(err, ErrNotFound):
        writeJSON(w, 404, apiError{404, "not found"})
    default:
        slog.Error("internal error", "err", err)
        writeJSON(w, 500, apiError{500, "internal error"})
    }
}

func getUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    if id == "" {
        writeError(w, ErrNotFound)
        return
    }
    writeJSON(w, 200, map[string]string{"id": id, "name": "Alice"})
}

func recoverMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                slog.Error("panic recovered", "panic", rec)
                writeJSON(w, 500, apiError{500, "internal error"})
            }
        }()
        next.ServeHTTP(w, r)
    })
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    slog.SetDefault(logger)

    mux := http.NewServeMux()
    mux.HandleFunc("GET /users/{id}", getUser)

    srv := &http.Server{
        Addr:         ":8080",
        Handler:      recoverMiddleware(mux),
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    go func() {
        slog.Info("server starting", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            slog.Error("server failed", "err", err)
            os.Exit(1)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := srv.Shutdown(ctx); err != nil {
        slog.Error("shutdown failed", "err", err)
    }
    slog.Info("server stopped")
}
```

---

<div class="quiz-card"><p class="quiz-q">You set <code>WriteTimeout: 10*time.Second</code> on your server. A handler streams a large file download that takes 30 seconds. What happens?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden><code>WriteTimeout</code> starts when the request is received and covers the entire response write, including streaming. After 10 seconds the connection is forcibly closed mid-stream — the client gets a broken download. For streaming handlers, set a longer <code>WriteTimeout</code> or use <code>http.ResponseController.SetWriteDeadline</code> (Go 1.20+) to extend the deadline per-request dynamically: <code>rc := http.NewResponseController(w); rc.SetWriteDeadline(time.Now().Add(5*time.Minute))</code>. This lets the global default stay tight while long-running endpoints opt into a longer window.</div></div>

---

<div class="quiz-card"><p class="quiz-q">A handler spawns a goroutine to do async work. The goroutine calls an external API using the request context. What happens if the request completes before the goroutine finishes?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>The request context is canceled when the handler returns — any in-flight HTTP call using that context will be canceled too, and the goroutine's API call returns a context-canceled error. For fire-and-forget async work that must outlive the request, use a separate context: <code>ctx := context.WithoutCancel(r.Context())</code> (Go 1.21+) to inherit values but remove cancellation, or <code>context.Background()</code> with a service-level timeout. Never store the request context beyond the handler's return.</div></div>

---

<div class="quiz-card"><p class="quiz-q">What does <code>srv.Shutdown(ctx)</code> do to keep-alive connections that are idle (not serving a request) when shutdown is called?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden><code>Shutdown</code> immediately closes idle keep-alive connections — they're not mid-request so there's nothing to wait for. Only connections actively serving a request are waited on. This means shutdown is usually fast: most connections are idle most of the time, and the timeout only matters if a handler is legitimately slow. The 30-second timeout in the example covers the worst case where a slow handler is still running when shutdown is triggered.</div></div>
