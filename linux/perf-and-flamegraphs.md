# perf and Flamegraphs — CPU Profiling and Dynamic Tracing

`perf record` and flamegraphs answer "what is my CPU actually doing?" — the complement to
[ebpf-bpftrace.md](./ebpf-bpftrace.md) (event-driven tracing) and
[strace-perf.md](./strace-perf.md) (`perf stat` hardware counters). This file covers
continuous CPU sampling, flamegraph generation, off-CPU profiling (where threads *block*),
and adding dynamic tracepoints without recompiling.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. perf record — Sampling the CPU

`perf record` samples the instruction pointer at a fixed frequency, captures the call stack,
and writes everything to `perf.data`. This is **statistical profiling** — not every function
call is recorded, but hotspots become statistically visible.

```bash
# Profile a command for 30 seconds at 99 Hz
perf record -F 99 -g -- myapp --flag

# Profile an already-running process
perf record -F 99 -g -p $(pidof myapp) -- sleep 30

# Profile all processes on the system (requires root)
perf record -F 99 -ag -- sleep 30

# -F 99: why 99 not 100?
# 100 Hz is an integer divisor of many timer intervals; 99 Hz avoids phase-locking
# against periodic work (e.g., a 100ms timer fires exactly every 10 samples,
# creating a bias). 99 is prime relative to common intervals.

# Call graph collection methods (--call-graph):
# fp      — uses frame pointers (fast, but requires -fno-omit-frame-pointer at compile time)
# dwarf   — uses DWARF debug info (works without frame pointers; reads up to 8192 bytes of stack)
# lbr     — uses CPU Last Branch Record (Intel only; no DWARF needed; limited depth ~32 frames)

perf record -F 99 -g --call-graph dwarf -p $(pidof java) -- sleep 30
```

**When call graph capture fails (empty stacks):**

```bash
# Go binaries: compile with frame pointers (Go 1.12+ enables by default on amd64)
GOFLAGS="-buildmode=pie" go build -gcflags="-l" .

# Java: requires -XX:+PreserveFramePointer JVM flag
java -XX:+PreserveFramePointer -jar myapp.jar

# Node.js: run with --perf-prof --perf-basic-prof flags
node --perf-prof app.js
# Then: perf inject --jit -i perf.data -o perf.jit.data
```

---

## 2. perf report — Navigating Results

```bash
perf report              # interactive TUI
perf report --stdio      # non-interactive output

# Symbol resolution
perf report --kallsyms=/boot/System.map-$(uname -r)  # kernel symbols
perf report --vmlinux=/usr/lib/debug/boot/vmlinux-$(uname -r)  # kernel with DWARF

# For stripped binaries
perf report --no-children   # show self-time only (not inclusive time of callees)
```

**TUI navigation:** `Enter` expands a symbol to show callers/callees; `a` annotates the
hottest assembly instructions; `q` quits.

**perf report output:**

```
# Overhead  Command  Shared Object        Symbol
    15.32%  myapp    myapp                [.] processRequest
     8.71%  myapp    libc-2.31.so         [.] malloc
     6.44%  myapp    [kernel]             [k] __x86_64_sys_read
```

- `[.]` — userspace symbol
- `[k]` — kernel symbol
- `Overhead` — % of samples this function appeared in (inclusive = self + callees)

---

## 3. Flamegraphs — Reading and Generating

A flamegraph is an SVG where:
- **X-axis** = total time (wider = more samples = hotter)
- **Y-axis** = call stack depth (top = where CPU was; below = callers)
- **Colors** = random/informational (NOT heat — the name is a misnomer)

```mermaid
flowchart LR
    classDef tool fill:#3498db,stroke:#2471a3,color:#fff
    classDef data fill:#27ae60,stroke:#1e8449,color:#fff
    classDef out fill:#9b59b6,stroke:#7d3c98,color:#fff

    RECORD["perf record -F 99 -g"]:::tool
    DATA["perf.data"]:::data
    SCRIPT["perf script"]:::tool
    STACKS["raw stacks (text)"]:::data
    COLLAPSE["stackcollapse-perf.pl"]:::tool
    FOLDED["folded stacks"]:::data
    FG["flamegraph.pl"]:::tool
    SVG["flamegraph.svg"]:::out

    RECORD --> DATA --> SCRIPT --> STACKS --> COLLAPSE --> FOLDED --> FG --> SVG
```

```bash
# Full pipeline (Brendan Gregg's scripts)
git clone https://github.com/brendangregg/FlameGraph
cd FlameGraph

perf record -F 99 -ag --call-graph dwarf -- sleep 30
perf script | ./stackcollapse-perf.pl > out.perf-folded
./flamegraph.pl out.perf-folded > flamegraph.svg
open flamegraph.svg     # or serve via HTTP and view in browser
```

**Differential flamegraph** — compare before and after a change:

```bash
# Before: profile baseline
perf record -F 99 -ag --call-graph dwarf -o baseline.data -- sleep 30
perf script -i baseline.data | ./stackcollapse-perf.pl > baseline.folded

# After: profile with change
perf record -F 99 -ag --call-graph dwarf -o changed.data -- sleep 30
perf script -i changed.data | ./stackcollapse-perf.pl > changed.folded

# Differential flamegraph (red = regression, blue = improvement)
./difffolded.pl baseline.folded changed.folded | ./flamegraph.pl > diff.svg
```

**Common flamegraph patterns:**

| Pattern | What it means |
|---|---|
| Tall, narrow tower | Deep call stack; usually not a problem |
| Wide, flat plateau at the top | CPU-intensive function — the bottleneck |
| Many thin towers | Many different code paths; no single hotspot |
| Wide base in syscalls/kernel | System call overhead (I/O, locking) |
| `[unknown]` frames | Missing debug symbols or frame pointers |

<div class="quiz-card">
  <p class="quiz-q">A flamegraph shows 40% of samples in `malloc` → `mmap` → `__brk` with a wide plateau. What does this indicate and what should you investigate?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>40% of CPU time in memory allocation — the application is spending nearly half its cycles just allocating memory. This is a memory allocation hotspot, usually caused by: (1) excessive small object allocation (create many short-lived objects per request), (2) a missing object pool/cache that should reuse allocations, (3) a memory leak causing the heap to grow and mmap new pages repeatedly. Investigate with: (1) check if a custom allocator (jemalloc, tcmalloc) would help — they reduce lock contention and fragmentation; (2) use `valgrind --tool=massif` or Go pprof heap profiles to find the allocation site; (3) check if object pooling (`sync.Pool` in Go, a free list in C++) can reduce pressure; (4) look at GC pressure in managed runtimes (Java/Go) — the flamegraph may show GC work inflating the malloc samples.</div>
</div>

---

## 4. On-CPU vs Off-CPU Profiling

`perf record` captures **on-CPU** time — what the CPU is executing. But a slow service might
spend most of its time **off-CPU** — blocked on I/O, locks, or sleep.

**Off-CPU profiling with perf:**

```bash
# Trace scheduler context switches to find where threads block
perf record -e sched:sched_switch -ag -- sleep 30
perf script | awk '{print $1, $2}' | sort | uniq -c | sort -rn | head -20
```

**Off-CPU flamegraph with eBPF (faster, lower overhead):**

```bash
# Using BCC's offcputime
/usr/share/bcc/tools/offcputime -p $(pidof myapp) 30 | \
  stackcollapse.pl | flamegraph.pl > offcpu.svg

# Using bpftrace
bpftrace -e '
tracepoint:sched:sched_switch
/ args->prev_state != 0 && args->prev_pid == <PID> /
{ @[ustack] = count(); }'
```

**perf trace — syscall latency breakdown:**

```bash
# Show all syscalls and their latencies for a process
perf trace -p $(pidof myapp) 2>&1 | head -50

# Output:
# 0.000 read(3, 0x7f..., 4096) = 4096 (0.012 ms)
# 0.013 epoll_wait(5, [], 1024, 100) = 3 (99.998 ms)
# 100.012 write(4, 0x7f..., 256) = 256 (0.008 ms)

# epoll_wait at 100ms = thread was sleeping waiting for events — off-CPU time
# High read latency = I/O bottleneck
```

---

## 5. perf probe — Dynamic Tracepoints

`perf probe` inserts a kprobe or uprobe at a function entry/return without kernel patches
or recompilation:

```bash
# Add a probe at tcp_sendmsg, capturing the 'size' argument
perf probe --add 'tcp_sendmsg size'
# Added new event: probe:tcp_sendmsg (on tcp_sendmsg with size)

# Probe a specific line in a function (requires debug info)
perf probe --add 'tcp_sendmsg:10 size'

# List available probe points in a function
perf probe -L tcp_sendmsg

# Record with the probe
perf record -e probe:tcp_sendmsg -ag -- sleep 10
perf script
# myapp  12345 [000]  1234.5: probe:tcp_sendmsg: (ffffffff81a23400) size=1448

# Remove probe
perf probe --del tcp_sendmsg

# Userspace probe (USDT)
perf probe --exec=/usr/bin/python3 --add 'function__entry'
perf record -e sdt_python3:function__entry -p $(pidof python3) -- sleep 10
```

**When to use perf probe vs bpftrace:** perf probe is good for one-shot investigation with
minimal setup. bpftrace is better for complex logic (aggregations, histograms, conditions).

---

## 6. perf mem — Memory Access Profiling

```bash
# Sample memory loads/stores and attribute them to cache level
perf mem record -p $(pidof myapp) -- sleep 10
perf mem report

# Output:
# Overhead  Mem level            Symbol
#   22.5%   L1 hit               processMessage
#   18.3%   L3 miss              deserializePayload  ← cache thrash
#    5.2%   Remote hit (NUMA)    globalStateUpdate   ← NUMA miss

# L3 miss = cache miss requiring DRAM access (~60 cycles)
# Remote hit = NUMA remote memory access (~200 cycles vs ~70 local)
```

L3 misses and NUMA remote accesses in a hot path are worth investigating: data layout
changes (struct alignment, AoS → SoA), NUMA binding ([numa-irq-tuning.md](./numa-irq-tuning.md)),
or cache-oblivious algorithms.

---

## 7. perf kvm — VM Exit Profiling

For processes running inside VMs or KVM hypervisors, `perf kvm` attributes CPU time to
the type of VMEXIT (the event that transitions from guest to hypervisor):

```bash
# On the KVM host, profile VM exits for guest PID
perf kvm stat record -a -- sleep 10
perf kvm stat report

# Output:
# VM-EXIT                  Samples   Samples%   Time%   Min Time   Max Time
# EXTERNAL_INTERRUPT          12345       45.2   23.1%   0.15μs     142μs
# HLT                          5678       20.8   15.3%   ...
# EPT_VIOLATION               3456       12.7   45.0%  ← expensive
# IO_INSTRUCTION              2345        8.6    5.2%
```

**Expensive VMEXIT types:**

| VMEXIT | Cause | Fix |
|---|---|---|
| `EPT_VIOLATION` | Guest page table walk (extended page tables miss) | Use huge pages in guest; fix memory layout |
| `EXTERNAL_INTERRUPT` | Device interrupt | Use virtio with interrupt coalescing; pin vCPU IRQs |
| `IO_INSTRUCTION` | PIO device access | Use MMIO devices (virtio); avoid legacy PCI I/O ports |
| `HLT` | Guest CPU halted (idle) | Normal; vCPU yield to host |

---

## 8. perf stat — Hardware Counter Characterization

`perf stat` (covered briefly in [strace-perf.md](./strace-perf.md)) characterizes workload efficiency:

```bash
perf stat -e cycles,instructions,cache-misses,branch-misses,context-switches \
  -p $(pidof myapp) -- sleep 10

# Performance counter stats:
#    20,123,456,789   cycles
#    15,234,567,890   instructions   # IPC = 15.2/20.1 = 0.76
#         1,234,567   cache-misses   # cache-miss rate = 1.2M/10s
#           234,567   branch-misses
#             5,678   context-switches
#
# IPC = Instructions Per Cycle. Theoretical max = 4 on modern OOO CPUs.
# IPC < 1.0  → memory-bound (waiting for cache/DRAM)
# IPC 1-3    → reasonable
# IPC > 3    → compute-bound (good; approaching HW limit)
```

---

## Quick Reference

```
Sample CPU at 99 Hz               perf record -F 99 -g -p <pid> -- sleep 30
Flamegraph pipeline               perf script | stackcollapse-perf.pl | flamegraph.pl > fg.svg
Differential flamegraph           difffolded.pl before.folded after.folded | flamegraph.pl > diff.svg
perf report TUI                   perf report
Annotate hot instruction          perf annotate (or 'a' in TUI)
Syscall latency                   perf trace -p <pid>
Off-CPU time                      offcputime (BCC) or bpftrace sched:sched_switch
Add kernel probe                  perf probe --add 'tcp_sendmsg size'
Add userspace probe               perf probe --exec=/path/to/bin --add 'funcname'
Remove probe                      perf probe --del <name>
Memory access profiling           perf mem record + perf mem report
VM exit breakdown                 perf kvm stat record + perf kvm stat report
IPC characterization              perf stat -e cycles,instructions -p <pid>
IPC < 1 → memory-bound            Use perf mem to find cache misses
Why 99 Hz                         Avoids phase-locking with timer intervals (99 is prime-like)
Call graph: frame pointer         --call-graph fp (fast; needs -fno-omit-frame-pointer)
Call graph: DWARF                 --call-graph dwarf (works on most binaries)
```
