# cgroup v2 — Resource Control

cgroup v2 is the unified hierarchy used by all modern Linux distributions and Kubernetes (>= 1.25 with containerd).

---

## Hierarchy

```
/sys/fs/cgroup/                      ← cgroup v2 root
├── cpu.max                          ← system-wide CPU limit (max)
├── memory.max
├── kubepods.slice/                  ← K8s pods
│   ├── besteffort.slice/
│   ├── burstable.slice/
│   └── guaranteed.slice/
│       └── pod<uid>/
│           └── <container-id>/
│               ├── cpu.max          ← CPU quota
│               ├── cpu.weight       ← relative CPU shares
│               ├── memory.max       ← hard memory limit
│               ├── memory.high      ← soft limit (triggers reclaim)
│               ├── memory.current   ← current RSS
│               ├── memory.events    ← OOM event counter
│               ├── io.max           ← I/O bandwidth limit
│               └── pids.max         ← PID limit
└── system.slice/                    ← systemd services
```

---

## CPU Control

### cpu.max — Quota (hard limit)

```bash
cat /sys/fs/cgroup/kubepods.slice/.../cpu.max
# 50000 100000
# format: quota period (microseconds)
# 50000/100000 = 0.5 cores = 500m in K8s notation

# Set: 1 CPU out of every 100ms window
echo "100000 100000" > cpu.max

# Unlimited
echo "max 100000" > cpu.max
```

### cpu.weight — Shares (relative scheduling)

```bash
cat cpu.weight
# 100  ← default weight (range 1-10000)

# Double this cgroup's CPU share vs default
echo 200 > cpu.weight
```

### Throttling detection

```bash
cat cpu.stat
# usage_usec 123456789      ← total CPU time consumed
# user_usec  100000000
# system_usec 23456789
# nr_periods  1000           ← scheduler periods elapsed
# nr_throttled 234           ← periods where cgroup was throttled
# throttled_usec 4567890     ← total time throttled

# Throttle % = nr_throttled / nr_periods × 100
# > 5% sustained = CPU limit too low for workload
```

**K8s mapping:**

| K8s field | cgroup file | Formula |
|-----------|-------------|---------|
| `resources.limits.cpu: "500m"` | `cpu.max` | `50000 100000` |
| `resources.requests.cpu: "250m"` | `cpu.weight` | `round(1024 × 0.25)` = 256 |

---

## Memory Control

```bash
# Hard limit — exceeding this triggers OOM kill
cat memory.max       # e.g. 536870912 (512Mi)

# Soft limit — triggers aggressive reclaim before OOM
cat memory.high      # e.g. 483183820 (~90% of max)

# Current RSS
cat memory.current

# OOM events
cat memory.events
# low 0
# high 14          ← hit memory.high 14 times (reclaim triggered)
# max 0
# oom 0            ← full OOM kills
# oom_kill 0

# Kill entire cgroup on OOM (not just one process)
cat memory.oom.group   # 1 = enabled in K8s containers
```

---

## Memory Pressure Files (PSI)

PSI (Pressure Stall Information) measures how much time tasks are stalled waiting for a resource. Available for cpu, memory, io.

```bash
cat /proc/pressure/memory
# some avg10=0.50 avg60=1.20 avg300=0.80 total=12345678
# full avg10=0.10 avg60=0.30 avg300=0.20 total=3456789
#
# some = at least one task stalled
# full = ALL tasks stalled (severe — no progress at all)
# avg10/60/300 = % of time stalled over 10s/60s/5m windows

cat /proc/pressure/cpu
cat /proc/pressure/io

# Also per-cgroup:
cat /sys/fs/cgroup/kubepods.slice/pod<uid>/<cid>/memory.pressure
```

**Thresholds to alert on:**

| PSI metric | Warning | Critical |
|------------|---------|---------|
| `memory some avg60` | > 10% | > 30% |
| `memory full avg60` | > 1% | > 5% |
| `io full avg60` | > 5% | > 20% |

---

## I/O Control

```bash
# Format: MAJ:MIN rbps wbps riops wiops
cat io.max
# 8:0 rbps=10485760 wbps=10485760 riops=max wiops=max
# 10 MB/s read + write, unlimited IOPS

# Set limits (device 8:0)
echo "8:0 rbps=52428800 wbps=52428800" > io.max   # 50MB/s

# I/O usage stats
cat io.stat
# 8:0 rbytes=123456 wbytes=654321 rios=100 wios=200 dbytes=0 dios=0
```

---

## PID Limiting

```bash
# Prevent fork bombs
cat pids.max    # e.g. 1024
cat pids.current

# Set limit
echo 512 > pids.max
```

---

## Hands-on: Inspect a Running Container

```bash
# Find container's cgroup path
CONTAINER_ID=$(docker inspect --format '{{.Id}}' mycontainer)
CGROUP=/sys/fs/cgroup/system.slice/docker-${CONTAINER_ID}.scope

# CPU quota and current throttling
cat $CGROUP/cpu.max
cat $CGROUP/cpu.stat | grep throttled

# Memory usage vs limit
echo "Limit: $(cat $CGROUP/memory.max)"
echo "Usage: $(cat $CGROUP/memory.current)"
echo "OOM events: $(grep oom_kill $CGROUP/memory.events)"

# Is this container under memory pressure right now?
cat $CGROUP/memory.pressure
```

---

## cgroup v1 vs v2

| Feature | v1 | v2 |
|---------|----|----|
| Hierarchy | Multiple trees per subsystem | Single unified tree |
| CPU shares file | `cpu.shares` | `cpu.weight` |
| CPU quota file | `cpu.cfs_quota_us` | `cpu.max` |
| Memory limit | `memory.limit_in_bytes` | `memory.max` |
| PSI support | No | Yes |
| Writeback control | No | Yes |
| K8s default since | < 1.25 | >= 1.25 (containerd) |

```bash
# Check which version is active
stat -f -c %T /sys/fs/cgroup
# cgroup2fs → v2
# tmpfs     → v1 (hybrid if /sys/fs/cgroup/unified exists)
```
