# Memory Tuning

## 1. /proc/meminfo — Key Fields

```bash
cat /proc/meminfo
```

```
MemTotal:       16384000 kB   # Total physical RAM
MemFree:          512000 kB   # Completely unused RAM
MemAvailable:    8192000 kB   # Estimated available for new processes
Buffers:          256000 kB   # Block device read cache (metadata)
Cached:          4096000 kB   # Page cache (file data)
SwapCached:        12000 kB   # Swap data also in RAM
Active:          6144000 kB   # Recently used, not easily reclaimable
Inactive:        3072000 kB   # LRU candidates for reclaim
Dirty:             64000 kB   # Modified pages not yet written to disk
Writeback:          8000 kB   # Pages being written to disk now
Slab:             512000 kB   # Kernel data structures
SReclaimable:     256000 kB   # Reclaimable slab (dentries/inodes)
SUnreclaim:       256000 kB   # Unreclaimable slab
```

**Critical distinction — MemFree vs MemAvailable:**

| Field | Meaning |
|-------|---------|
| `MemFree` | Pages with nothing in them — misleadingly low on healthy systems |
| `MemAvailable` | MemFree + reclaimable buffers/cache + part of slab. **Use this** to judge if memory is available for a new process |

> A server with MemFree=100MB but MemAvailable=8GB is healthy. The kernel uses free RAM for caching aggressively.

---

## 2. Swap and Swappiness

```bash
# Show swap usage
swapon --show
free -h

# Swappiness control
sysctl vm.swappiness
sysctl -w vm.swappiness=10
```

**vm.swappiness values:**

| Value | Behaviour |
|-------|-----------|
| `0` | Swap only to avoid OOM; never proactively |
| `10` | Low swap tendency; prefer to reclaim file cache (recommended for DBs) |
| `60` | Default; balanced |
| `100` | Swap aggressively; treat file cache and anon memory equally |

**Persist:**
```bash
echo "vm.swappiness = 10" >> /etc/sysctl.d/99-memory.conf
sysctl -p /etc/sysctl.d/99-memory.conf
```

**When swap is useful vs harmful:**
- Useful: cushion for rarely-accessed JVM heap; allows overcommit for fork-heavy workloads
- Harmful: database buffers getting swapped causes 100ms+ latency spikes; use `swappiness=1` for MySQL/PostgreSQL/Redis

---

## 3. OOM Killer

When physical memory + swap is exhausted, the kernel OOM killer selects and kills a process.

**Score calculation:**
```
oom_score = (process_rss / total_memory) × 1000
          + oom_score_adj
```

- Higher score → killed first
- `oom_score_adj` range: -1000 (never kill) to +1000 (always kill first)

```bash
# Check a process's OOM score
cat /proc/1234/oom_score
cat /proc/1234/oom_score_adj

# Protect critical process (e.g., sshd)
echo -1000 > /proc/$(pgrep sshd)/oom_score_adj

# Make process OOM target
echo 500 > /proc/$(pgrep myapp)/oom_score_adj

# Persist via unit file — in [Service] section:
# OOMScoreAdjust=-500
```

**Reading OOM events in dmesg:**
```bash
dmesg -T | grep -i "oom\|killed process\|out of memory"
```

```
Out of memory: Kill process 5432 (java) score 892 or sacrifice child
Killed process 5432 (java) total-vm:4194304kB, anon-rss:3145728kB
```

- `score 892` — oom_score at time of kill
- `anon-rss` — anonymous (heap/stack) RSS
- `total-vm` — virtual address space (larger than physical)

```mermaid
flowchart TD
    A[Alloc fails] --> B{RAM+swap<br/>exhausted?}
    B -->|No| C[Reclaim cache<br/>retry alloc]
    B -->|Yes| D[OOM killer invoked]
    D --> E[Score each process<br/>rss/total x 1000]
    E --> F[Add oom_score_adj]
    F --> G{adj = -1000?}
    G -->|Yes skip| E
    G -->|No| I[Highest score wins]
    I --> J[SIGKILL sent]
    J --> K[Memory freed<br/>alloc retried]
```

---

## 4. Dirty Pages

Dirty pages are modified memory pages not yet flushed to disk. Too many → data loss risk on crash. Too aggressive flushing → I/O spikes.

```bash
# Current dirty page stats
cat /proc/meminfo | grep -i dirty
grep -r "" /proc/sys/vm/dirty*
```

**Tuning parameters:**

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `vm.dirty_ratio` | 20 | % of total memory: if exceeded, processes block waiting for writeback |
| `vm.dirty_background_ratio` | 10 | % of total memory: background writeback starts at this threshold |
| `vm.dirty_expire_centisecs` | 3000 | Pages dirty longer than 30s are written |
| `vm.dirty_writeback_centisecs` | 500 | Flush daemon wakes every 5s |

```bash
# Reduce for databases (minimize write spikes)
sysctl -w vm.dirty_ratio=5
sysctl -w vm.dirty_background_ratio=2

# Force flush all dirty pages now
sync && echo 3 > /proc/sys/vm/drop_caches
```

---

## 5. Transparent Huge Pages (THP)

THP automatically promotes 4KB pages to 2MB huge pages to reduce TLB pressure.

**Benefits:**
- Fewer TLB entries needed for large working sets
- Reduced page table walk overhead
- Beneficial for: in-memory analytics, scientific computing, large JVM heaps

**Problems:**
- `khugepaged` daemon compacts memory in background — causes latency spikes of 10-100ms
- Especially harmful for: Redis, MySQL, PostgreSQL, MongoDB, Cassandra

```bash
# Check current setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# Disable for databases
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

**Opt in selectively (recommended approach):**
```c
// In application code, use madvise for specific regions
madvise(ptr, size, MADV_HUGEPAGE);   // request THP
madvise(ptr, size, MADV_NOHUGEPAGE); // opt out
```

Set `/sys/kernel/mm/transparent_hugepage/enabled` to `madvise` — only allocate huge pages when explicitly requested.

---

## 6. Memory cgroups v2 — How K8s Limits Work

Kubernetes uses cgroups v2 to enforce memory limits on pods/containers.

```
/sys/fs/cgroup/
└── kubepods.slice/
    └── pod<uid>/
        └── <container-id>/
            ├── memory.max        ← hard limit (limits.memory)
            ├── memory.high       ← soft limit (triggers reclaim)
            ├── memory.current    ← current usage
            └── memory.oom.group  ← kill whole cgroup on OOM
```

```bash
# Check container memory limits from host
cat /sys/fs/cgroup/kubepods.slice/pod<uid>/<cid>/memory.max

# Current usage
cat /sys/fs/cgroup/kubepods.slice/pod<uid>/<cid>/memory.current

# OOM events for this cgroup
cat /sys/fs/cgroup/kubepods.slice/pod<uid>/<cid>/memory.events
```

**K8s limit mapping:**

| K8s field | cgroup file | Effect |
|-----------|-------------|--------|
| `resources.limits.memory` | `memory.max` | Hard limit; exceeding → OOM kill |
| `resources.requests.memory` | scheduling hint | No cgroup enforcement |
| — | `memory.high` | ~90% of limit; triggers aggressive reclaim before OOM |

**OOMKilled pod:** When a container exceeds `memory.max`, the kernel OOM killer kills the cgroup's processes. K8s reports `OOMKilled` in pod status and restarts the container if `restartPolicy: Always`.

---

## 7. Practical Commands

```bash
# Overview: total, used, free, shared, buff/cache, available
free -h

# Virtual memory stats every second (key: si/so = swap in/out)
vmstat 1
# si > 0 or so > 0 → active swapping → investigate

# Per-process memory summary (RSS, PSS, Swap)
cat /proc/1234/smaps_rollup

# Sort processes by RSS
ps aux --sort=-%mem | head -20

# Detailed memory map for a process
pmap -x 1234

# Page fault stats
ps -o pid,min_flt,maj_flt -p 1234
# maj_flt > 0 → page faults requiring disk I/O

# Check for memory pressure events
dmesg | grep -i "memory\|oom\|killed"
```

**vmstat key columns:**

| Column | Meaning |
|--------|---------|
| `r` | Runnable processes (if > CPUs → CPU saturated) |
| `b` | Processes blocked on I/O |
| `swpd` | Virtual memory used (total swap) |
| `si` | Swap in (from disk to RAM) — bad if > 0 |
| `so` | Swap out (from RAM to disk) — bad if > 0 |
| `bi` | Blocks read from disk |
| `bo` | Blocks written to disk |

```mermaid
graph TD
    VA[Virtual Address Space] -->|page fault| PA[Physical RAM]
    PA -->|evict file-backed| PC[Page Cache]
    PA -->|evict anon pages| SW[Swap Space]
    SW -->|swap-in on access| PA
    PC -->|writeback| DISK[Disk / Storage]

    PA -->|MemAvailable low| OOM[OOM Killer]
    PA -->|dirty_ratio hit| WB[Writeback stall]
    SW -->|si/so > 0| LAT[Latency spike]
```

---

## OOM Killer — Score Tuning and Process Protection

The Linux OOM killer picks a victim using an **oom_score** (0–1000). Higher score = more likely to be killed. The score is calculated from memory usage as a percentage of total RAM, with adjustments.

### Reading and tuning OOM scores

```bash
# See the current OOM score for a process
cat /proc/<pid>/oom_score
# 0 = never killed (init/systemd), 1000 = killed first

# See the OOM score adjustment (tunable by root or the process itself)
cat /proc/<pid>/oom_score_adj
# Range: -1000 to +1000
# -1000 = completely exempt from OOM killing (use for critical daemons)
# +1000 = first target when OOM occurs
# 0     = default (no adjustment)

# Protect a critical process (e.g., your monitoring agent)
echo -1000 > /proc/$(pidof prometheus)/oom_score_adj

# Make a low-priority process the first OOM target
echo 1000 > /proc/$(pidof batch-job)/oom_score_adj

# Persist across restarts (systemd unit file)
# [Service]
# OOMScoreAdjust=-1000
```

**Kubernetes and oom_score_adj:**
```
QoS class         oom_score_adj set by kubelet
Guaranteed        -997   (protected, killed last)
Burstable         2 to 999  (proportional to memory usage vs request)
BestEffort        1000   (killed first)
```

The kubelet sets `oom_score_adj` automatically based on QoS class. This is why Guaranteed pods survive node memory pressure while BestEffort pods are the first to go.

### Memory pressure debugging with PSI

Pressure Stall Information (PSI) gives a percentage of time tasks were stalled waiting for memory. Available in kernels 4.20+ and cgroup v2.

```bash
# System-wide memory pressure (requires CONFIG_PSI=y)
cat /proc/pressure/memory
# some avg10=12.50 avg60=5.20 avg300=2.10 total=8732101
# full avg10=0.50  avg60=0.20 avg300=0.10 total=1231456

# "some" = at least one task stalled (memory unavailable for at least one process)
# "full" = ALL tasks stalled (all processes waiting for memory simultaneously)
# avg10/60/300 = percentage over last 10s / 60s / 300s

# Per-cgroup PSI (for specific pods/containers)
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/memory.pressure
# Same format — shows pressure for that specific cgroup

# A value above 20% on avg60 = significant memory contention
# A value above 5% on "full" = severe pressure, consider adding RAM

# Monitor PSI with a simple threshold alert (bash)
while true; do
  psi=$(awk '/some/{print $2}' /proc/pressure/memory | cut -d= -f2)
  if (( $(echo "$psi > 20" | bc -l) )); then
    echo "ALERT: memory pressure avg10=$psi%"
  fi
  sleep 10
done
```

### Swap behavior

```bash
# Check current swap usage
free -h
swapon --show

# vm.swappiness controls tendency to swap (0-200, default 60)
# 0  = avoid swapping until absolutely necessary (memory filled)
# 60 = balanced (kernel's default)
# 100 = swap aggressively to keep file cache warm
# 200 = (kernel 5.8+) swap memory pages even if RAM available (for memory pressure early-warning)

# Check current value
cat /proc/sys/vm/swappiness

# Tune for a latency-sensitive server (prefer keeping process pages in RAM)
sysctl -w vm.swappiness=10
echo "vm.swappiness=10" >> /etc/sysctl.d/99-memory.conf

# Tune for a desktop or batch workload (aggressive swap)
sysctl -w vm.swappiness=80
```

**zswap — compressed swap in RAM (best of both worlds):**
```bash
# zswap compresses evicted pages and stores them in a RAM pool
# before writing to disk. Reduces I/O, improves swap performance.
# Enable:
echo 1 > /sys/module/zswap/parameters/enabled
echo lz4 > /sys/module/zswap/parameters/compressor
echo 20 > /sys/module/zswap/parameters/max_pool_percent  # max 20% of RAM

# Check zswap stats
cat /sys/kernel/debug/zswap/*
```

### Memory pressure debugging workflow

```bash
# 1. Check if OOM kills are happening
dmesg -T | grep -i "oom\|killed process\|out of memory"
# Output: "Out of memory: Kill process 12345 (java) score 891"
# "Killed process 12345 (java) total-vm:2097152kB, anon-rss:1048576kB"

# 2. Identify what's consuming memory
ps aux --sort=-%mem | head -20
cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|Cached|Buffers|SwapTotal|SwapFree"
# MemAvailable = actual available (includes reclaimable cache) — more accurate than MemFree

# 3. Find memory-hungry cgroups (K8s nodes)
find /sys/fs/cgroup/kubepods -name "memory.current" -exec sh -c 'echo "$1: $(cat $1)" ' _ {} \; | sort -t: -k2 -n | tail -10

# 4. Check for slab cache bloat
slabtop -o | head -20
cat /proc/slabinfo | sort -k3 -rn | head -20
# inode_cache, dentry_cache, kmalloc-* growing = likely a kernel memory leak

# 5. Check transparent huge pages — THP can cause latency spikes
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# "always" causes compaction stalls. For latency-sensitive:
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# 6. Drop caches to reclaim if legitimate need
# (safe to do — kernel will repopulate from disk on next access)
sync && echo 3 > /proc/sys/vm/drop_caches
# 1 = page cache only, 2 = dentries/inodes, 3 = both
# WARNING: causes temporary I/O spike as caches repopulate
```

### GOMEMLIMIT — Go garbage collector and K8s memory limits

Go 1.19+ supports `GOMEMLIMIT` — a soft memory limit that tells the GC to collect more aggressively before reaching the limit. Set it to ~90% of the K8s memory limit to prevent OOMKill.

```yaml
env:
  - name: GOMEMLIMIT
    valueFrom:
      resourceFieldRef:
        resource: limits.memory
        divisor: "1"   # bytes
# This sets GOMEMLIMIT = limits.memory value exactly
# Better: set to 90% via init container or manually:
  - name: GOMEMLIMIT
    value: "460MiB"   # 90% of 512Mi limit
```

Without `GOMEMLIMIT`, Go GC targets 100% heap growth by default. The heap can spike 2x before GC kicks in — easily exceeding K8s memory limits → OOMKill. With `GOMEMLIMIT`, GC collects proactively near the limit.
