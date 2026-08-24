# Go Concurrency — Goroutines and Channels Deep Dive

---

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

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

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Send with no receiver.</strong> An unbuffered channel send blocks until a goroutine is ready to receive. If no receiver ever starts — or has already returned — the sender goroutine parks forever, holding its stack and any captured variables (including the channel itself, preventing GC).
    </div>
    <div class="stepper-panel">
      <strong>2. Goroutine outlives its reader.</strong> A worker sends N results but the caller only reads one and returns. The worker blocks on its second send; the caller is gone. The channel cannot be GC'd because the stuck goroutine still holds a reference to it.
    </div>
    <div class="stepper-panel">
      <strong>3. Forgotten context cancel.</strong> <code>context.WithCancel</code> returns a cancel function that <em>must</em> be called to close the internal Done channel. If discarded (<code>ctx, _ = context.WithCancel(...)</code>), any goroutine blocking on <code>&lt;-ctx.Done()</code> never wakes up — and the parent context must also be cancelled for the goroutine to ever exit.
    </div>
    <div class="stepper-panel">
      <strong>4. Unbuffered writer outlives its only reader.</strong> If the single reader exits early (panic, deadline, early return), the writer blocks on its next send indefinitely. Fix: pass a <code>done</code> channel or a <code>context.Context</code> so the writer can detect the reader is gone and bail out.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">A goroutine is blocked on a channel send. The function that created the channel has already returned and the variable is out of scope. Why is the goroutine still alive and why isn't the channel GC'd?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The goroutine itself holds a reference to the channel on its stack — the GC traces live goroutine stacks as roots. As long as the goroutine exists (even if it's permanently blocked), the channel is reachable and cannot be collected. The goroutine itself also can't be collected because Go's GC does not collect goroutines — only the garbage collector handles memory, and the scheduler handles goroutines. A blocked goroutine just sits in the run queue consuming its minimum 2–8 KB stack forever.</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">Why is it unsafe to close <code>results</code> from the producer goroutine (the one that calls <code>close(jobs)</code>) rather than from the goroutine that waits on <code>wg.Wait()</code>?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The producer closes <code>jobs</code> once all jobs are sent — but at that instant the workers are still running and actively sending into <code>results</code>. Closing <code>results</code> there would race with in-flight sends, causing a panic: "send on closed channel." <code>wg.Wait()</code> provides the happens-before guarantee that all workers have finished their last <code>results &lt;-</code> send before <code>close(results)</code> executes. The separate goroutine (<code>go func() { wg.Wait(); close(results) }()</code>) is needed because <code>wg.Wait()</code> is a blocking call — if placed in the main flow before <code>for r := range results</code>, it would deadlock (no one draining <code>results</code> while workers try to send).</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">Why does <code>fanIn</code> close <code>merged</code> inside a separate goroutine (<code>go func() { wg.Wait(); close(merged) }()</code>) rather than directly after the range-over-cs loops?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Each input channel is drained in its own goroutine (the ones calling <code>wg.Done()</code>). If <code>close(merged)</code> were called directly after launching those goroutines, it would execute before any of them finish — closing the channel while they're still sending into it, causing a "send on closed channel" panic. The separate goroutine blocks on <code>wg.Wait()</code>, which only unblocks after all per-input goroutines have called <code>wg.Done()</code> (i.e., drained their input channel), guaranteeing no more sends will happen before the close.</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">Why does each pipeline stage own the close of its own output channel instead of letting the consumer close it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Only the sender knows when it's done sending — the consumer has no way to know whether additional values are coming. If the consumer closed the channel, the producer's next send would panic with "send on closed channel." By having each stage close its own output once it has finished reading all input (via <code>defer close(out)</code>), the close is coupled to the exact moment the last send is complete. This also lets the downstream stage use <code>for v := range in</code> — the range loop exits cleanly when the channel is closed, propagating shutdown automatically through the entire chain without any extra coordination.</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">What does <code>close(done chan struct{})</code> do that sending a value into <code>done</code> cannot? Why does this matter when you have multiple goroutines waiting on the same signal?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Closing a channel is a <em>broadcast</em> — every goroutine blocked on <code>&lt;-done</code> wakes up simultaneously and receives the zero value. A send (<code>done &lt;- struct{}{}</code>) only unblocks <em>one</em> goroutine. If you have N worker goroutines all waiting on <code>&lt;-done</code> and you send N values, only the right goroutines get the signal if none miss a send — but with a close, all N see it regardless of order. Closing is also idempotent in terms of receivers: multiple <code>select</code> cases on the same closed channel always proceed immediately with the zero value.</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">What is the difference between <code>select { case &lt;-time.After(d): }</code> and <code>select { default: }</code> — when would each block, and when is each appropriate?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden><code>time.After(d)</code> creates a timer channel that fires after duration <code>d</code>. Until that timer fires, the case is not ready — so if <code>ch</code> has no value, the goroutine sleeps for up to <code>d</code> before the timeout case proceeds. It is appropriate when you want to wait a bounded time for a value. <code>default</code> is never blocking — it executes immediately if no other case is ready. It is appropriate when you want a non-blocking check ("is there a value right now?") and continuing without one is fine. Using <code>default</code> in a tight loop is a busy-spin; using <code>time.After</code> in a tight loop leaks timers on every iteration (use <code>time.NewTimer</code> + reset instead).</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">What does the Go runtime do when ALL goroutines are asleep vs when only SOME goroutines are stuck forever?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>When <em>all</em> goroutines are simultaneously blocked (nothing runnable in the entire program), the Go runtime detects this global deadlock and immediately crashes with <code>fatal error: all goroutines are asleep - deadlock!</code>. This is a best-effort safety net — it can only fire when there is literally no runnable goroutine left. When <em>some</em> goroutines are stuck but others continue running (a partial/local deadlock), the runtime has no way to distinguish "expected long wait" from "stuck forever" — it stays silent and the leaked goroutines accumulate undetected. This is why goroutine count metrics and pprof are essential; you cannot rely on runtime deadlock detection for production leak detection.</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">Why does the producer close <code>jobs</code> (not <code>results</code>), and why does a <em>separate</em> goroutine close <code>results</code> after <code>wg.Wait()</code>?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The producer is the only sender into <code>jobs</code> — it owns that channel and closes it once all work is enqueued. Workers range over <code>jobs</code>, so the close is the signal that no more jobs will arrive. Workers are the senders into <code>results</code>; the producer never writes to <code>results</code>, so it cannot close it. <code>wg.Wait()</code> must run in a separate goroutine because it's a blocking call — if it ran in the main goroutine <em>before</em> <code>for r := range results</code>, main would block at <code>wg.Wait()</code> with no one reading from <code>results</code>, while workers block trying to send — a deadlock. The separate goroutine lets main drain <code>results</code> concurrently while workers finish and <code>wg.Wait()</code> proceeds independently.</div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">When does Go's runtime detect "concurrent map writes" and panic — and when does a data race on a map cause silent corruption instead?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Go's map implementation has a built-in write-concurrency detector (a flag set during writes, checked on each map operation). When two goroutines write concurrently, the second goroutine to enter typically detects the flag and calls <code>fatal error: concurrent map writes</code> — this is a hard crash, not a recoverable panic. However, this detection is not guaranteed: it's a best-effort check, not a memory barrier. A concurrent read+write (not write+write) can produce silent corruption — the reader sees a partially-updated internal state, which can manifest as wrong values, infinite loops in hash table traversal, or a crash elsewhere entirely. The race detector (<code>-race</code>) catches both cases precisely because it instruments every memory access, not just map writes. The runtime crash on concurrent writes is Go being helpful, but the real fix is proper synchronization — <code>sync.Mutex</code>, <code>sync.RWMutex</code>, <code>sync.Map</code>, or channel-owned state.</div>
</div>

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
