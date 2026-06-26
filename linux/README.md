# Linux Internals

Everything — containers, Kubernetes, networking, storage — is built on Linux. This is the foundation layer.

| File | Topics |
|------|--------|
| [README.md](./README.md) | Kernel architecture, processes, memory, filesystem, load average, file descriptors, top metrics, /proc and /sys |
| [networking.md](./networking.md) | TCP/IP stack, sockets, accept queue, TCP states, TIME_WAIT, netfilter/iptables, kernel tuning |
| [io-models.md](./io-models.md) | Blocking I/O, select/poll, epoll, Go netpoller, io_uring |
| [scheduler.md](./scheduler.md) | CFS, vruntime, nice values, CPU affinity, context switches, Go GMP model |
| [boot.md](./boot.md) | BIOS/UEFI, GRUB, initramfs, systemd, unit files |
| [security.md](./security.md) | Capabilities, setuid, seccomp, AppArmor, SELinux, defense in depth |
| [containers-evolution.md](./containers-evolution.md) | chroot, BSD Jails, namespaces, cgroups, LXC, Docker |
| [commands.md](./commands.md) | grep, sed, awk, find, networking, processes, monitoring cheat sheet |
| [strace-perf.md](./strace-perf.md) | strace, perf stat, perf top, perf record, flame graphs, perf trace |
| [memory-tuning.md](./memory-tuning.md) | /proc/meminfo, swappiness, OOM killer, dirty pages, THP, cgroup v2 memory |
| [cgroup-v2.md](./cgroup-v2.md) | cgroup v2 hierarchy, cpu.max/weight, memory.high, PSI pressure files, I/O limits, K8s mapping |
| [proc-internals.md](./proc-internals.md) | /proc/maps, /proc/smaps, /proc/status, /proc/fd, signal masks, per-process internals |
| [ebpf-bpftrace.md](./ebpf-bpftrace.md) | eBPF hooks, bpftrace one-liners, CPU/memory/network/disk tracing, BCC tools |
| [signals.md](./signals.md) | SIGTERM vs SIGKILL, signal delivery internals, signal masks, SIGCHLD, graceful shutdown |

---

## Linux Kernel Architecture

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    subgraph UserSpace["User Space"]
        APPS["Applications: nginx, Go binaries, python scripts"]:::blue
        LIBS["Libraries: libc glibc/musl, libpthread"]:::blue
        SHELL["Shell: bash, zsh"]:::blue
    end

    subgraph KernelSpace["Kernel Space (Ring 0)"]
        SYSCALL["System Call Interface: open, read, write, fork, clone, exec, mmap"]:::blue
        subgraph Subsystems["Kernel Subsystems"]
            PROC_MGMT["Process Management: scheduler, fork/clone, signals"]:::blue
            MEM_MGMT["Memory Management: virtual memory, page tables, swap, OOM killer"]:::red
            VFS["Virtual Filesystem: VFS layer, ext4, xfs, procfs, sysfs"]:::blue
            NET["Networking: TCP/IP stack, netfilter/iptables, socket layer"]:::teal
            CGROUPS["cgroups: resource limits for CPU, memory, IO, PIDs"]:::blue
            NS["Namespaces: pid, net, mnt, uts, ipc, user, cgroup"]:::blue
        end
    end

    HARDWARE["Hardware: CPU, RAM, Disk, NIC"]:::dark

    APPS --> LIBS
    LIBS --> SYSCALL
    SHELL --> SYSCALL
    SYSCALL --> Subsystems
    Subsystems --> HARDWARE
```

User space programs interact with hardware only through the kernel via **system calls**. The kernel runs in privileged mode (Ring 0) and controls all hardware access, memory protection, and process isolation.

---

## Processes

A **process** is an instance of a running program. It has its own virtual address space, file descriptor table, PID, and execution context.

### Process Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created : fork() / clone()
    Created --> Ready : scheduled by kernel
    Ready --> Running : CPU assigned
    Running --> Ready : preempted (timeslice expired)
    Running --> Sleeping : waiting on I/O or lock
    Sleeping --> Ready : I/O complete / event
    Running --> Stopped : SIGSTOP / Ctrl+Z
    Stopped --> Ready : SIGCONT
    Running --> Zombie : exited, parent not wait()
    Zombie --> [*] : parent calls wait()
```

**Process States (from `ps` output):**

| State | Code | Meaning |
|-------|------|---------|
| Running | `R` | Currently executing on CPU or in run queue |
| Sleeping (Interruptible) | `S` | Waiting for event, can be woken by signal |
| Sleeping (Uninterruptible) | `D` | Blocked on I/O (disk/NFS), CANNOT be killed — not even SIGKILL |
| Stopped | `T` | Stopped by signal (SIGSTOP/SIGTSTP) |
| Zombie | `Z` | Exited but parent hasn't read exit status via `wait()` |

### Process Creation: fork() and exec()

```mermaid
sequenceDiagram
    participant P as Parent Process (bash, PID 100)
    participant K as Kernel
    participant C as Child Process (PID 101)

    P->>K: fork() syscall
    K->>K: Create new task_struct, copy page tables (COW), allocate PID
    K->>C: Child created (PID 101), returns 0 to child
    K->>P: Returns child PID (101) to parent

    Note over C: Child is a clone of parent (same code, same memory via COW)

    C->>K: exec("/usr/bin/nginx") syscall
    K->>K: Replace address space with new binary, reset signals, keep PID and FDs
    K->>C: nginx is now running as PID 101

    P->>K: waitpid(101) blocks until child exits
    C->>K: exit(0)
    K->>P: Child status returned, zombie reaped
```

**Copy-on-Write (COW):** After `fork()`, parent and child share the same physical memory pages. The kernel marks pages read-only. Only when one process writes does the kernel copy that page — avoiding expensive full copies for short-lived children.

### task_struct — The Kernel's View

In the Linux kernel, **both processes and threads** are represented by the same structure: `task_struct`. The difference:

| | Process | Thread |
|--|---------|--------|
| Created via | `fork()` or `clone()` without CLONE_VM | `clone()` with CLONE_VM, CLONE_FS, CLONE_FILES |
| Address space | Separate (COW copy of parent) | Shared with parent |
| File descriptors | Separate copy | Shared |
| PID | Unique PID | Own PID, shares TGID (thread group ID) with siblings |
| Crash isolation | One crashes, others unaffected | One thread crashes = whole process crashes |

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    subgraph ProcessA["Process A (PID 100, TGID 100)"]
        TS_A["task_struct: PID=100, TGID=100"]:::blue
        MM_A["mm_struct: own virtual address space"]:::blue
        FILES_A["files_struct: own fd table"]:::blue
        TS_A --> MM_A
        TS_A --> FILES_A
    end

    subgraph ProcessB["Process B: multi-threaded (TGID 200)"]
        TS_B1["task_struct: PID=200, TGID=200 (main thread)"]:::blue
        TS_B2["task_struct: PID=201, TGID=200 (thread 1)"]:::blue
        TS_B3["task_struct: PID=202, TGID=200 (thread 2)"]:::blue
        MM_B["mm_struct: SHARED address space"]:::blue
        FILES_B["files_struct: SHARED fd table"]:::blue
        TS_B1 --> MM_B
        TS_B2 --> MM_B
        TS_B3 --> MM_B
        TS_B1 --> FILES_B
        TS_B2 --> FILES_B
        TS_B3 --> FILES_B
    end
```

### Zombie Processes

A zombie has finished (`exit()` called) but its entry remains in the process table because the parent hasn't called `wait()`.

- You can't kill a zombie — it's already dead.
- Zombies consume a PID and a tiny bit of kernel memory.
- **Fix:** Kill the parent (or fix it to `wait()` properly). When parent dies, `init` (PID 1) adopts and reaps the zombie.
- In containers: if PID 1 doesn't reap children, zombies accumulate. Use a proper init process (tini, dumb-init).

#### Zombies in General Linux vs Containers

**General Linux:** `init` (PID 1 = systemd) automatically adopts and reaps orphaned zombies. Even if a parent process dies without calling `wait()`, systemd picks up the zombie and reaps it within seconds. Zombies are transient and self-healing.

**Containers — it's a real problem:**

A container's PID 1 is typically your app process (`node server.js`, `./myapp`, `python app.py`). Your app is not designed to be an init process. It doesn't:
- Call `waitpid()` in a loop to reap children
- Handle `SIGCHLD` signals from dying child processes

So when your app spawns children (shell commands via exec, subprocess calls, CGI handlers) and those children exit, they become zombies — and they stay zombies forever because PID 1 never reaps them.

Over time they accumulate. Each holds a PID. If the PID namespace exhausts (default max 32768 PIDs), the container can't fork new processes → crashes.

**What you see in a leaking container:**

```
ps aux
PID  PPID  S  CMD
1    0     S  node server.js          ← PID 1, your app
847  1     Z  [sh] <defunct>          ← zombie
1203 1     Z  [sh] <defunct>          ← zombie
1891 1     Z  [sh] <defunct>          ← zombie
```

**Fix: use tini or dumb-init as PID 1.** They're minimal init processes that do exactly one thing: reap zombies and forward signals to your app.

#### What is tini?

`tini` (**T**iny **ini**t) is a ~20KB static binary that runs as PID 1 inside a container. It does two things only:
1. **Reaps zombie children** — calls `waitpid()` in a loop whenever it gets `SIGCHLD`
2. **Forwards signals** — passes `SIGTERM`, `SIGINT`, etc. to your app process

It's not a full init system (no service management, no logging, no dependency resolution). Just the bare minimum to make your container behave correctly.

`dumb-init` (by Yelp) does the same thing. Use either — `tini` ships inside Docker itself (`docker run --init` uses it).

#### Fix Options

**Option 1 — tini in Dockerfile (recommended, works everywhere):**
```dockerfile
FROM node:18
RUN apt-get update && apt-get install -y --no-install-recommends tini
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
# tini is now PID 1, node is PID 2
# tini reaps zombies and forwards SIGTERM → node
```

**Option 2 — Docker `--init` flag (dev/local only):**
```bash
docker run --init myimage
# Docker injects its bundled tini as PID 1 automatically
# Not available in Kubernetes — don't rely on this in prod
```

**Option 3 — Kubernetes (shareProcessNamespace):**
```yaml
# k8s doesn't have --init. Options:
# a) Bake tini into your image (Option 1) — preferred
# b) Use shareProcessNamespace so the pause container can reap
spec:
  shareProcessNamespace: true   # all containers share one PID namespace
  containers:
    - name: app
      image: myimage
```

**Option 4 — dumb-init (alternative to tini):**
```dockerfile
FROM python:3.11
RUN pip install dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["python", "app.py"]
```

**Signal forwarding also matters:** without tini, `docker stop` sends `SIGTERM` to PID 1 (your app). If your app doesn't handle `SIGTERM`, Docker waits 30s then sends `SIGKILL` — no graceful shutdown. With tini, `SIGTERM` → tini → your app, and tini waits for your app to exit cleanly before terminating.

### Signals

| Signal | Number | Default Action | Catchable? | Use |
|--------|--------|---------------|------------|-----|
| SIGTERM | 15 | Terminate | Yes | Polite shutdown. Always try first. |
| SIGKILL | 9 | Terminate | **No** | Force kill. No cleanup. Last resort. |
| SIGINT | 2 | Terminate | Yes | Ctrl+C |
| SIGHUP | 1 | Terminate | Yes | Terminal hangup, often used to reload config |
| SIGSTOP | 19 | Stop | **No** | Pause process (cannot be caught) |
| SIGCONT | 18 | Continue | — | Resume stopped process |
| SIGSEGV | 11 | Core dump | Yes | Segmentation fault |
| SIGCHLD | 17 | Ignore | Yes | Child status changed |

**Always SIGTERM first, SIGKILL only if stuck.** In Kubernetes, kubelet sends SIGTERM, waits `terminationGracePeriodSeconds`, then SIGKILL.

---

## Memory Management

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    subgraph VAS["Process Virtual Address Space (high to low)"]
        STACK["Stack: grows downward, local variables, function call frames"]:::blue
        MMAP["Memory-mapped regions: shared libraries, mmap files"]:::blue
        HEAP["Heap: grows upward, malloc/new allocations"]:::blue
        BSS["BSS: uninitialized globals (zeroed)"]:::blue
        DATA["Data: initialized globals"]:::blue
        TEXT["Text: program code (read-only, executable)"]:::blue
    end

    subgraph Physical["Physical Memory"]
        RAM["RAM: divided into 4KB pages"]:::blue
        SWAP["Swap: disk-backed overflow"]:::orange
    end

    subgraph Kernel["Kernel Memory Manager"]
        PT["Page Tables: virtual to physical address translation"]:::blue
        LRU["LRU lists: track page usage for eviction"]:::blue
        OOMK["OOM Killer: fires when memory exhausted"]:::red
    end

    VAS --> PT
    PT --> RAM
    LRU -->|"evict least-recently-used"| SWAP
    OOMK -->|"kills highest oom_score"| VAS
```

### Pages and Virtual Memory

RAM is divided into **pages** (4KB typically). Every virtual address is translated to a physical address via multi-level page tables.

**Page fault types:**
- **Minor fault:** Page in memory but not mapped (COW, first access) — kernel maps it, no disk I/O
- **Major fault:** Page in swap — kernel reads from disk → very slow

### Swap

When RAM is full, kernel moves least-recently-used pages to swap. It's orders of magnitude slower:
- RAM: ~100ns access
- SSD swap: ~100,000ns (1000x slower)
- HDD swap: ~10,000,000ns

**High swap usage = memory-starved system.** In containers, cgroups typically disable swap — OOM kill instead.

### OOM Killer

When no memory remains, kernel OOM killer selects a victim based on `oom_score` (higher = more likely killed, based mainly on memory usage).

```bash
cat /proc/<PID>/oom_score         # current score
echo -1000 > /proc/<PID>/oom_score_adj  # protect from OOM (-1000 = never kill)
dmesg | grep -i "oom\|killed"     # check for past OOM events
```

---

## Filesystem

### Inode Architecture

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    DIR["Directory Entry: maps filename to inode number"]:::dark
    DIR -->|"file.txt -> inode 12345"| INODE["Inode #12345"]:::dark
    INODE --> META["Metadata: permissions, owner, timestamps, size, link count"]:::blue
    INODE --> PTRS["Data block pointers"]:::red
    PTRS --> BLK1["Data Block 1 (4KB)"]:::red
    PTRS --> BLK2["Data Block 2 (4KB)"]:::red

    DIR2["Another directory entry"]:::blue
    DIR2 -->|"hardlink.txt -> inode 12345 (same inode!)"| INODE
```

- **Filename is NOT in the inode** — it's in the directory entry
- **Running out of inodes** = cannot create files even with free disk space. Check: `df -i`
- **Hard link** — another name pointing to same inode. Can't cross filesystems. Survives original deletion.
- **Symlink** — separate file containing a path string. Breaks if target deleted. Can cross filesystems.

### Virtual Filesystem (VFS) Layer

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    APP["Application: open, read, write syscalls"]:::blue --> VFS["VFS Layer: unified interface"]:::blue
    VFS --> EXT4["ext4: traditional disk FS"]:::yellow
    VFS --> XFS["xfs: high-performance"]:::blue
    VFS --> PROCFS["procfs (/proc): kernel/process info as files"]:::blue
    VFS --> SYSFS["sysfs (/sys): kernel objects, devices, drivers"]:::blue
    VFS --> TMPFS["tmpfs: RAM-backed (/tmp, /dev/shm)"]:::blue
    VFS --> OVERLAY["overlayfs: layered FS (Docker image layers)"]:::blue
    VFS --> NFS["NFS: network filesystem"]:::teal
```

---

## Load Average

Three values from `uptime`: **1-minute, 5-minute, 15-minute** averages.

**Load = runnable processes (R state) + uninterruptible sleep (D state)**

On an **N-core machine:**
- Load = N → 100% utilized
- Load < N → idle capacity
- Load > N → overloaded (processes queueing)

**Trend analysis:**
- 1min > 15min → load **increasing** (spike happening now)
- 1min < 15min → load **decreasing** (recovering)
- 1min ≈ 15min → stable

**High load + low CPU%?** → Processes in D state (disk I/O). Check `wa%` in top, run `iostat -x 1`.

---

## File Descriptors

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    PROC["Process PID 12345"]:::blue --> FDT["File Descriptor Table"]:::blue
    FDT --> FD0["fd 0: stdin"]:::blue
    FDT --> FD1["fd 1: stdout"]:::blue
    FDT --> FD2["fd 2: stderr"]:::blue
    FDT --> FD3["fd 3: /var/log/app.log (file)"]:::blue
    FDT --> FD4["fd 4: TCP socket to 10.0.0.5:5432 (DB)"]:::teal
    FDT --> FD5["fd 5: unix socket /tmp/app.sock"]:::teal
    FDT --> FD6["fd 6: pipe to child process"]:::blue
```

Everything is a file descriptor: open files, sockets, pipes, devices.

- Per-process soft limit: `ulimit -n` (default 1024)
- System-wide max: `cat /proc/sys/fs/file-max`
- Critical for nginx, databases, high-connection services

```bash
lsof -p <PID> | wc -l              # count open FDs
ls -la /proc/<PID>/fd/             # list them
ulimit -n 65536                     # raise temporarily
# Permanent: /etc/security/limits.conf
```

---

## Debugging High Load

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    START["System slow, load high"]:::blue --> TOP["top: check wa%, us%, sy%"]:::blue
    TOP -->|"wa% high, CPU low"| IO["I/O bottleneck"]:::blue
    TOP -->|"us/sy% high"| CPU["CPU bottleneck"]:::blue
    TOP -->|"high memory, swap active"| MEM["Memory pressure"]:::blue

    IO --> IOSTAT["iostat -x 1 5: per-device await and utilization"]:::orange
    IOSTAT --> IOTOP["iotop: which process doing I/O"]:::blue
    IOTOP --> DSTATE["ps aux | awk '$8 ~ /D/': find D-state processes"]:::blue

    CPU --> PS_CPU["ps aux --sort=-%cpu | head"]:::blue
    PS_CPU --> STRACE["strace -p PID: trace syscalls"]:::blue

    MEM --> FREE["free -h: check swap usage"]:::orange
    FREE --> VMSTAT["vmstat 1: si/so columns = swap activity"]:::orange
    VMSTAT --> OOM["dmesg | grep oom: OOM kills?"]:::red
```

**Pattern recognition:**
- High load + low CPU + high wa% = **disk I/O bottleneck** (D-state processes piling up)
- High load + high us% = **CPU-bound** (optimize code or add cores)
- High load + high sy% = **syscall-heavy** (excessive context switches)
- High load + active swap = **memory pressure** (thrashing)


---

## top / htop Key Metrics

Understanding what each column means is essential for diagnosing production issues.

```
top - 19:31:01 up 42 days,  load average: 2.15, 1.88, 1.43
Tasks: 312 total,   2 running, 310 sleeping,   0 stopped,   1 zombie
%Cpu(s): 23.4 us,  8.1 sy,  0.0 ni, 62.3 id,  5.8 wa,  0.0 hi,  0.4 si
MiB Mem : 15823.4 total,  1204.2 free,  9812.6 used,  4806.6 buff/cache
MiB Swap:  2048.0 total,  1122.4 free,   925.6 used.  5210.8 avail Mem

  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
12345 appuser   20   0  812332 412548  18432 R  89.4   2.5   4:12.34 go-server
```

| Column | Meaning | Red flag |
|--------|---------|----------|
|  | User CPU: time running your application code | High is normal if CPU-bound |
|  | System/kernel CPU: syscall overhead, context switches | High = too many syscalls or lock contention |
|  | IO wait: CPU idle while waiting for disk/NFS | **High = disk bottleneck** |
|  | Idle: truly unused CPU | Low = system under load |
|  | Resident Set Size: actual physical RAM in use | Close to limit = OOM risk |
|  | Virtual memory: all mapped address space (includes shared libs, unused pages) | Not meaningful for OOM — use RES |
|  | Process state: R=running, S=sleeping, D=uninterruptible, Z=zombie | D = stuck on IO |

**Quick diagnosis from top:**
-  high,  low → IO bottleneck. Run , 
-  high → Many context switches or syscalls. Run 
-  high, no wa → CPU-bound. Profile with pprof or perf
- Zombie count > 0 → Parent not calling . Check parent process.

---

## /proc and /sys

These are virtual filesystems — nothing is stored on disk. They expose live kernel state as readable files.

**** — process and kernel information:

| Path | Contents |
|------|----------|
|  | CPU model, cores, flags |
|  | Detailed memory breakdown (MemTotal, MemFree, Buffers, Cached, SwapUsed) |
|  | Current load averages + process counts |
|  | Process state, memory, signal masks |
|  | Exact command that started the process (null-byte separated) |
|  | Symlinks to every open file descriptor |
|  | Memory map: which libraries/files are mapped where |
|  | Which cgroup the process belongs to |
|  | OOM killer score (higher = more likely killed) |

**** (sysfs) — kernel objects, devices, runtime tuning:

| Path | Contents |
|------|----------|
|  | cgroup hierarchy — Docker/K8s set limits here |
|  | Block device tuning (scheduler, read-ahead) |
|  | THP settings (often disabled for databases) |
|  | Max socket backlog queue length |

       0
