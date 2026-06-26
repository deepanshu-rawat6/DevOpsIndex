# Linux Security

---

## Capabilities — Fine-Grained Privilege

Historically: root (uid 0) had all-or-nothing privilege. Capabilities split root power into ~40 distinct units. A process can have specific capabilities without being fully root.

```mermaid
graph TD
    classDef cap    fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef root   fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef safe   fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef drop   fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    ROOT["Traditional root CAP_ALL — can do everything bind port 80, load modules, kill any process, raw sockets"]:::root

    ROOT --> SPLIT["Split into capabilities each independently grantable"]:::drop

    SPLIT --> CAP_NET["CAP_NET_BIND_SERVICE bind port < 1024 (nginx, sshd need this)"]:::cap
    SPLIT --> CAP_KILL["CAP_KILL kill processes of other users"]:::cap
    SPLIT --> CAP_SYS["CAP_SYS_ADMIN most dangerous — avoid mount filesystems, change namespaces used by privileged containers"]:::root
    SPLIT --> CAP_CHOWN["CAP_CHOWN change file ownership"]:::cap
    SPLIT --> CAP_RAW["CAP_NET_RAW raw sockets (ping, tcpdump)"]:::cap

    SPLIT --> DROP["Drop all other capabilities minimum privilege"]:::safe
```

### Capability Sets Per Process

Every process has three capability sets:
- **Permitted:** what the process is allowed to have
- **Effective:** what the process currently uses (subset of permitted)
- **Inheritable:** what child processes can inherit

```bash
# Check capabilities of a process
cat /proc/<PID>/status | grep Cap
# CapPrm: 00000000a80425fb   (permitted)
# CapEff: 00000000a80425fb   (effective)
# CapBnd: 000000ffffffffff   (bounding set — max that can ever be set)

# Decode capability hex
capsh --decode=00000000a80425fb

# Check capabilities of a binary
getcap /usr/bin/ping
# /usr/bin/ping = cap_net_raw+ep

# Set capability on binary (instead of setuid root)
setcap cap_net_bind_service+ep /usr/local/bin/myapp
# Now myapp can bind port 80 without running as root

# Drop all capabilities in a process (Docker does this)
capsh --drop=all -- -c "./myapp"
```

### Containers and Capabilities

Docker drops ~14 dangerous capabilities by default. `--privileged` gives back all of them — equivalent to running as root on the host.

```bash
# Default dropped by Docker:
# CAP_SYS_ADMIN, CAP_SYS_RAWIO, CAP_SYS_MODULE, CAP_SYS_PTRACE,
# CAP_NET_ADMIN, CAP_AUDIT_WRITE, etc.

# Add specific capability (instead of --privileged)
docker run --cap-add NET_ADMIN myimage

# Drop all, add only what's needed
docker run --cap-drop ALL --cap-add NET_BIND_SERVICE myimage
```

---

## setuid / setgid

setuid (SUID) bit: when set on an executable, the process runs with the **file owner's** UID, not the invoking user's UID.

```mermaid
graph LR
    classDef user fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef root fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef suid fill:#e67e22,stroke:#d35400,color:#fff,rx:8

    USER["User: deepanshu (uid=1000)"]:::user
    SUDO_BIN["/usr/bin/sudo -rwsr-xr-x (s = suid bit) owned by root"]:::suid
    PRIV["Process runs as uid=0 (root) even though deepanshu invoked it"]:::root

    USER -->|"executes"| SUDO_BIN
    SUDO_BIN --> PRIV
```

```bash
# Find all SUID binaries on system (security audit)
find / -perm -4000 -type f 2>/dev/null

# Common legitimate SUID binaries:
# /usr/bin/sudo   — escalate to root
# /usr/bin/passwd — write to /etc/shadow (root-owned)
# /usr/bin/ping   — raw socket (now uses capabilities on modern systems)

# Set SUID bit
chmod u+s /path/to/binary
chmod 4755 /path/to/binary    # 4 = suid, 755 = rwxr-xr-x
```

**Security risk:** An exploitable SUID binary running as root = full root compromise. Always audit SUID binaries. Modern approach: use capabilities instead of SUID where possible.

---

## seccomp — Syscall Filtering

seccomp (Secure Computing Mode) filters which syscalls a process is allowed to make. A process attempting a blocked syscall receives `SIGSYS` (killed) or `EPERM`.

```mermaid
graph TD
    classDef proc fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef kern fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef allow fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef deny fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    PROC["Process makes syscall e.g. ptrace(PTRACE_ATTACH)"]:::proc
    BPF["seccomp BPF program checks syscall number + args against policy"]:::kern
    ALLOW["ALLOW syscall proceeds normally"]:::allow
    KILL["KILL_PROCESS SIGSYS sent, process terminated"]:::deny
    ERRNO["ERRNO return error code to process"]:::deny
    LOG["LOG log and allow (audit mode)"]:::allow

    PROC --> BPF
    BPF -->|"read, write, open"| ALLOW
    BPF -->|"ptrace, perf_event_open"| KILL
    BPF -->|"socket (if blocked)"| ERRNO
```

**Docker's default seccomp profile** blocks ~44 of ~400+ syscalls including: `ptrace`, `perf_event_open`, `clone` (with CLONE_NEWUSER), `mount`, `kexec_load`, `syslog`, `acct`.

```bash
# Run container with custom seccomp profile
docker run --security-opt seccomp=/path/to/profile.json myimage

# Run without seccomp (dangerous)
docker run --security-opt seccomp=unconfined myimage

# Check if seccomp is active
grep Seccomp /proc/<PID>/status
# Seccomp: 2   (0=disabled, 1=strict, 2=filter/BPF)

# Log blocked syscalls without killing (useful for building profiles)
strace -c ./myapp 2>&1 | head -30   # see all syscalls made
```

**Kubernetes:** Pods can specify seccomp profiles via `securityContext.seccompProfile`. Since K8s 1.25, the default is `RuntimeDefault` (container runtime's default profile).

```yaml
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault    # use Docker/containerd default profile
      # type: Localhost       # use custom profile from node
      # localhostProfile: profiles/myapp.json
```

---

## AppArmor and SELinux — Mandatory Access Control

Both are **MAC (Mandatory Access Control)** systems — they enforce security policies that even root cannot override (without CAP_MAC_ADMIN).

```mermaid
graph LR
    classDef aa   fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef se   fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef dac  fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    subgraph DAC["DAC: Discretionary Access Control (standard Linux)"]
        PERM["rwxr-xr-x permissions UID/GID ownership User can change their own files"]:::dac
    end

    subgraph AppArmor["AppArmor (Ubuntu/Debian default)"]
        AA_PROFILE["Profile per application /etc/apparmor.d/usr.bin.nginx Path-based: allow/deny specific files Easier to write, less granular"]:::aa
        AA_MODE["enforce: violations blocked + logged complain: violations logged only (audit)"]:::aa
    end

    subgraph SELinux["SELinux (RHEL/CentOS default)"]
        SE_LABEL["Every file + process has a label system_u:system_r:nginx_t:s0 Type Enforcement: nginx_t can only read httpd_sys_content_t files"]:::se
        SE_MODE["enforcing: block violations permissive: log only (testing) disabled: off"]:::se
    end
```

### AppArmor Quick Reference

```bash
# Check status
aa-status

# Set profile to complain mode (log but don't block — for testing)
aa-complain /etc/apparmor.d/usr.bin.nginx

# Set to enforce
aa-enforce /etc/apparmor.d/usr.bin.nginx

# Reload profiles after changes
apparmor_parser -r /etc/apparmor.d/usr.bin.nginx

# Check if a process is confined
cat /proc/<PID>/attr/current
# nginx (enforce)
```

### SELinux Quick Reference

```bash
# Check mode
getenforce          # Enforcing / Permissive / Disabled
sestatus            # detailed status

# Temporarily switch to permissive (diagnostic — doesn't persist)
setenforce 0

# Check why something was denied
ausearch -m AVC -ts recent
sealert -a /var/log/audit/audit.log

# Common fix: restore default context on misplaced files
restorecon -Rv /var/www/html/

# Check file context
ls -Z /etc/nginx/nginx.conf
# system_u:object_r:httpd_config_t:s0  nginx.conf

# Check process context
ps -eZ | grep nginx
# system_u:system_r:httpd_t:s0  nginx
```

**The #1 SELinux issue:** Moving a file from one location to another loses its SELinux context. `restorecon` fixes it.

### Security Layers Together

```mermaid
graph TD
    classDef layer fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef check fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    REQ["Process attempts action e.g. nginx reads /etc/shadow"]:::layer

    DAC["1. DAC check Does nginx user have read permission? rw-r--r-- owned by root nginx uid=33 --> no permission"]:::check
    CAP["2. Capability check Does nginx have CAP_DAC_READ_SEARCH? No --> denied"]:::check
    SECCOMP["3. seccomp check Is this syscall allowed? open() --> yes"]:::check
    MAC["4. MAC check (SELinux/AppArmor) nginx_t type can read httpd_config_t /etc/shadow is shadow_t --> denied"]:::check

    REQ --> DAC --> CAP --> SECCOMP --> MAC
    DAC -->|"denied"| DENY["EACCES returned"]
    MAC -->|"denied"| DENY2["EACCES + audit log"]
```

Defense in depth: even if one layer is misconfigured, others catch it.
