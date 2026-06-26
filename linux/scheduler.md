# Linux Scheduler

---

## CFS — Completely Fair Scheduler

Linux's default process scheduler since kernel 2.6.23. Goal: give every runnable process a fair share of CPU time.

```mermaid
graph TD
    classDef rq   fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef rbt  fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef task fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef cpu  fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    subgraph PerCPU["Per-CPU Run Queue"]
        RQ["Run Queue one per CPU core"]:::rq
        RBT["Red-Black Tree ordered by vruntime leftmost node = next to run"]:::rbt
        CURR["Currently running task"]:::cpu
    end

    T1["Task A vruntime: 1000ms"]:::task
    T2["Task B vruntime: 1200ms"]:::task
    T3["Task C vruntime: 800ms leftmost — runs next"]:::task

    T3 --> RBT
    T1 --> RBT
    T2 --> RBT
    RBT --> CURR
```

**vruntime (virtual runtime):**
- Each task tracks `vruntime` — how much CPU time it has consumed, weighted by priority
- CFS always picks the task with the smallest `vruntime` (leftmost node in the red-black tree)
- Nice value modifies how fast `vruntime` advances: nice -20 (highest priority) → vruntime advances slowly → gets scheduled more often

**Scheduling latency (`sysctl kernel.sched_latency_ns`, default 6ms):** CFS guarantees every runnable task gets CPU within this window. With 10 tasks, each gets 0.6ms per cycle.

---

## Nice Values and Priority

```mermaid
graph LR
    classDef high  fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef norm  fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef low   fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    N_20["nice -20 Highest priority vruntime advances slowest gets most CPU"]:::high
    N_0["nice 0 Default normal CPU share"]:::norm
    N_19["nice +19 Lowest priority vruntime advances fastest gets least CPU"]:::low

    N_20 --- N_0 --- N_19
```

```bash
# Start process with lower priority (background batch job)
nice -n 10 ./my-batch-job

# Change priority of running process
renice -n 5 -p <PID>

# Check priority (NI column in top/ps)
ps -o pid,ni,pri,cmd -p <PID>
```

**Real-time priorities** (bypass CFS entirely):
- `SCHED_FIFO` / `SCHED_RR` — fixed priority, preempts CFS tasks. Used by audio daemons, real-time systems.
- `chrt -f 50 ./realtime-app` — run with FIFO scheduling at priority 50

---

## CPU Affinity

Pin a process/thread to specific CPU cores. Useful for: reducing cache misses (L1/L2 cache is per-core), isolating latency-sensitive workloads, NUMA-aware placement.

```bash
# Pin process to cores 0 and 1
taskset -c 0,1 ./my-app

# Pin running process
taskset -c 2,3 -p <PID>

# Check current affinity
taskset -cp <PID>

# In Go: use GOMAXPROCS and runtime.LockOSThread()
# For CPU-intensive goroutines that need to stay on one core
```

**NUMA (Non-Uniform Memory Access):** Multi-socket servers have memory banks local to each CPU socket. Accessing memory on the remote socket takes ~2x longer. `numactl --cpubind=0 --membind=0 ./app` forces both process and memory allocation to NUMA node 0.

---

## Context Switches

A context switch is the CPU saving one process's state (registers, instruction pointer, stack pointer) and loading another's.

```mermaid
graph LR
    classDef running fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef saved   fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef kern    fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    P1["Process A running registers in CPU"]:::running
    SAVE["Kernel saves A's register state to task_struct"]:::kern
    LOAD["Kernel loads B's register state from task_struct"]:::kern
    P2["Process B running registers in CPU"]:::running
    COST["Cost: ~1-10 microseconds plus TLB flush if different address space plus cache pollution"]:::saved

    P1 --> SAVE --> LOAD --> P2
    LOAD -.- COST
```

**Voluntary vs involuntary:**
- **Voluntary:** process calls `sleep()`, `read()` (blocks), `mutex_lock()` (contended)
- **Involuntary:** time slice expires, higher-priority task becomes runnable

```bash
# Count context switches per second (cs column)
vmstat 1

# Per-process context switches
cat /proc/<PID>/status | grep ctxt
# voluntary_ctxt_switches:   1234
# nonvoluntary_ctxt_switches: 56
```

High `nonvoluntary_ctxt_switches` = process is being preempted often = CPU-bound. High `voluntary_ctxt_switches` = process blocks often = I/O-bound.

---

## Go's Goroutine Scheduler (GMP Model)

Go implements its own user-space scheduler on top of the Linux CFS scheduler.

```mermaid
graph TD
    classDef g    fill:#00add8,stroke:#007d9c,color:#fff,rx:8
    classDef m    fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef p    fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef kern fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8

    subgraph GMP["GMP: Goroutine-Machine-Processor"]
        G1["G: Goroutine user-space thread ~2KB initial stack can grow to 1GB"]:::g
        G2["G: Goroutine"]:::g
        G3["G: Goroutine"]:::g

        P1["P: Processor has local run queue max GOMAXPROCS Ps"]:::p
        P2["P: Processor"]:::p

        M1["M: OS Thread runs on CPU core Linux thread (clone)"]:::m
        M2["M: OS Thread"]:::m

        KERN["Linux Kernel CFS schedules M threads"]:::kern
    end

    G1 --> P1
    G2 --> P1
    G3 --> P2
    P1 --> M1
    P2 --> M2
    M1 --> KERN
    M2 --> KERN
```

**How it works:**
- **G (Goroutine):** user-space coroutine with a small stack. Millions can exist.
- **P (Processor):** logical processor, has a local run queue of Gs. Count = `GOMAXPROCS` (default: number of CPU cores).
- **M (Machine):** OS thread. Runs Gs from a P's queue. Usually M count ≈ P count, but can grow if Gs block on syscalls.

**Work stealing:** If P1's queue is empty, it steals half of P2's queue. Keeps all cores busy.

**Goroutine preemption:** Go 1.14+ supports async preemption — a goroutine can be preempted at any safe point (via signals), not just at function calls. Prevents one tight loop from starving other goroutines.

**GOMAXPROCS = 1:** All goroutines run on one OS thread. No parallelism, only concurrency. Useful for debugging race conditions.

```bash
# Set at runtime
export GOMAXPROCS=4

# Or in code
runtime.GOMAXPROCS(runtime.NumCPU())

# View scheduler trace
GODEBUG=schedtrace=1000 ./myapp   # print scheduler state every 1000ms
GODEBUG=scheddetail=1 ./myapp     # verbose goroutine scheduling
```
