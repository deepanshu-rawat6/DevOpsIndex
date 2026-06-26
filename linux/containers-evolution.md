# From chroot to Docker: The Container Evolution

Containers didn't appear out of nowhere in 2013. They are the result of four decades of OS isolation research, each layer solving the gaps left by the previous one. Understanding this progression explains why containers work the way they do.

---

## Evolution Timeline

```mermaid
timeline
    title OS Isolation Primitives
    1979 : chroot (Unix V7)
           : Restricts filesystem view only
    2000 : BSD Jails (FreeBSD 4.0)
           : First true OS-level virtualization
           : Isolated process tree + network + users
    2002 : Linux namespaces begin (mnt, ipc, uts)
           : Kernel 2.4.19
    2006 : cgroups (Google, Linux 2.6.24)
           : Resource limits for CPU memory IO
    2008 : LXC (Linux Containers)
           : First complete Linux container runtime
           : Combines namespaces + cgroups
    2013 : Docker
           : Image layers + registry + developer UX
           : Containers become mainstream
    2015 : runc + OCI standard
           : Container runtime spec standardized
    2016 : cgroups v2 (Linux 4.5)
           : Unified hierarchy, better resource control
```

---

## chroot (1979)

`chroot` changes the apparent root directory (`/`) for a process and its children. It was designed for build isolation and system recovery — not security.

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
    subgraph RealRoot["Real Filesystem Root /"]
        BIN["/bin"]:::blue
        ETC["/etc"]:::blue
        HOME["/home"]:::blue
        JAIL_DIR["/jail/"]:::blue
        subgraph JailView["chroot jail (sees this as /)"]
            J_BIN["/bin (copied libs)"]:::blue
            J_ETC["/etc"]:::blue
            J_APP["/app/server"]:::dark
        end
    end

    PROCESS["Process inside chroot"]:::blue -->|"sees / as /jail/"| JailView
    PROCESS -. "can still see:" .-> PROCS["ALL other processes (ps aux)"]:::blue
    PROCESS -. "can still see:" .-> NETW["host network (same interfaces)"]:::teal
    PROCESS -. "can still see:" .-> USERS["host user IDs (uid 0 = real root)"]:::blue
```

**What chroot does:** Restricts the process's view of the filesystem. Cannot access paths outside the jail root.

**What chroot does NOT do:**
- Process isolation — the jailed process can see and signal all host processes
- Network isolation — shares the host network stack completely
- User isolation — root inside the jail is root on the host
- Resource limits — can consume all CPU/memory

**How to escape:** A root process inside a chroot can call `chroot()` again to escape. It was never a security boundary.

```bash
# Create a minimal chroot jail
mkdir -p /jail/{bin,lib64}
cp /bin/bash /jail/bin/
# Copy required libraries
ldd /bin/bash | grep -o '/lib[^ ]*' | xargs -I{} cp {} /jail/lib64/
chroot /jail /bin/bash   # process now sees /jail as /
```

---

## BSD Jails (FreeBSD 4.0, 2000)

BSD Jails were the first true OS-level virtualization. They addressed all of chroot's gaps by creating a complete isolated environment per jail — each with its own hostname, IP address(es), process tree, and user namespace.

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
    subgraph Host["FreeBSD Host"]
        HOST_NET["Host network stack"]:::teal
        HOST_PROC["Host process table"]:::blue

        subgraph Jail1["Jail 1: webserver"]
            J1_PID["Own PID namespace: PID 1 = nginx (not visible to Jail2)"]:::blue
            J1_NET["Own IP: 192.168.1.10 (subset of host NIC)"]:::dark
            J1_ROOT["Own filesystem root: /jails/webserver/"]:::dark
            J1_USER["Own users: root inside jail != host root"]:::blue
        end

        subgraph Jail2["Jail 2: database"]
            J2_PID["Own PID namespace: PID 1 = postgres"]:::blue
            J2_NET["Own IP: 192.168.1.11"]:::blue
            J2_ROOT["Own filesystem root: /jails/database/"]:::blue
        end
    end

    HOST_NET -->|"assigns IP slice"| J1_NET
    HOST_NET -->|"assigns IP slice"| J2_NET
    HOST_PROC -. "host can see jail processes, jails cannot see each other" .-> Jail1
    HOST_PROC -. "host can see jail processes, jails cannot see each other" .-> Jail2
```

**What Jails added over chroot:**

| Feature | chroot | BSD Jail |
|---------|--------|----------|
| Filesystem isolation | Yes | Yes |
| Process isolation | No | Yes — own PID tree |
| Network isolation | No | Yes — own IP(s) |
| User isolation | No | Yes — root != host root |
| Resource limits | No | Partial (via jail parameters) |
| Platform | Any Unix | FreeBSD only |

**Jail limitations:**
- FreeBSD-only — no Linux equivalent at the time
- No fine-grained resource limits (CPU%, memory caps)
- Shared kernel — all jails use the same kernel version
- No concept of image layers or packaging

BSD Jails proved the concept was sound and inspired the Linux kernel developers to implement equivalent primitives — which became **namespaces** and **cgroups**.

---

## Linux Namespaces (2002–2016)

Linux implemented isolation through **namespaces** — a kernel feature that creates separate views of system resources. Each namespace type isolates a different dimension. A process can be in different namespaces simultaneously.

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
    subgraph HostKernel["Linux Kernel"]
        subgraph DefaultNS["Default (host) namespaces"]
            PID_HOST["PID NS: all host processes visible"]:::blue
            NET_HOST["NET NS: eth0, lo, iptables rules"]:::blue
            MNT_HOST["MNT NS: full host filesystem tree"]:::dark
            UTS_HOST["UTS NS: hostname = 'prod-server-01'"]:::blue
            IPC_HOST["IPC NS: shared memory, semaphores"]:::blue
            USER_HOST["USER NS: uid 0 = real root"]:::blue
        end

        subgraph ContainerNS["Container namespaces (isolated view)"]
            PID_C["PID NS: PID 1 = app, cannot see host PIDs"]:::dark
            NET_C["NET NS: own eth0, lo, routing table, iptables"]:::blue
            MNT_C["MNT NS: own filesystem tree (from image)"]:::blue
            UTS_C["UTS NS: hostname = 'my-container'"]:::dark
            IPC_C["IPC NS: own shared memory segments"]:::blue
            USER_C["USER NS: uid 0 maps to unprivileged host uid"]:::blue
            CG_C["CGROUP NS: own cgroup hierarchy view"]:::blue
        end
    end

    CONTAINER_PROC["Container process"]:::blue --> PID_C
    CONTAINER_PROC --> NET_C
    CONTAINER_PROC --> MNT_C
    CONTAINER_PROC --> UTS_C
    CONTAINER_PROC --> USER_C
    CONTAINER_PROC --> CG_C
```

### Namespace Types

| Namespace | Flag | Introduced | What it isolates |
|-----------|------|-----------|-----------------|
| Mount | `CLONE_NEWNS` | 2002 (2.4.19) | Filesystem mount points — container gets its own mount table |
| UTS | `CLONE_NEWUTS` | 2006 (2.6.19) | Hostname and NIS domain name |
| IPC | `CLONE_NEWIPC` | 2006 (2.6.19) | System V IPC, POSIX message queues |
| PID | `CLONE_NEWPID` | 2008 (2.6.24) | Process IDs — PID 1 inside container maps to different PID on host |
| Network | `CLONE_NEWNET` | 2009 (2.6.29) | Network interfaces, routing tables, iptables rules, ports |
| User | `CLONE_NEWUSER` | 2013 (3.8) | User and group IDs — uid 0 inside can map to uid 65534 on host |
| Cgroup | `CLONE_NEWCGROUP` | 2016 (4.6) | cgroup root — container sees its cgroup subtree as root |

### How Namespaces Are Created

```mermaid
sequenceDiagram
    participant Shell as Shell / Container Runtime
    participant Kernel as Linux Kernel

    Shell->>Kernel: clone(fn, stack, CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWUTS, ...)
    Kernel->>Kernel: Create new task_struct
    Kernel->>Kernel: Allocate new PID namespace (child sees itself as PID 1)
    Kernel->>Kernel: Allocate new network namespace (empty: no interfaces yet)
    Kernel->>Kernel: Allocate new mount namespace (copy of parent's mounts)
    Kernel->>Kernel: Allocate new UTS namespace (copy of parent's hostname)
    Kernel-->>Shell: Child PID returned (host PID e.g. 45231)

    Note over Shell,Kernel: Runtime then sets up the container environment
    Shell->>Kernel: Create veth pair, move one end to container NET NS
    Shell->>Kernel: pivot_root() or chroot() to container image rootfs
    Shell->>Kernel: sethostname() in child's UTS NS
    Shell->>Kernel: execve("/sbin/init") in child — becomes container PID 1
```

**Key insight:** Namespaces give isolation of visibility. A process in a PID namespace cannot see or signal processes in other PID namespaces. But it can still consume all CPU and memory — that's what cgroups solve.

---

## cgroups (Linux 2.6.24, 2008)

**Control Groups (cgroups)** is a Linux kernel feature developed by Google engineers (Paul Menage, Rohit Seth) that limits, accounts for, and isolates resource usage of process groups.

Where namespaces control what a process **can see**, cgroups control what a process **can use**.

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
    subgraph CgroupHierarchy["cgroup v2 unified hierarchy (/sys/fs/cgroup/)"]
        ROOT["/ (root cgroup: entire system)"]:::blue
        ROOT --> SYSTEM["system.slice (systemd services)"]:::teal
        ROOT --> USER["user.slice (user sessions)"]:::blue
        ROOT --> CONTAINER["container.scope (our container)"]:::blue

        subgraph ContainerLimits["Container cgroup settings"]
            CPU_LIMIT["cpu.max: 200000 1000000 (20% of one core)"]:::blue
            MEM_LIMIT["memory.max: 536870912 (512MB hard limit)"]:::blue
            MEM_SW["memory.swap.max: 0 (no swap)"]:::orange
            IO_LIMIT["io.max: 8:0 rbps=104857600 (100MB/s read)"]:::blue
            PIDS["pids.max: 100 (max 100 processes)"]:::blue
        end

        CONTAINER --> ContainerLimits
    end

    CONTAINER_PROC["Container process (PID 45231 on host)"]:::blue -->|"kernel enforces limits"| CONTAINER
```

### cgroups v1 vs v2

| | cgroups v1 | cgroups v2 |
|--|-----------|-----------|
| Hierarchy | Multiple separate hierarchies per controller | Single unified hierarchy |
| Introduced | Linux 2.6.24 (2008) | Linux 4.5 (2016), default in modern distros |
| Consistency | Each controller had separate rules | Unified, consistent API |
| Delegation | Complex, fragile | Clean delegation model |
| Memory accounting | Per-process | Per-cgroup subtree (more accurate) |
| IO accounting | blkio controller (block devices only) | io controller (unified, includes buffered writes) |
| Docker/K8s | Used v1 for years | K8s 1.25+ defaults to v2, Docker 20.10+ supports v2 |

**What cgroups enforce in containers:**
- `memory.max` — hard limit, OOM-kill when exceeded
- `cpu.max` — CPU bandwidth limit (Docker `--cpus`)
- `pids.max` — process/thread count (prevents fork bombs)
- `io.max` — disk read/write throughput limits
- `memory.swap.max 0` — disable swap for containers (crash fast, don't degrade)

---

## LXC — Linux Containers (2008)

LXC was the first complete Linux container runtime. It combined namespaces + cgroups + a minimal init process into a usable tool, essentially reimplementing BSD Jails on Linux.

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
    subgraph LXCContainer["LXC Container: myapp"]
        subgraph Namespaces["Namespaces (isolation)"]
            NS_PID["PID NS: own process tree, PID 1 = /sbin/init"]:::blue
            NS_NET["NET NS: veth0 with IP 10.0.3.100"]:::blue
            NS_MNT["MNT NS: rootfs from /var/lib/lxc/myapp/rootfs/"]:::blue
            NS_UTS["UTS NS: hostname = myapp"]:::dark
            NS_IPC["IPC NS: own IPC objects"]:::blue
            NS_USER["USER NS: uid mapping"]:::blue
        end
        subgraph Cgroups["cgroups (resource limits)"]
            CG_CPU["cpu: 50% of 1 core"]:::blue
            CG_MEM["memory: 512MB limit"]:::blue
            CG_PIDS["pids: max 200"]:::blue
        end
        INIT["PID 1: /sbin/init (minimal)"]:::blue
        APP["App process: nginx, postgres, etc."]:::blue
        INIT --> APP
    end

    subgraph Host["Host Linux Kernel"]
        VETH["veth pair: connects container NET NS to host bridge lxcbr0"]:::dark
        BRIDGE["lxcbr0 bridge: 10.0.3.1 (NAT to host)"]:::orange
        CGROUP_FS["cgroup filesystem: /sys/fs/cgroup/lxc/myapp/"]:::blue
    end

    NS_NET <--> VETH
    VETH <--> BRIDGE
    Cgroups --> CGROUP_FS
```

### How LXC Creates a Container (internals)

```mermaid
sequenceDiagram
    participant CLI as lxc-start
    participant LXC as LXC Runtime
    participant K as Linux Kernel
    participant C as Container

    CLI->>LXC: lxc-start -n myapp
    LXC->>K: clone() with all namespace flags
    K-->>LXC: Child process created in new namespaces
    LXC->>K: Set cgroup limits (memory.max, cpu.max, pids.max)
    LXC->>K: pivot_root() to container rootfs (/var/lib/lxc/myapp/rootfs/)
    LXC->>K: Mount /proc, /sys, /dev inside container
    LXC->>K: Set up veth pair, assign IP to container network NS
    LXC->>K: Drop capabilities (remove CAP_SYS_ADMIN and others)
    LXC->>C: execve("/sbin/init")
    C-->>C: Container PID 1 running, starts services
```

### LXC vs VM

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
    subgraph VM["Virtual Machine"]
        GUEST_OS["Guest OS Kernel (full Linux/Windows)"]:::blue
        GUEST_APP["Application"]:::blue
        GUEST_LIBS["Guest userspace libraries"]:::blue
        HYPERVISOR["Hypervisor: KVM/VMware/Hyper-V"]:::blue
        HOST_OS["Host OS Kernel"]:::dark
        HW["Hardware"]:::dark
        GUEST_OS --> GUEST_APP
        GUEST_LIBS --> GUEST_APP
        GUEST_OS --> HYPERVISOR
        HYPERVISOR --> HOST_OS
        HOST_OS --> HW
    end

    subgraph LXC_C["LXC Container"]
        C_APP["Application"]:::blue
        C_LIBS["Container userspace (libc, etc.)"]:::blue
        SHARED_KERNEL["SHARED Host Kernel (namespaces + cgroups)"]:::dark
        C_HW["Hardware"]:::dark
        C_APP --> C_LIBS
        C_LIBS --> SHARED_KERNEL
        SHARED_KERNEL --> C_HW
    end
```

| | VM | LXC Container |
|--|----|----|
| Kernel | Own guest kernel | Shares host kernel |
| Boot time | 30s–2min | Milliseconds |
| Memory overhead | 100MB–1GB+ (full OS) | ~1MB (just the process) |
| Isolation | Strong (hypervisor boundary) | Weaker (kernel attack surface shared) |
| Disk image | Full OS image (GBs) | Just app + libs (MBs) |
| Use case | Strong isolation needed (multi-tenant) | Fast, dense, same-trust workloads |

**LXC's limitations that Docker solved:**
- No concept of image layers — each container rootfs was a full copy or copy-on-write manually
- No standard image format or registry
- Complex configuration files (lxc.conf)
- Poor developer experience — not designed for app packaging
- No Dockerfile-equivalent for reproducible builds

---

## Docker (2013)

Docker didn't invent containers. It invented the **developer workflow** around containers. Initially Docker used LXC as its runtime; it later replaced it with its own `libcontainer` (now `runc`).

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
    subgraph DockerAdditions["What Docker Added on Top of LXC/Kernel Primitives"]
        LAYERS["Image Layers (Union FS / overlayfs)"]:::blue
        DOCKERFILE["Dockerfile: reproducible image build instructions"]:::orange
        REGISTRY["Registry: Docker Hub, ECR, GCR"]:::yellow
        CLI["docker CLI: simple developer UX"]:::blue
        COMPOSE["docker-compose: multi-container apps"]:::blue
        NETWORK["Docker networking: bridge, overlay, host modes"]:::teal
        VOLUMES["Volume management: named volumes, bind mounts"]:::yellow
    end

    subgraph KernelPrimitives["Linux Kernel Primitives (unchanged)"]
        NS2["Namespaces: pid, net, mnt, uts, ipc, user"]:::blue
        CG2["cgroups: CPU, memory, IO, PIDs limits"]:::blue
        CAPS["Capabilities: fine-grained privilege control"]:::blue
        SECCOMP["seccomp: syscall filtering (blocks dangerous syscalls)"]:::red
        APPARMOR["AppArmor/SELinux: MAC profiles"]:::blue
    end

    DockerAdditions -->|"uses"| KernelPrimitives
```

### Image Layers (overlayfs)

This is Docker's killer feature. Images are built in layers — each Dockerfile instruction creates a read-only layer. Containers add a thin read-write layer on top.

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
    subgraph ImageLayers["Docker Image Layers (read-only, shared)"]
        L1["Layer 1: FROM ubuntu:22.04 (base OS: 72MB)"]:::blue
        L2["Layer 2: RUN apt-get install -y python3 (adds 45MB)"]:::blue
        L3["Layer 3: COPY requirements.txt + RUN pip install (adds 30MB)"]:::blue
        L4["Layer 4: COPY app.py (adds 50KB)"]:::blue
        L1 --> L2 --> L3 --> L4
    end

    subgraph Container1["Container 1 (running)"]
        RW1["Read-Write Layer: modified files, logs, /tmp (thin, per-container)"]:::blue
        RW1 -->|"reads from"| L4
    end

    subgraph Container2["Container 2 (running same image)"]
        RW2["Read-Write Layer: separate per-container"]:::blue
        RW2 -->|"reads from"| L4
    end

    NOTE["Both containers share the same read-only image layers in the overlayfs Only diverging writes are stored in their respective RW layers"]:::blue
```

**overlayfs mechanics:** The container's filesystem is a union of:
- `lowerdir` — all image layers stacked (read-only)
- `upperdir` — the container's write layer (read-write)
- `workdir` — overlayfs internal scratch space
- `merged` — the unified view the container sees

When a container reads a file: kernel checks upperdir first, then lowerdir (bottom up). When it writes: the file is **copy-on-write** (COW) from lowerdir to upperdir, then modified. Deleting creates a "whiteout" entry in upperdir.

### Docker Container Creation (what actually happens)

```mermaid
sequenceDiagram
    participant CLI as docker run nginx
    participant D as Docker Daemon
    participant C as containerd
    participant R as runc
    participant K as Linux Kernel

    CLI->>D: POST /containers/create + /containers/start
    D->>C: Create container via gRPC
    C->>C: Pull image if not cached, extract layers
    C->>C: Set up overlayfs: merge image layers + new RW layer
    C->>R: Create bundle (rootfs + config.json OCI spec)
    R->>K: clone() with CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWNS|CLONE_NEWUTS|CLONE_NEWIPC
    R->>K: Create cgroup under /sys/fs/cgroup/docker/CONTAINER_ID/
    R->>K: Set memory.max, cpu.max, pids.max from container config
    R->>K: pivot_root() to overlayfs merged directory
    R->>K: Mount /proc, /sys, /dev/pts inside container
    R->>K: Apply seccomp profile (block ~44 dangerous syscalls)
    R->>K: Drop Linux capabilities (keep only ~14 of 38)
    R->>K: execve("/docker-entrypoint.sh") --> nginx
    K-->>CLI: Container running (PID visible on host, isolated inside)
```

### The Full Stack

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
    subgraph AppLayer["Application Layer"]
        APP["Your Go/Python/Java app"]:::blue
    end

    subgraph ContainerLayer["Container Layer"]
        OVERLAY["overlayfs: app + libs as image layers"]:::blue
        NS_FULL["Namespaces: isolated PID, NET, MNT, UTS, IPC, USER"]:::blue
        CG_FULL["cgroups: CPU, memory, IO, PIDs enforced"]:::blue
        CAPS_FULL["Capabilities + seccomp + AppArmor: reduced attack surface"]:::blue
    end

    subgraph KernelLayer["Linux Kernel"]
        SCHED["CFS Scheduler: CPU time slicing"]:::purple
        MM["Memory Manager: page tables, OOM killer"]:::red
        NETFILTER["netfilter/iptables: container networking NAT rules"]:::orange
        VFS_LAYER["VFS: filesystem abstraction"]:::blue
    end

    HARDWARE_LAYER["Hardware: CPU, RAM, Disk, NIC"]:::dark

    APP --> OVERLAY
    OVERLAY --> NS_FULL
    NS_FULL --> CG_FULL
    CG_FULL --> CAPS_FULL
    CAPS_FULL --> KernelLayer
    KernelLayer --> HARDWARE_LAYER
```

This full stack is why containers are lightweight: there's no hypervisor, no guest OS kernel, no hardware emulation. The app runs directly on the host kernel, just with a restricted view and resource limits enforced by kernel primitives.

---

## Docker Image Size Optimization

### Why it matters
Larger images = slower CI builds, slower pod startup (image pull), more ECR/registry storage cost, larger attack surface.

### Step 1: Use a minimal base image

```dockerfile
# BAD: ubuntu base is ~70MB, has shell, package manager, utilities
FROM ubuntu:22.04

# BETTER: debian-slim strips docs, locales, apt cache (~30MB)
FROM debian:bookworm-slim

# BEST for Go/Rust: scratch (0MB — just your binary)
FROM scratch

# BEST for most apps: distroless (no shell, no package manager, ~2MB base)
FROM gcr.io/distroless/static-debian12      # static binaries (Go, Rust)
FROM gcr.io/distroless/base-debian12        # glibc dynamic binaries
FROM gcr.io/distroless/java21-debian12      # Java
FROM gcr.io/distroless/nodejs20-debian12    # Node.js
```

### Step 2: Multi-stage build (most impactful for compiled languages)

```dockerfile
# Go example — build stage has all tools, final stage has only the binary
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download                      # cache dependency layer
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .
#   -s: strip symbol table
#   -w: strip DWARF debug info
#   Result: binary ~30% smaller

FROM gcr.io/distroless/static-debian12   # final image: zero shell, zero tools
COPY --from=builder /app/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
# Final image size: ~10-15MB vs ~800MB if using golang base directly
```

```dockerfile
# Node.js example
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production             # install only prod deps

FROM node:20-alpine                      # or distroless/nodejs
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
USER node                                # never run as root
CMD ["node", "server.js"]
```

### Step 3: Optimize layer caching (order matters)

```dockerfile
# BAD: COPY . . before dependency install — any source change busts dep cache
FROM golang:1.22-alpine
COPY . .
RUN go mod download

# GOOD: copy dependency files first, source code last
FROM golang:1.22-alpine
COPY go.mod go.sum ./        # only changes when deps change
RUN go mod download           # cached unless go.mod/go.sum change
COPY . .                      # source changes bust only this layer onward
RUN go build -o server .
```

### Step 4: Minimize layers and clean up in one RUN

```dockerfile
# BAD: each RUN is a layer; apt cache stays in image
RUN apt-get update
RUN apt-get install -y curl git
RUN rm -rf /var/lib/apt/lists/*    # too late — previous layer already has the cache

# GOOD: one RUN, clean up in same layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl git && \
    rm -rf /var/lib/apt/lists/*
#   --no-install-recommends: skips suggested packages
```

### Step 5: .dockerignore

```dockerignore
# .dockerignore — same syntax as .gitignore
.git
.github
**/*.md
**/*_test.go
**/*.test
node_modules
dist
coverage
*.log
.env
.DS_Store
```

Without `.dockerignore`, `COPY . .` sends everything (including `node_modules`, `.git` history) to the Docker build context — slows builds and bloats cache.

### Step 6: Use specific tags, not `latest`

```dockerfile
# BAD: latest changes silently, breaks reproducibility
FROM node:latest

# GOOD: pinned tag = reproducible builds
FROM node:20.11.1-alpine3.19
```

### Step 7: Don't run as root

```dockerfile
# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# distroless already has nonroot user
FROM gcr.io/distroless/static-debian12:nonroot
```

### Summary: checklist

| Technique | Typical saving |
|-----------|---------------|
| Switch from `ubuntu` to `alpine` base | 60-80MB |
| Multi-stage build (Go/Java/Rust) | 200-800MB |
| `-ldflags="-s -w"` on Go binary | 20-30% of binary size |
| `--no-install-recommends` on apt | 10-50MB |
| `.dockerignore` | Build context speed, not final size |
| `npm ci --only=production` | 50-200MB (no devDependencies) |
| `distroless` vs `alpine` final | 5-10MB + no shell (security) |
| Layer ordering (cache deps first) | Build time, not final size |

### Check actual image size

```bash
docker images my-org/app:v1
docker history my-org/app:v1    # size per layer

# dive — interactive layer explorer (install separately)
dive my-org/app:v1
```
