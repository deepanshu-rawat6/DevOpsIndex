# Concurrency Patterns — Interview Questions (Go)

Common Go concurrency interview questions with working solutions. Assumes familiarity with goroutines/channels; focuses on the patterns that come up repeatedly in backend/infra interviews.

---

## 1. Thread-Safe Counter: Mutex vs Atomic

```go
package concurrency

import (
	"sync"
	"sync/atomic"
)

// MutexCounter protects an int64 with a sync.Mutex.
type MutexCounter struct {
	mu    sync.Mutex
	value int64
}

func (c *MutexCounter) Inc() {
	c.mu.Lock()
	c.value++
	c.mu.Unlock()
}

func (c *MutexCounter) Value() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.value
}

// AtomicCounter uses sync/atomic — no lock, just a CPU-level atomic
// instruction (CAS or fetch-and-add depending on architecture).
type AtomicCounter struct {
	value int64
}

func (c *AtomicCounter) Inc() {
	atomic.AddInt64(&c.value, 1)
}

func (c *AtomicCounter) Value() int64 {
	return atomic.LoadInt64(&c.value)
}
```

### Benchmark comparison

```go
package concurrency

import (
	"sync"
	"testing"
)

func BenchmarkMutexCounter(b *testing.B) {
	c := &MutexCounter{}
	var wg sync.WaitGroup
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Inc()
		}()
	}
	wg.Wait()
}

func BenchmarkAtomicCounter(b *testing.B) {
	c := &AtomicCounter{}
	var wg sync.WaitGroup
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Inc()
		}()
	}
	wg.Wait()
}
```

| | Mutex | Atomic |
|---|---|---|
| Mechanism | OS/runtime-level lock, goroutine may park if contended | Single CPU instruction (LOCK XADD / CAS), never parks |
| Overhead | Higher — lock acquisition, possible goroutine scheduling | Lower — no scheduler involvement in the common case |
| Use for | Protecting multiple related fields / complex invariants | A single primitive value (counter, flag, pointer swap) |
| Composability | Can protect a critical section spanning multiple statements/fields | Only atomic on one value at a time — can't atomically update two related fields together |
| Typical interview answer | "Use atomic for a single counter; mutex once you need to protect more than one related field together" | |

**Follow-up interviewers often ask:** "What if you need to increment the counter AND check a condition atomically?" — that requires a mutex (or CAS loop), because `atomic` only guarantees atomicity of the single operation, not a check-then-act sequence across multiple values.

---

## 2. Bounded Worker Pool

```go
package concurrency

import "sync"

// Job is a unit of work; Result is its outcome.
type Job struct {
	ID    int
	Input int
}

type Result struct {
	JobID  int
	Output int
	Err    error
}

// WorkerPool processes jobs with a fixed number of concurrent workers,
// bounding resource usage regardless of how many jobs are submitted.
type WorkerPool struct {
	numWorkers int
	jobs       chan Job
	results    chan Result
	wg         sync.WaitGroup
}

func NewWorkerPool(numWorkers, queueSize int) *WorkerPool {
	return &WorkerPool{
		numWorkers: numWorkers,
		jobs:       make(chan Job, queueSize),
		results:    make(chan Result, queueSize),
	}
}

// Start launches the fixed worker goroutines. Call once before Submit.
func (p *WorkerPool) Start(process func(Job) (int, error)) {
	for i := 0; i < p.numWorkers; i++ {
		p.wg.Add(1)
		go p.worker(process)
	}
}

func (p *WorkerPool) worker(process func(Job) (int, error)) {
	defer p.wg.Done()
	for job := range p.jobs { // exits automatically when jobs channel is closed
		output, err := process(job)
		p.results <- Result{JobID: job.ID, Output: output, Err: err}
	}
}

// Submit enqueues a job. Blocks if the queue is full (backpressure).
func (p *WorkerPool) Submit(j Job) {
	p.jobs <- j
}

// Close signals no more jobs will be submitted, then waits for all
// in-flight jobs to finish and closes the results channel so range-readers
// terminate cleanly.
func (p *WorkerPool) Close() {
	close(p.jobs)
	p.wg.Wait()
	close(p.results)
}

func (p *WorkerPool) Results() <-chan Result {
	return p.results
}
```

### Usage example

```go
pool := NewWorkerPool(4, 100) // 4 workers, queue capacity 100
pool.Start(func(j Job) (int, error) {
	return j.Input * 2, nil
})

go func() {
	for i := 0; i < 20; i++ {
		pool.Submit(Job{ID: i, Input: i})
	}
	pool.Close() // safe to call from a separate goroutine once all Submits are done
}()

for res := range pool.Results() {
	_ = res // consume results as they complete, unordered across workers
}
```

**Key interview point:** the pool is *bounded* because exactly `numWorkers` goroutines exist regardless of job volume — unlike naively spawning a goroutine per job (`go process(job)`), which has no upper bound on concurrent goroutines and can exhaust memory/file descriptors under load.

---

## 3. Pub/Sub System Using Channels

```go
package concurrency

import "sync"

// PubSub is an in-process publish/subscribe broker. Each subscriber gets
// its own buffered channel; publishing never blocks on a slow subscriber
// beyond that subscriber's buffer (messages are dropped past that point
// in this implementation — see the comment in Publish).
type PubSub struct {
	mu     sync.RWMutex
	subs   map[string][]chan string // topic -> list of subscriber channels
	closed bool
}

func NewPubSub() *PubSub {
	return &PubSub{subs: make(map[string][]chan string)}
}

// Subscribe returns a channel that receives all messages published to topic.
// bufferSize controls how many messages can queue before Publish drops them
// for this slow subscriber (a design choice: prevents one slow subscriber
// from blocking or slowing down all publishers).
func (ps *PubSub) Subscribe(topic string, bufferSize int) <-chan string {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	ch := make(chan string, bufferSize)
	ps.subs[topic] = append(ps.subs[topic], ch)
	return ch
}

// Publish sends msg to every subscriber of topic. Non-blocking per
// subscriber: if a subscriber's buffer is full, that message is dropped
// for that subscriber rather than blocking the publisher indefinitely.
func (ps *PubSub) Publish(topic, msg string) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	if ps.closed {
		return
	}
	for _, ch := range ps.subs[topic] {
		select {
		case ch <- msg:
		default:
			// Subscriber buffer full — drop rather than block the publisher.
			// A production system would count/log this as a metric.
		}
	}
}

// Close shuts down the broker, closing every subscriber channel so
// range-readers terminate.
func (ps *PubSub) Close() {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	ps.closed = true
	for _, chans := range ps.subs {
		for _, ch := range chans {
			close(ch)
		}
	}
}
```

### Usage example

```go
ps := NewPubSub()
sub1 := ps.Subscribe("orders", 10)
sub2 := ps.Subscribe("orders", 10)

go func() {
	for msg := range sub1 {
		_ = msg // handle order event
	}
}()
go func() {
	for msg := range sub2 {
		_ = msg
	}
}()

ps.Publish("orders", "order-123-created")
ps.Close()
```

**Follow-up interviewers ask:** "What if Publish must guarantee delivery instead of dropping?" — answer: block on `ch <- msg` instead of `select/default`, but then document that a single slow/stuck subscriber can stall every publisher (a classic head-of-line blocking tradeoff), or use per-subscriber goroutines with their own unbounded queue (at the cost of unbounded memory growth if a subscriber never catches up).

---

## 4. Debounce / Throttle

```go
package concurrency

import (
	"sync"
	"time"
)

// Debounce returns a function that delays invoking fn until `wait` has
// elapsed since the *last* call. Repeated calls within the window reset
// the timer — only the final call in a burst actually fires fn.
// Common use: search-as-you-type, save-on-idle.
func Debounce(wait time.Duration, fn func()) func() {
	var mu sync.Mutex
	var timer *time.Timer

	return func() {
		mu.Lock()
		defer mu.Unlock()

		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(wait, fn)
	}
}

// Throttle returns a function that invokes fn at most once per `interval`,
// regardless of how many times it's called. The first call in a window
// fires immediately; subsequent calls within the window are dropped.
// Common use: rate-limiting UI event handlers, periodic metric flushes.
func Throttle(interval time.Duration, fn func()) func() {
	var mu sync.Mutex
	var lastRun time.Time

	return func() {
		mu.Lock()
		defer mu.Unlock()

		now := time.Now()
		if now.Sub(lastRun) < interval {
			return // still within the throttle window — drop this call
		}
		lastRun = now
		fn()
	}
}
```

### Usage example

```go
debounced := Debounce(300*time.Millisecond, func() {
	// e.g., fires the search query only after typing pauses for 300ms
})
for _, keystroke := range []string{"g", "go", "gol", "gola", "golang"} {
	_ = keystroke
	debounced() // only the last call actually executes fn, ~300ms after it
}

throttled := Throttle(1*time.Second, func() {
	// e.g., flush a metrics buffer at most once per second even under
	// a tight loop calling this every microsecond
})
for i := 0; i < 1000; i++ {
	throttled() // only fires roughly once per second across the whole loop
}
```

| | Debounce | Throttle |
|---|---|---|
| Fires on | Last call in a burst, after quiet period | First call in a window, then ignores rest |
| Guarantees regular execution under continuous calls | No — can be delayed indefinitely if calls never stop | Yes — fires at most every `interval`, predictably |
| Typical use | Search input, resize handlers, autosave | Rate-limiting, periodic flush/heartbeat |

---

## 5. Goroutine Leak: Detect and Fix

### The buggy snippet

```go
// BUGGY: leaks a goroutine on every call where the caller times out
// before the worker sends its result.
func fetchWithTimeoutBuggy(timeout time.Duration, work func() int) (int, error) {
	resultCh := make(chan int) // unbuffered

	go func() {
		result := work()
		resultCh <- result // BLOCKS FOREVER if nobody ever receives
	}()

	select {
	case result := <-resultCh:
		return result, nil
	case <-time.After(timeout):
		return 0, errors.New("timed out")
		// The goroutine above is now leaked: it will eventually call
		// work(), then block forever on `resultCh <- result` because
		// this function already returned and nothing will ever read
		// from resultCh again. It never gets garbage collected because
		// it's a live goroutine blocked on a channel send, not because
		// nothing references it.
	}
}
```

**Why it leaks:** `resultCh` is unbuffered and has exactly one reader (the `select`). Once the `select` picks the `time.After` branch and the function returns, no code will ever read from `resultCh` again — but the spawned goroutine is still going to try to send to it once `work()` finishes. A goroutine blocked forever on a channel send is a permanent leak: it holds its stack memory and any resources `work()` captured, for the lifetime of the process.

This is easy to demonstrate with `runtime.NumGoroutine()`:

```go
package concurrency

import (
	"runtime"
	"testing"
	"time"
)

func TestLeakDemonstration(t *testing.T) {
	before := runtime.NumGoroutine()

	for i := 0; i < 100; i++ {
		_, _ = fetchWithTimeoutBuggy(10*time.Millisecond, func() int {
			time.Sleep(50 * time.Millisecond) // always slower than the timeout
			return 42
		})
	}

	time.Sleep(100 * time.Millisecond) // let any leaked goroutines finish their sleep
	after := runtime.NumGoroutine()

	t.Logf("goroutines before=%d after=%d", before, after)
	if after-before < 50 { // expect most of the 100 to still be leaked/blocked
		t.Skip("leak not reliably reproduced in this run — timing dependent, see fixed version below")
	}
}
```

### The fix — buffered channel of size 1

```go
// FIXED: buffered channel means the goroutine's send never blocks, even
// if nobody ever reads the result. The goroutine always completes and
// exits, so it can be garbage collected.
func fetchWithTimeoutFixed(timeout time.Duration, work func() int) (int, error) {
	resultCh := make(chan int, 1) // buffered — send never blocks

	go func() {
		result := work()
		resultCh <- result // always succeeds immediately, buffer absorbs it
	}()

	select {
	case result := <-resultCh:
		return result, nil
	case <-time.After(timeout):
		return 0, errors.New("timed out")
		// Goroutine is NOT leaked: it will complete work(), send into the
		// buffer (succeeds instantly because capacity=1), then exit
		// normally. The unread buffered value is simply garbage collected
		// once resultCh itself becomes unreachable.
	}
}
```

### Alternative fix — context cancellation (preferred for real work)

```go
// BETTER for real production code: propagate cancellation into work()
// itself via context, so wasted CPU work actually stops instead of just
// not leaking memory. Requires work to accept and respect a context.
func fetchWithContext(ctx context.Context, timeout time.Duration, work func(context.Context) (int, error)) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	resultCh := make(chan int, 1)
	errCh := make(chan error, 1)

	go func() {
		result, err := work(ctx)
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()

	select {
	case result := <-resultCh:
		return result, nil
	case err := <-errCh:
		return 0, err
	case <-ctx.Done():
		return 0, ctx.Err() // "context deadline exceeded"
	}
}
```

The buffered-channel fix stops the *leak* (goroutine no longer blocks forever), but `work()` still runs to completion wasting CPU/IO even though nobody cares about the result anymore. The context-based fix additionally lets `work()` itself check `ctx.Done()` and abort early — the correct fix when `work` does meaningful I/O (DB query, HTTP call) that should actually be cancelled, not just abandoned.

### How to catch this class of bug in practice

| Tool | What it catches |
|---|---|
| `go test -race` | Data races, not leaks directly — but often run alongside leak detection |
| [`go.uber.org/goleak`](https://github.com/uber-go/goleak) | Asserts no unexpected goroutines remain at test end — the standard library for this in Go test suites |
| `runtime.NumGoroutine()` in tests | Manual before/after comparison, as shown above — crude but zero-dependency |
| `pprof` goroutine profile (`/debug/pprof/goroutine`) | Production diagnosis — dump goroutine stacks to find what thousands of leaked goroutines are blocked on |
| Code review heuristic | Any unbuffered channel written to by a goroutine with only one possible reader that can disappear (timeout, early return) is a leak candidate |
