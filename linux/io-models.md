# Linux I/O Models

How applications wait for data — the foundation of every high-performance server.

---

## The Five I/O Models

```mermaid
graph TD
    classDef blocking  fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef nonblock  fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef mux       fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef async     fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef signal    fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    BLK["Blocking I/O read() blocks until data arrives Process sleeps in S state Simple but wastes a thread per connection"]:::blocking

    NB["Non-blocking I/O read() returns EAGAIN if no data Process must poll in a loop (busy-wait) Wastes CPU"]:::nonblock

    SEL["I/O Multiplexing select/poll/epoll Monitor many fds at once Block until any fd is ready One thread handles N connections"]:::mux

    SIG["Signal-driven I/O SIGIO signal when data ready Rarely used in practice"]:::signal

    AIO["Async I/O io_uring / aio Kernel does I/O in background App gets completion notification True async: no blocking ever"]:::async
```

---

## Blocking I/O — What Actually Happens

```mermaid
sequenceDiagram
    participant APP as Application Thread
    participant KERN as Kernel
    participant NIC as NIC / Disk

    APP->>KERN: read(fd, buf, 1024)
    Note over APP: Thread blocked (S state) Scheduled out by kernel No CPU consumed while waiting
    NIC->>KERN: Data arrives (DMA into kernel buffer)
    KERN->>KERN: Copy data from kernel buffer to user buf
    KERN-->>APP: read() returns (thread woken up)
    Note over APP: Thread running again
```

**The problem:** One thread blocked = one thread wasted. For 10,000 concurrent connections, you need 10,000 threads. Each thread costs ~8MB stack → 80GB RAM just for stacks. That's the C10K problem.

---

## select and poll — The Old Way

```mermaid
graph LR
    classDef app   fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef kern  fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef limit fill:#e67e22,stroke:#d35400,color:#fff,rx:8

    APP["App passes fd_set (bitmap of fds)"]:::app
    KERN["Kernel scans ALL fds in set O(N) scan every call"]:::kern
    COPY["Kernel copies entire fd_set back to userspace"]:::kern
    APP2["App must scan full set to find which fds are ready"]:::app
    LIMIT["select: max 1024 fds (FD_SETSIZE) poll: no limit but still O(N)"]:::limit

    APP --> KERN --> COPY --> APP2
    APP2 -.- LIMIT
```

**select/poll problems:**
- O(N) scan of all fds on every call — scales poorly past 1000 fds
- `select` hard limit: 1024 fds
- Full fd set copied kernel↔userspace on every call
- App must re-scan entire set to find ready fds

---

## epoll — The Modern Way

epoll is O(1) for event notification regardless of how many fds you're watching. Used by nginx, Node.js, Redis, Go's netpoller.

```mermaid
sequenceDiagram
    participant APP as Application
    participant KERN as Kernel epoll instance

    APP->>KERN: epoll_create() — create epoll fd
    APP->>KERN: epoll_ctl(EPOLL_CTL_ADD, fd1, EPOLLIN)
    APP->>KERN: epoll_ctl(EPOLL_CTL_ADD, fd2, EPOLLIN)
    APP->>KERN: epoll_ctl(EPOLL_CTL_ADD, fd3, EPOLLIN)
    Note over KERN: Kernel registers interest list internally No repeated fd set copies

    APP->>KERN: epoll_wait(epfd, events, maxevents, timeout)
    Note over KERN: Thread blocks, kernel monitors all fds
    Note over KERN: fd2 becomes readable (data arrives)
    KERN-->>APP: returns 1 event: {fd2, EPOLLIN}
    Note over APP: Only process fd2, not all fds
```

**Why epoll is O(1):**
- Interest list stored in a red-black tree inside kernel — `epoll_ctl` is O(log N)
- Ready list is a separate linked list — when an fd becomes ready the kernel adds it directly
- `epoll_wait` returns only ready fds — app never scans unready ones

**Edge-triggered (EPOLLET) vs level-triggered (default):**
- **Level-triggered (default):** `epoll_wait` returns as long as data is available. Safe but can cause many wakeups.
- **Edge-triggered:** `epoll_wait` returns only when state changes (new data arrives). More efficient but you MUST read until `EAGAIN` or you'll miss data.

```c
// Adding fd with edge-triggered mode
struct epoll_event ev;
ev.events = EPOLLIN | EPOLLET;   // edge-triggered
ev.data.fd = client_fd;
epoll_ctl(epfd, EPOLL_CTL_ADD, client_fd, &ev);
```

---

## Go's Runtime Netpoller (Built on epoll)

Go doesn't expose epoll directly. Its runtime wraps it transparently — Go code looks blocking but is actually non-blocking underneath.

```mermaid
graph TD
    classDef go    fill:#00add8,stroke:#007d9c,color:#fff,rx:8
    classDef run   fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef kern  fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8

    GOCODE["Go code: conn.Read(buf) looks like blocking I/O"]:::go
    RUNTIME["Go runtime: 1. Sets fd to non-blocking 2. Calls read() — gets EAGAIN 3. Registers fd with epoll 4. Parks goroutine (not OS thread)"]:::run
    EPOLL["Linux epoll waits for fd to be readable"]:::kern
    NETPOLL["Go netpoller goroutine calls epoll_wait when fd ready: unparks goroutine"]:::run
    RESUME["Goroutine resumes read() succeeds returns to Go code"]:::go

    GOCODE --> RUNTIME --> EPOLL
    EPOLL --> NETPOLL --> RESUME
```

**The key insight:** One OS thread runs many goroutines. When a goroutine would block on I/O, the runtime parks it and switches to another goroutine on the same OS thread. The OS thread never actually blocks — it's always running some goroutine. This is how Go handles 100,000 concurrent connections with far fewer OS threads than connections.

---

## io_uring — True Async I/O (Linux 5.1+)

```mermaid
graph LR
    classDef sq   fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef cq   fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef kern fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    APP["Application"]
    SQ["Submission Queue (SQ) App writes I/O requests ring buffer shared with kernel no syscall needed"]:::sq
    KERN["Kernel processes SQ entries does I/O asynchronously"]:::kern
    CQ["Completion Queue (CQ) Kernel writes results App polls for completions no syscall needed"]:::cq

    APP -->|"writes request"| SQ
    SQ --> KERN
    KERN -->|"writes result"| CQ
    CQ -->|"app reads result"| APP
```

**Why io_uring is faster than epoll:**
- Zero-copy between app and kernel (shared ring buffers)
- Batched submissions — submit 100 I/O operations with one syscall (or zero with `SQPOLL`)
- Works for files, not just sockets (epoll doesn't work on regular files — `O_NONBLOCK` on files is a lie)
- No context switches in `SQPOLL` mode — kernel thread polls SQ continuously

**In Go:** Go 1.21+ has experimental io_uring support. Not yet default (as of 2025). Tokio (Rust) uses it heavily. For now, Go's epoll-based netpoller is excellent for most cases.

---

## Comparison

| Model | Syscall | Scalability | CPU when idle | Works for files? | Used by |
|-------|---------|-------------|--------------|-----------------|---------|
| Blocking | `read/write` | O(1) per conn, O(N) threads | Low | Yes | Simple servers |
| Non-blocking poll | `read` + busy loop | Poor (CPU waste) | High | Yes | Rarely used directly |
| select | `select` | O(N) fds | Low | Yes | Legacy code |
| poll | `poll` | O(N) fds | Low | Yes | Legacy code |
| epoll | `epoll_wait` | O(1) events | Low | No (sockets only) | nginx, Node.js, Go, Redis |
| io_uring | ring buffer | O(1), zero-copy | Very low | Yes | Tokio, newer Linux services |
