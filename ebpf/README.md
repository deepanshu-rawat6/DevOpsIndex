# eBPF: Programmable Linux Kernel Observability, Networking, and Security

eBPF (extended Berkeley Packet Filter) is a technology that allows sandboxed programs to run inside the Linux kernel without modifying kernel source code or loading kernel modules. It has transformed how Linux handles observability, networking, and security — enabling capabilities that previously required recompiling the kernel or writing kernel modules, but now available as safe, verifiable user-space programs attached to kernel hooks.

---

## 1. What eBPF Is

Traditional Linux kernel extensibility required either:
1. **Kernel modules** — compiled C code loaded directly into the kernel, with unrestricted access to kernel memory and no safety checks. A bug in a kernel module causes a kernel panic (system crash).
2. **System call patching** — modifying the kernel source and recompiling. Requires a kernel update to distribute.

eBPF programs:
- Are compiled to a bytecode that is **verified** by the Linux kernel before execution. The verifier proves the program cannot crash the kernel, access invalid memory, or loop infinitely.
- Are **JIT-compiled** to native machine code after verification — near zero overhead.
- **Attach to hooks** in the kernel: system call entry/exit, network packet processing, function entry/exit (kprobes), tracepoints (stable kernel events), user-space function entry (uprobes).
- Communicate with user-space through **BPF maps** — shared data structures (hash tables, arrays, ring buffers).

The result: you can observe every system call, every network packet, every function call in the kernel, with nanosecond precision and sub-1% overhead — without modifying the running kernel.

## 2. Why eBPF Changed Linux

**Observability** (before eBPF): `strace` attaches to a process and logs system calls, but adds 10–100× overhead due to `ptrace` context switches. You cannot use it in production. eBPF programs attach to the same kernel hooks with ~1% overhead — production-safe.

**Networking** (before eBPF): `iptables` evaluates every packet against a list of rules. With 10,000 services in a Kubernetes cluster, iptables generates ~130,000 rules. Each packet traverses rules linearly — O(n) per packet, adding 10ms+ of latency at scale. eBPF programs do L4 load balancing in the XDP (eXpress Data Path) hook — at the driver level, before the kernel even allocates a socket buffer — with O(1) lookup time.

**Security** (before eBPF): `seccomp` can block system calls but cannot enforce based on context (which process, which file, which argument values). eBPF can inspect the full system call context — enforce that only specific processes can open specific files, or kill a process the moment it attempts a container escape.

## 3. Three Pillars

| Pillar | What it enables | Tool |
|--------|----------------|------|
| **Observability** | Zero-overhead profiling, latency histograms, distributed tracing without sidecars | bpftrace, Pixie, Parca |
| **Networking** | L4 load balancing replacing kube-proxy, identity-based network policies | Cilium |
| **Security** | Runtime enforcement at the syscall level, container escape detection | Tetragon, Falco (eBPF mode) |

## 4. The eBPF Program Lifecycle

```mermaid
graph LR
    classDef user fill:#4f8cff,stroke:#2563eb,color:#fff
    classDef kernel fill:#a78bfa,stroke:#7c3aed,color:#fff
    classDef exec fill:#34d399,stroke:#059669,color:#000

    C["Write eBPF program\n(C with libbpf headers)"]:::user
    COMPILE["Compile to BPF bytecode\n(clang + LLVM)"]:::user
    VERIFY["Kernel Verifier\n(safety proof)"]:::kernel
    JIT["JIT Compile\nto native code"]:::kernel
    ATTACH["Attach to hook\n(kprobe, XDP, tracepoint...)"]:::kernel
    RUN["Program runs\non every event"]:::exec

    C --> COMPILE --> VERIFY --> JIT --> ATTACH --> RUN
```

The verifier rejects programs that: access uninitialized memory, dereference null pointers, have unbounded loops, or exceed the instruction limit (~1M instructions).

---

## Read Order

| File | What it covers |
|------|---------------|
| `bpf-fundamentals` | Program types, BPF maps, CO-RE, libbpf, bpftool |
| `cilium` | eBPF-based CNI, Hubble observability, identity-based network policies |
| `tetragon` | Runtime security enforcement, TracingPolicy CRD, SIEM integration |
| `bpftrace` | One-liners for production debugging, off-CPU analysis, flame graphs |
