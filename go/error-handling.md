# Go Error Handling

<div class="prereq-chips">
  <span class="prereq-chip">go/concurrency.md</span>
  <span class="prereq-chip">go/context.md</span>
</div>

Go's error model is explicit: every function that can fail returns an error as its last return value. There are no exceptions, no stack unwinding, no try/catch. This simplicity scales — you always know exactly which call can fail, and where.

---

## The Error Interface

`error` is a built-in interface with a single method:

```go
type error interface {
    Error() string
}
```

Multiple return values make error returns explicit:

```go
func Divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}
```

The zero value of `error` is `nil` — successful return. Convention: check error immediately after call, return early.

```go
result, err := Divide(10, 0)
if err != nil {
    return fmt.Errorf("calculation: %w", err)
}
```

**Why no exceptions:** exceptions create implicit control flow — any function in the call chain might panic up the stack without the caller knowing. Go's explicit returns make every error handling decision visible at the call site. You can read a Go function and know exactly which calls can fail.

---

## Sentinel Errors

A sentinel is a package-level error value that callers compare against:

```go
var (
    ErrNotFound   = errors.New("not found")
    ErrPermission = errors.New("permission denied")
)

func GetUser(id int) (*User, error) {
    if id < 0 {
        return nil, ErrNotFound
    }
    // ...
    return user, nil
}
```

Callers use `errors.Is()`:

```go
u, err := GetUser(-1)
if errors.Is(err, ErrNotFound) {
    // handle not found specifically
    return http.StatusNotFound
}
```

**Exported vs unexported sentinels:** exported (capitalized) sentinels are part of your public API — document them. Unexported sentinels are internal and prevent callers from depending on them.

**Standard library sentinels you'll use often:**

| Sentinel | Package | When |
|---|---|---|
| `io.EOF` | `io` | No more data to read |
| `io.ErrUnexpectedEOF` | `io` | Partial read in a framed protocol |
| `os.ErrNotExist` | `os` | File or path does not exist |
| `context.Canceled` | `context` | Context was explicitly canceled |
| `context.DeadlineExceeded` | `context` | Deadline passed before completion |
| `sql.ErrNoRows` | `database/sql` | Query returned zero rows |

**Pitfall:** comparing with `==` instead of `errors.Is()` — this fails when the sentinel is wrapped (see the next section).

```go
// WRONG — breaks if err is wrapped
if err == ErrNotFound { ... }

// RIGHT — traverses the chain
if errors.Is(err, ErrNotFound) { ... }
```

---

## Custom Error Types

When you need to attach structured data to an error (field name, HTTP status, retry-after):

```go
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed on %s: %s", e.Field, e.Message)
}

func ValidateAge(age int) error {
    if age < 0 {
        return &ValidationError{Field: "age", Message: "must be non-negative"}
    }
    return nil
}
```

Callers use `errors.As()` to extract the typed error:

```go
var ve *ValidationError
if errors.As(err, &ve) {
    log.Printf("field %s is invalid: %s", ve.Field, ve.Message)
    return http.StatusBadRequest
}
```

**Pointer vs value receiver:** use a pointer receiver (`*ValidationError`) so `errors.As` can match it correctly. With a value receiver, `errors.As` requires an exact type match and won't work through wrapping.

**When to use struct vs sentinel:**
- **Sentinel** — callers only need to know *which* error occurred (`ErrNotFound`, `ErrPermission`)
- **Struct** — callers need *data* about the error (which field failed, what the retry delay is, the HTTP status code)

---

## Error Wrapping with %w

`fmt.Errorf("repository: %w", err)` wraps `err` inside a new error, preserving the chain:

```go
// repository layer wraps db error
func (r *UserRepo) Get(id int) (*User, error) {
    row := r.db.QueryRow("SELECT id, name FROM users WHERE id = $1", id)
    var u User
    if err := row.Scan(&u.ID, &u.Name); err != nil {
        return nil, fmt.Errorf("userrepo.Get id=%d: %w", id, err)
    }
    return &u, nil
}

// service layer wraps repo error
func (s *UserService) GetProfile(id int) (*Profile, error) {
    user, err := s.repo.Get(id)
    if err != nil {
        return nil, fmt.Errorf("GetProfile: %w", err)
    }
    return buildProfile(user), nil
}

// HTTP handler — chain traversal finds sql.ErrNoRows even through two layers of wrapping
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    profile, err := h.svc.GetProfile(42)
    if errors.Is(err, sql.ErrNoRows) {
        http.Error(w, "not found", 404)
        return
    }
    // ...
}
```

**`%v` vs `%w`:**

| | `%v` | `%w` |
|---|---|---|
| Wraps for chain traversal | No | Yes |
| `errors.Is` works through it | No | Yes |
| `errors.As` works through it | No | Yes |
| Use when | Hiding internal error type from callers | Callers may need to inspect the specific error |

Use `%v` deliberately when you don't want to leak internal error types across an API boundary (e.g., a public package that wraps database errors).

**Unwrap a single level:** `errors.Unwrap(err)` returns the next error in the chain (or nil). You rarely need this directly — `errors.Is` and `errors.As` do the traversal automatically.

---

## Error Handling Patterns

**Early return — flat, readable:**

```go
// good: flat, clear flow
result, err := step1()
if err != nil {
    return fmt.Errorf("step1: %w", err)
}
val, err := step2(result)
if err != nil {
    return fmt.Errorf("step2: %w", err)
}
return step3(val)

// avoid: nested, harder to read, deeper indentation
result, err := step1()
if err == nil {
    val, err := step2(result)
    if err == nil {
        return step3(val)
    }
}
```

**Wrap at package boundary:** add context at each architectural layer. The chain should read like a call stack:

```
GetProfile: userrepo.Get id=42: sql: no rows in result set
```

**Don't wrap if you're just re-returning** (no added context):

```go
// unnecessary double-wrap
return nil, fmt.Errorf("error: %w", err)

// just return it
return nil, err
```

**Centralizing error translation in HTTP handlers:**

```go
func errorResponse(err error) (int, string) {
    var ve *ValidationError
    switch {
    case errors.Is(err, ErrNotFound):
        return 404, "not found"
    case errors.Is(err, ErrPermission):
        return 403, "forbidden"
    case errors.As(err, &ve):
        return 400, ve.Message
    default:
        return 500, "internal error"
    }
}

func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.svc.GetUser(r.Context(), id)
    if err != nil {
        code, msg := errorResponse(err)
        http.Error(w, msg, code)
        return
    }
    // ...
}
```

One `errorResponse` function = one place to maintain the error→status mapping.

---

## log/slog Structured Logging

`slog` (Go 1.21+) is the stdlib replacement for the `log` package. Key-value pairs, JSON output, zero dependencies:

```go
import "log/slog"

logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))

// log with typed key-value pairs
logger.Error("db query failed",
    "err", err,
    "user_id", uid,
    "query", "SELECT * FROM users WHERE id = $1",
)
// output: {"time":"...","level":"ERROR","msg":"db query failed","err":"connection reset by peer","user_id":42,"query":"..."}
```

**`slog.With` for request-scoped fields** — avoids repeating the same keys on every call:

```go
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    reqLogger := h.logger.With(
        "request_id", r.Header.Get("X-Request-ID"),
        "method", r.Method,
        "path", r.URL.Path,
    )
    reqLogger.Info("request received")

    result, err := h.svc.Process(r.Context())
    if err != nil {
        reqLogger.Error("processing failed", "err", err)
        http.Error(w, "internal error", 500)
        return
    }
    reqLogger.Info("request complete", "status", 200)
}
```

**`slog.SetDefault(logger)`** sets the logger used by top-level `slog.Info()` / `slog.Error()` calls — use this in `main()` to set your program's default logger once.

**slog vs zap:**

| | slog | zap |
|---|---|---|
| Dep | stdlib (Go 1.21+) | external |
| Performance | ~same as zap | nanosecond-optimized |
| Type-safe attrs | Yes (`slog.String`, `slog.Int`) | Yes (`zap.String`, `zap.Int`) |
| Handler ecosystem | Growing | Mature |

Use slog unless you need sub-microsecond logging or an existing zap hook ecosystem.

---

## Panic vs Error

**Panics are for programmer errors** (invariant violations, impossible states), not operational errors (network failure, file not found):

```go
// GOOD panic — this is a programming bug, not a runtime condition
func mustPositive(n int) int {
    if n <= 0 {
        panic(fmt.Sprintf("mustPositive: got %d", n))
    }
    return n
}

// BAD panic — network errors are operational, not bugs
func fetchUser(id int) *User {
    u, err := http.Get(url)
    if err != nil {
        panic(err) // don't do this
    }
    // ...
}
```

**`recover()` at API boundaries** — prevents one goroutine's panic from killing the whole process:

```go
func safeHandler(h http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                // log the panic with stack trace for debugging
                slog.Error("handler panic",
                    "panic", rec,
                    "stack", string(debug.Stack()),
                )
                http.Error(w, "internal error", 500)
            }
        }()
        h.ServeHTTP(w, r)
    })
}
```

Use `recover()` sparingly — only at process boundaries (HTTP handler, goroutine entry, gRPC interceptor). Don't use panic+recover as a substitute for proper error handling — it obscures control flow and makes debugging harder.

---

<div class="quiz-card"><p class="quiz-q">What is the difference between <code>fmt.Errorf("op: %v", err)</code> and <code>fmt.Errorf("op: %w", err)</code>? When would you choose <code>%v</code>?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden><code>%w</code> wraps the error — <code>errors.Is(wrapped, originalErr)</code> returns true, and <code>errors.As(wrapped, &amp;target)</code> can extract the original type through the chain. <code>%v</code> only formats the error string — the original error is not in the chain, so <code>errors.Is</code> and <code>errors.As</code> cannot find it. Use <code>%v</code> deliberately when you want to hide the original error type from callers — for example, a public package that wraps database errors shouldn't leak <code>*pq.Error</code> to callers who don't import the postgres driver. Use <code>%w</code> when callers may need to inspect or match the specific underlying error.</div></div>

---

<div class="quiz-card"><p class="quiz-q">You have <code>func GetUser(id int) (*User, error)</code> that returns <code>ErrNotFound</code>. A caller wraps it: <code>fmt.Errorf("service: %w", err)</code>. Does <code>errors.Is(wrappedErr, ErrNotFound)</code> return true?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>Yes. <code>errors.Is</code> traverses the entire error chain by calling <code>Unwrap()</code> repeatedly. <code>fmt.Errorf</code> with <code>%w</code> implements <code>Unwrap()</code>, so <code>errors.Is</code> will find <code>ErrNotFound</code> even when it's several layers deep. This is exactly why <code>errors.Is</code> is always preferred over <code>err == ErrNotFound</code> — the direct comparison only matches the top-level error and breaks as soon as any wrapping is added.</div></div>

---

<div class="quiz-card"><p class="quiz-q">Your HTTP handler calls a service that calls a repository. The repository returns <code>sql.ErrNoRows</code>. The service wraps it with <code>fmt.Errorf("GetProfile: %w", err)</code>. The handler wants to return 404. How?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>Two options. Option 1: <code>errors.Is(err, sql.ErrNoRows)</code> in the handler — this traverses the chain and returns true regardless of wrapping layers. Option 2 (better): the service translates <code>sql.ErrNoRows</code> into a domain error (<code>ErrNotFound</code>) before returning, so the handler doesn't need to import <code>database/sql</code> at all. Each layer translates errors into its own vocabulary — the HTTP handler should know domain errors, not database driver errors. This is the "wrap at package boundary" pattern: the repository layer converts DB errors to domain errors, and the HTTP layer converts domain errors to HTTP status codes.</div></div>
