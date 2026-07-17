# Go Concurrency — Goroutines and Channels Deep Dive

---

## Goroutine Leaks

A goroutine leak happens when a goroutine blocks forever and is never garbage collected — it sits in memory for the life of the process, holding its stack and anything it references.

### Common Causes

```go
// LEAK 1: send with no receiver, no timeout, no cancellation
func leak1() {
    ch := make(chan int)
    go func() {
        ch <- 42   // blocks forever — nobody ever receives
    }()
    // function returns, ch goes out of scope, goroutine stuck forever
}

// LEAK 2: goroutine started but caller stops reading before it's done
func leak2(results chan int) {
    go worker(results)  // sends N results
    first := <-results  // caller only reads ONE result, worker blocks on 2nd send
    _ = first
}

// LEAK 3: forgotten context cancel — goroutine waits on ctx.Done() that never fires
func leak3(ctx context.Context) {
    ctx, _ = context.WithCancel(ctx)  // cancel func discarded — never called
    go func() {
        <-ctx.Done()  // if parent ctx also never cancelled, blocks forever
    }()
}

// LEAK 4: unbuffered channel writer outlives its only reader (e.g. reader hit an early return/panic)
```

### Detection via pprof

```go
import (
    "net/http"
    _ "net/http/pprof"
)

func main() {
    go http.ListenAndServe("localhost:6060", nil)
    // ... rest of app
}
```

```bash
# Snapshot current goroutine count and stacks
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutines.txt

# Interactive view
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Quick count over time — if this climbs without bound, you're leaking
watch -n 5 'curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | head -1'
```

```
# goroutines.txt shows stacks grouped by identical call site — a leak shows
# hundreds/thousands of goroutines blocked at the exact same line:
goroutine profile: total 5013
5000 @ 0x43e2ce 0x44f9cd 0x4f6a8b ...
#   0x4f6a8a  main.worker+0x8a   /app/worker.go:23
```

A steadily growing goroutine count in `runtime.NumGoroutine()` exported as a Prometheus gauge is the cheapest early-warning signal — alert if it grows unbounded under steady traffic.

```go
prometheus.NewGaugeFunc(prometheus.GaugeOpts{
    Name: "goroutines_count",
}, func() float64 { return float64(runtime.NumGoroutine()) })
```

---

## Worker Pool Pattern

Bounded number of goroutines pull jobs from a shared channel — caps concurrency instead of spawning one goroutine per job.

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type Job struct {
    ID int
}

type Result struct {
    JobID int
    Value int
    Err   error
}

func worker(ctx context.Context, id int, jobs <-chan Job, results chan<- Result, wg *sync.WaitGroup) {
    defer wg.Done()
    for {
        select {
        case job, ok := <-jobs:
            if !ok {
                return // jobs channel closed, drained — worker exits
            }
            select {
            case results <- process(ctx, job):
            case <-ctx.Done():
                return
            }
        case <-ctx.Done():
            return // graceful shutdown — stop taking new jobs
        }
    }
}

func process(ctx context.Context, job Job) Result {
    time.Sleep(50 * time.Millisecond) // simulate work
    return Result{JobID: job.ID, Value: job.ID * job.ID}
}

func RunPool(ctx context.Context, numWorkers int, numJobs int) []Result {
    jobs := make(chan Job, numJobs)
    results := make(chan Result, numJobs)

    var wg sync.WaitGroup
    for w := 1; w <= numWorkers; w++ {
        wg.Add(1)
        go worker(ctx, w, jobs, results, &wg)
    }

    for j := 1; j <= numJobs; j++ {
        jobs <- Job{ID: j}
    }
    close(jobs) // signal no more jobs — workers exit after draining

    go func() {
        wg.Wait()
        close(results) // safe to close only after all workers are done sending
    }()

    var out []Result
    for r := range results {
        out = append(out, r)
    }
    return out
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel()

    results := RunPool(ctx, 5, 20)
    for _, r := range results {
        fmt.Printf("job %d => %d\n", r.JobID, r.Value)
    }
}
```

**Why this shape:**
- `jobs` closed by the producer once all jobs are sent → workers `range`/`ok`-check to exit cleanly.
- `results` closed only after `wg.Wait()` confirms all workers finished — closing too early panics on in-flight sends.
- `ctx` threaded through so cancellation stops workers mid-flight, not just between jobs.

---

## Fan-Out / Fan-In Pattern

One producer, N parallel processing goroutines (fan-out), then merged back into one channel (fan-in).

```go
func fanOut(in <-chan int, n int, work func(int) int) []<-chan int {
    outs := make([]<-chan int, n)
    for i := 0; i < n; i++ {
        out := make(chan int)
        outs[i] = out
        go func(out chan int) {
            defer close(out)
            for v := range in {
                out <- work(v)
            }
        }(out)
    }
    return outs
}

func fanIn(cs ...<-chan int) <-chan int {
    merged := make(chan int)
    var wg sync.WaitGroup
    wg.Add(len(cs))

    for _, c := range cs {
        go func(c <-chan int) {
            defer wg.Done()
            for v := range c {
                merged <- v
            }
        }(c)
    }

    go func() {
        wg.Wait()
        close(merged) // close only after every input channel is drained
    }()
    return merged
}

func main() {
    in := make(chan int)
    go func() {
        defer close(in)
        for i := 1; i <= 10; i++ {
            in <- i
        }
    }()

    square := func(v int) int { return v * v }
    workers := fanOut(in, 4, square)
    for v := range fanIn(workers...) {
        fmt.Println(v)
    }
}
```

---

## Pipeline Pattern

Chain of stages connected by channels — each stage reads from an input channel, transforms, writes to an output channel.

```go
func generate(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            out <- n
        }
    }()
    return out
}

func square(in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            out <- n * n
        }
    }()
    return out
}

func filterEven(in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            if n%2 == 0 {
                out <- n
            }
        }
    }()
    return out
}

func main() {
    // 1,2,3,4,5 -> square -> 1,4,9,16,25 -> filterEven -> 4,16
    for v := range filterEven(square(generate(1, 2, 3, 4, 5))) {
        fmt.Println(v)
    }
}
```

Each stage owns closing its own output channel — this is what lets the next stage's `range` terminate cleanly, cascading shutdown through the whole pipeline.

---

## Done-Channel Cancellation Pattern

Before `context.Context` existed (or when you want a minimal primitive), a `done chan struct{}` broadcasts cancellation.

```go
func worker(done <-chan struct{}, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            select {
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case out <- v * 2:
                case <-done:
                    return
                }
            case <-done:
                return
            }
        }
    }()
    return out
}

func main() {
    done := make(chan struct{})
    defer close(done) // broadcasts cancellation to every reader of `done`

    in := generate(1, 2, 3, 4, 5)
    out := worker(done, in)

    fmt.Println(<-out) // only take the first result, then bail
}
```

`context.Context` is the standard replacement for this today — it adds deadlines, values, and a tree structure on top of the same closed-channel broadcast idea (`ctx.Done()` is exactly this pattern).

---

## Select with Timeout and Default

```go
// Timeout: wait up to 100ms for a value, otherwise give up
select {
case v := <-ch:
    fmt.Println("got", v)
case <-time.After(100 * time.Millisecond):
    fmt.Println("timeout")
}

// Default: never block — check right now, otherwise proceed
select {
case v := <-ch:
    fmt.Println("got", v)
default:
    fmt.Println("nothing available, continuing")
}

// Combined: poll a channel in a loop without busy-spinning the CPU
ticker := time.NewTicker(50 * time.Millisecond)
defer ticker.Stop()
for {
    select {
    case v := <-ch:
        fmt.Println("got", v)
        return
    case <-ticker.C:
        fmt.Println("still waiting...")
    }
}
```

---

## Common Channel Gotchas

| Gotcha | Behavior | Fix |
|--------|----------|-----|
| Send on closed channel | **Panics**: `send on closed channel` | Only the sender closes; never send after close |
| Receive from closed channel | Returns zero value immediately, `ok == false` — does NOT panic | Check `v, ok := <-ch` if the zero value is ambiguous |
| Nil channel send/receive | Blocks forever (no panic) | Used deliberately to disable a `select` case |
| Double close | **Panics**: `close of closed channel` | Use `sync.Once` or a single designated owner for close |
| Deadlock: all goroutines asleep | Runtime detects and crashes: `fatal error: all goroutines are asleep - deadlock!` | Ensure every send has a matching receive reachable |
| Unbuffered channel + no concurrent reader | Blocks forever on send | Buffer it, or start the reader `go`-routine first |
| Closing a channel with senders still active | Panics when a sender's next send fires | Use a `done` signal to tell senders to stop before closing |

### Deadlock Example

```go
func main() {
    ch := make(chan int)
    ch <- 1        // blocks — no goroutine is receiving, and none ever will be
    fmt.Println(<-ch)
}
// fatal error: all goroutines are asleep - deadlock!
```

The Go runtime detects this specific case (every goroutine blocked, none runnable) and crashes the whole process rather than hanging silently — but it can only detect *global* deadlock. A leak where 999 goroutines are healthy and 1 is stuck forever produces no such error; that's why pprof monitoring matters more than relying on deadlock detection.

---

## Full Example: Bounded Worker Pool with Graceful Shutdown

Simulates a job processor that stops accepting new work and drains in-flight work on `context` cancellation (e.g., SIGTERM in a container).

```go
package main

import (
    "context"
    "fmt"
    "math/rand"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

type Job struct {
    ID int
}

type Result struct {
    JobID    int
    Duration time.Duration
    Err      error
}

func processJob(ctx context.Context, j Job) Result {
    start := time.Now()
    delay := time.Duration(rand.Intn(300)) * time.Millisecond

    select {
    case <-time.After(delay):
        return Result{JobID: j.ID, Duration: time.Since(start)}
    case <-ctx.Done():
        return Result{JobID: j.ID, Err: ctx.Err()} // cancelled mid-flight
    }
}

func worker(ctx context.Context, id int, jobs <-chan Job, results chan<- Result, wg *sync.WaitGroup) {
    defer wg.Done()
    for job := range jobs { // exits automatically when jobs is closed and drained
        select {
        case <-ctx.Done():
            results <- Result{JobID: job.ID, Err: ctx.Err()}
            continue
        default:
        }
        results <- processJob(ctx, job)
    }
}

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    const numWorkers = 4
    jobs := make(chan Job)
    results := make(chan Result)
    var wg sync.WaitGroup

    for w := 1; w <= numWorkers; w++ {
        wg.Add(1)
        go worker(ctx, w, jobs, results, &wg)
    }

    // Producer: feeds jobs until cancelled
    go func() {
        defer close(jobs)
        for i := 1; ; i++ {
            select {
            case jobs <- Job{ID: i}:
            case <-ctx.Done():
                return // stop producing new jobs on shutdown signal
            }
        }
    }()

    go func() {
        wg.Wait()
        close(results)
    }()

    processed := 0
    for r := range results {
        if r.Err != nil {
            fmt.Fprintf(os.Stderr, "job %d cancelled: %v\n", r.JobID, r.Err)
            continue
        }
        processed++
        fmt.Printf("job %d done in %v\n", r.JobID, r.Duration)
    }
    fmt.Printf("shutdown complete, %d jobs processed\n", processed)
}
```

**Shutdown flow:**
1. SIGTERM/SIGINT arrives → `signal.NotifyContext` cancels `ctx`.
2. Producer's `select` sees `ctx.Done()`, stops sending new jobs, closes `jobs`.
3. Workers finish any in-flight `processJob` (which itself respects `ctx.Done()` for jobs mid-sleep), then exit their `range jobs` loop as it closes.
4. `wg.Wait()` unblocks once all workers exit → `results` closed → main's `range results` loop ends.

---

## Race Detection

The Go race detector instruments memory accesses to catch unsynchronized concurrent read/write at runtime — it doesn't just report an error, it points at both goroutine stacks involved.

```bash
go run -race main.go
go test -race ./...
go build -race -o app .   # race-instrumented binary, ~2-10x slower, more memory — never ship to prod
```

### Realistic Data Race: Unprotected Map Access

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    counts := make(map[string]int) // plain map — NOT safe for concurrent access
    var wg sync.WaitGroup

    keys := []string{"a", "b", "c"}
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            k := keys[i%len(keys)]
            counts[k]++ // CONCURRENT WRITE — data race, or fatal "concurrent map writes"
        }(i)
    }
    wg.Wait()
    fmt.Println(counts)
}
```

```
go run -race main.go

==================
WARNING: DATA RACE
Write at 0x00c0000a route by goroutine 12:
  main.main.func1()
      /app/main.go:19 +0x64

Previous write at 0x00c0000a by goroutine 8:
  main.main.func1()
      /app/main.go:19 +0x64

Goroutine 12 (running) created at:
  main.main()
      /app/main.go:16 +0xb8
==================
```

Without `-race`, this often manifests in production as a runtime crash instead of silent corruption:
```
fatal error: concurrent map writes
```
Go's map implementation actively detects concurrent writes and panics — this is Go being *helpful*, not the actual bug. The bug is missing synchronization; removing the crash without adding a lock just hides data corruption.

### Fix 1: Mutex

```go
type SafeCounts struct {
    mu     sync.Mutex
    counts map[string]int
}

func (s *SafeCounts) Inc(key string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.counts[key]++
}

func main() {
    sc := &SafeCounts{counts: make(map[string]int)}
    var wg sync.WaitGroup
    keys := []string{"a", "b", "c"}

    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            sc.Inc(keys[i%len(keys)])
        }(i)
    }
    wg.Wait()
    fmt.Println(sc.counts)
}
```

### Fix 2: sync.Map (high-read, low-contention workloads)

```go
var counts sync.Map // sync.Map trades map-like API for lock-free reads; not a drop-in map replacement

func inc(key string) {
    val, _ := counts.LoadOrStore(key, new(int64))
    atomic.AddInt64(val.(*int64), 1)
}
```

### Fix 3: Channel-owned state (no shared memory at all)

```go
// Single goroutine owns the map; all updates go through a channel — no lock needed
incCh := make(chan string)
go func() {
    counts := make(map[string]int)
    for k := range incCh {
        counts[k]++
    }
}()
```

**Rule:** `sync.Mutex` for simple protected state, `sync.Map` only for read-heavy/append-mostly workloads with disjoint keys, channel-owned state when it fits the pipeline naturally. Never guess — always run `-race` in CI.

---

## Quick Reference

```
Detect leaked goroutines            → pprof /debug/pprof/goroutine + NumGoroutine() metric
Bound concurrency                   → worker pool (N goroutines, shared jobs channel)
Parallelize + merge                 → fan-out / fan-in
Chain transforms                    → pipeline (each stage owns its output channel's close)
Broadcast cancellation (pre-context) → close(done chan struct{})
Graceful shutdown on signal          → context.Context + signal.NotifyContext
Non-blocking channel check           → select { case: ... default: }
Bounded wait                         → select { case: ... case <-time.After(d): }
Detect races                         → go run -race / go test -race
Concurrent map access                → sync.Mutex, sync.Map, or channel-owned state — never plain map
```
