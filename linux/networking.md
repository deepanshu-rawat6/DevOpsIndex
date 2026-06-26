# Linux Networking Internals

---

## TCP/IP Stack in the Kernel

```mermaid
graph TD
    classDef app   fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef sock  fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef tcp   fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef ip    fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef eth   fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef kern  fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    APP["Application: Go, nginx, postgres"]:::app
    SYSCALL["System Call Interface: read/write/send/recv"]:::kern
    SOCKET["Socket layer: AF_INET SOCK_STREAM File descriptor abstraction over network"]:::sock
    TCP["TCP layer: segmentation, retransmit, flow control, congestion control SYN/SYN-ACK/ACK handshake, FIN/FIN-ACK teardown"]:::tcp
    IP["IP layer: routing, fragmentation src/dst IP, TTL, protocol field"]:::ip
    NETFILTER["netfilter hooks: iptables, nftables, conntrack PREROUTING, INPUT, FORWARD, OUTPUT, POSTROUTING"]:::kern
    ETH["Ethernet/NIC driver: MAC addresses, frames Ring buffer: kernel DMA from NIC"]:::eth
    WIRE["Network wire / virtual interface"]:::eth

    APP --> SYSCALL --> SOCKET --> TCP --> IP --> NETFILTER --> ETH --> WIRE
```

**Key layers:**
- **Socket** — the file descriptor your app holds. `fd = socket(AF_INET, SOCK_STREAM, 0)`. All I/O goes through kernel VFS after this.
- **TCP** — reliable, ordered, byte-stream. The kernel manages retransmits, ACKs, flow control (receive window), and congestion control (CUBIC/BBR algorithms).
- **IP** — best-effort delivery, routing decisions per packet based on routing table.
- **netfilter** — hooks at 5 points in the stack. iptables and nftables register rules here. conntrack tracks connection state for stateful firewalls and NAT.

---

## Sockets and the Accept Loop

```mermaid
sequenceDiagram
    participant S as Server Process
    participant K as Kernel
    participant C as Client

    S->>K: socket() — create socket fd
    S->>K: bind(fd, 0.0.0.0:8080) — claim the port
    S->>K: listen(fd, backlog=128) — mark passive, create accept queue
    Note over K: Kernel now handles SYN/SYN-ACK/ACK for this port
    C->>K: SYN to server:8080
    K->>K: 3-way handshake completes, connection queued
    S->>K: accept(fd) — dequeue one completed connection
    K-->>S: new fd for this client connection
    S->>S: read/write on new fd (worker goroutine/thread)
```

**The accept queue (backlog):** The kernel completes the 3-way handshake and places fully established connections in the accept queue. `listen(fd, backlog)` sets the queue size. If your app is slow to call `accept()`, the queue fills → new connections get `ECONNREFUSED` or the SYN is silently dropped. Under load: `ss -lnt | grep :8080` — `Recv-Q` shows queued connections.

**`SO_REUSEPORT`:** Multiple processes/threads can bind the same port. The kernel load-balances incoming connections across all listeners. Used by nginx (one socket per worker process) and Go's `net.ListenConfig{Control: ...}`. Eliminates the single `accept()` bottleneck.

---

## TCP States and TIME_WAIT

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> LISTEN : server listen()
    CLOSED --> SYN_SENT : client connect()
    SYN_SENT --> ESTABLISHED : SYN-ACK received
    LISTEN --> SYN_RCVD : SYN received
    SYN_RCVD --> ESTABLISHED : ACK received
    ESTABLISHED --> FIN_WAIT_1 : active close send FIN
    ESTABLISHED --> CLOSE_WAIT : passive close FIN received
    FIN_WAIT_1 --> FIN_WAIT_2 : ACK received
    FIN_WAIT_2 --> TIME_WAIT : FIN received
    CLOSE_WAIT --> LAST_ACK : send FIN
    LAST_ACK --> CLOSED : ACK received
    TIME_WAIT --> CLOSED : 2xMSL timeout 60s
```

**TIME_WAIT** is the most misunderstood TCP state. After active close, the socket stays in TIME_WAIT for `2 * MSL` (Maximum Segment Lifetime = 60s on Linux). Purpose:
1. Ensures the final ACK reaches the remote side (if lost, remote retransmits FIN)
2. Prevents old packets from a dead connection being mistaken for a new one

**Why it causes problems:** High-throughput services (proxies, load balancers) cycling many short-lived connections accumulate thousands of TIME_WAIT sockets. Each holds a local port. Port range: 32768-60999 (28231 ports). Exhaust them → `EADDRNOTAVAIL`.

**Fixes:**
```bash
# Check TIME_WAIT count
ss -s | grep TIME-WAIT

# Allow reuse of TIME_WAIT sockets for new connections (safe for clients)
sysctl -w net.ipv4.tcp_tw_reuse=1

# Expand ephemeral port range
sysctl -w net.ipv4.ip_local_port_range="1024 65535"

# Enable TCP timestamps (required for tw_reuse to work safely)
sysctl -w net.ipv4.tcp_timestamps=1
```

---

## netfilter and iptables

netfilter is the Linux kernel framework for packet filtering, NAT, and connection tracking. iptables is the userspace tool that programs netfilter rules.

```mermaid
graph LR
    classDef hook  fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef table fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef chain fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph Incoming["Incoming packet"]
        PRE["PREROUTING hook DNAT (port forwarding) conntrack: mark NEW/ESTABLISHED"]:::hook
        IN["INPUT hook packet to local process iptables INPUT chain"]:::hook
        FWD["FORWARD hook packet being routed iptables FORWARD chain"]:::hook
    end

    subgraph Outgoing["Outgoing packet"]
        OUT["OUTPUT hook locally generated packets"]:::hook
        POST["POSTROUTING hook SNAT/MASQUERADE kube-proxy writes rules here"]:::hook
    end

    PRE --> IN
    PRE --> FWD
    FWD --> POST
    IN --> OUT
    OUT --> POST
```

**conntrack:** Tracks the state of every connection (NEW, ESTABLISHED, RELATED, INVALID). Stateful firewall rules use conntrack — "allow ESTABLISHED,RELATED" means replies to outbound connections are automatically allowed without an explicit inbound rule. `cat /proc/net/nf_conntrack` shows current table.

**Kubernetes uses netfilter heavily:** kube-proxy writes DNAT rules in PREROUTING (ClusterIP → pod IP) and MASQUERADE rules in POSTROUTING (pod IP → node IP for external traffic).

---

## Kernel TCP Tuning

Critical settings for high-connection services (nginx, databases, load balancers):

```bash
# /etc/sysctl.conf or applied via sysctl -w

# Accept queue size — how many completed connections kernel queues before app accepts
net.core.somaxconn = 65535           # system max (default: 4096)
net.ipv4.tcp_max_syn_backlog = 65535 # SYN queue size (incomplete handshakes)

# TIME_WAIT handling
net.ipv4.tcp_tw_reuse = 1            # reuse TIME_WAIT sockets for outbound connections
net.ipv4.ip_local_port_range = 1024 65535  # ephemeral port range

# Buffer sizes — critical for throughput
net.core.rmem_max = 134217728        # 128MB max receive buffer
net.core.wmem_max = 134217728        # 128MB max send buffer
net.ipv4.tcp_rmem = 4096 87380 134217728   # min/default/max
net.ipv4.tcp_wmem = 4096 65536 134217728

# Connection keepalive — detect dead connections
net.ipv4.tcp_keepalive_time = 60     # start probes after 60s idle (default: 7200s!)
net.ipv4.tcp_keepalive_intvl = 10    # probe every 10s
net.ipv4.tcp_keepalive_probes = 5    # 5 failed probes → close connection

# File descriptors (sockets are fds)
fs.file-max = 1000000                # system-wide fd limit
```

**Why `somaxconn` matters:** If your service gets a burst of connections and `accept()` can't keep up, the kernel silently drops new SYNs once the accept queue is full. `ss -lnt` shows `Recv-Q` — if it's consistently at your backlog limit, raise `somaxconn` and optimize your accept loop.
