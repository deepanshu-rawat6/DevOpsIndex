# Linux Boot Process

---

## BIOS/UEFI to Userspace

```mermaid
graph TD
    classDef fw   fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef boot fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef kern fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef init fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef svc  fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    POWER["Power ON"]:::fw

    subgraph Firmware["Firmware (BIOS or UEFI)"]
        POST["POST: Power-On Self Test check RAM, CPU, devices"]:::fw
        BIOS["BIOS: reads MBR (first 512 bytes of disk) hands off to bootloader"]:::fw
        UEFI["UEFI: reads EFI System Partition directly loads bootloader faster, Secure Boot support"]:::fw
    end

    GRUB["GRUB2 Bootloader /boot/grub2/grub.cfg shows OS selection menu loads kernel + initramfs into RAM"]:::boot

    KERNEL["Linux Kernel decompresses itself initializes CPU, memory, devices mounts initramfs as temporary root /"]:::kern

    INITRAMFS["initramfs (initial RAM filesystem) minimal filesystem in RAM contains drivers needed to mount real root (disk drivers, LVM, LUKS decrypt)"]:::kern

    REALROOT["Mount real root filesystem (ext4/xfs on /dev/sda1 or LVM volume) switch_root to real /"]:::kern

    INIT["PID 1: systemd (or SysVinit/OpenRC) first userspace process starts all services"]:::init

    TARGETS["systemd targets multi-user.target graphical.target"]:::init

    SERVICES["Services start in parallel sshd, networkd, nginx, docker, etc."]:::svc

    LOGIN["Login prompt / getty"]:::svc

    POWER --> Firmware
    Firmware --> GRUB
    GRUB --> KERNEL
    KERNEL --> INITRAMFS
    INITRAMFS --> REALROOT
    REALROOT --> INIT
    INIT --> TARGETS
    TARGETS --> SERVICES
    SERVICES --> LOGIN
```

**BIOS vs UEFI:**
| | BIOS | UEFI |
|--|------|------|
| Partition table | MBR (max 2TB disk, 4 partitions) | GPT (max 9.4ZB, 128 partitions) |
| Boot code location | First 512 bytes of disk (MBR) | EFI System Partition (FAT32, /boot/efi) |
| Secure Boot | No | Yes (verifies bootloader signature) |
| Speed | Slower | Faster (parallel init) |
| Common on | Pre-2012 hardware | All modern hardware |

---

## initramfs and Why It Exists

The kernel can't mount the real root filesystem directly because it might need drivers that aren't compiled in (e.g., LUKS encryption, LVM, NFS root, specific disk drivers). initramfs is a temporary filesystem that provides those drivers.

```mermaid
graph LR
    classDef kern fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef init fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef real fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    KERNEL["Kernel loaded into RAM no disk drivers yet"]:::kern
    INITRD["initramfs mounted as / has: busybox, dracut scripts disk drivers as kernel modules cryptsetup for LUKS"]:::init
    DRIVERS["Load disk drivers decrypt LUKS volume assemble LVM/RAID"]:::init
    REAL["Mount real / (ext4/xfs) switch_root initramfs discarded from RAM"]:::real

    KERNEL --> INITRD --> DRIVERS --> REAL
```

```bash
# Inspect initramfs contents
lsinitrd /boot/initramfs-$(uname -r).img

# Rebuild after driver changes
dracut --force           # RHEL/CentOS
update-initramfs -u     # Debian/Ubuntu
```

---

## systemd

systemd is PID 1 — the init system that starts and manages all services. It replaced SysVinit for parallel service startup and better dependency management.

```mermaid
graph TD
    classDef target fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef svc    fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef dep    fill:#3498db,stroke:#2980b9,color:#fff,rx:8

    DEFAULT["default.target (usually multi-user or graphical)"]:::target

    DEFAULT --> MULTI["multi-user.target all non-GUI services"]:::target
    MULTI --> BASIC["basic.target timers, paths, sockets"]:::target
    BASIC --> SYSINIT["sysinit.target mount filesystems, swap, hostname"]:::target

    MULTI --> SSHD["sshd.service"]:::svc
    MULTI --> NGINX["nginx.service"]:::svc
    MULTI --> DOCKER["docker.service"]:::svc
    MULTI --> NETWORK["network-online.target"]:::dep
    NETWORK --> APP["myapp.service After=network-online.target"]:::svc
```

### Unit File Anatomy

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My Go Application
After=network-online.target postgresql.service   # start after these
Requires=postgresql.service                       # hard dependency (fail if postgres fails)
Wants=redis.service                               # soft dependency (start redis if possible)

[Service]
Type=simple                    # exec: ExecStart is the main process
ExecStart=/usr/local/bin/myapp --config /etc/myapp/config.yaml
ExecReload=/bin/kill -HUP $MAINPID  # reload config on: systemctl reload myapp
WorkingDirectory=/opt/myapp
User=appuser
Group=appuser
Restart=on-failure             # restart if exits non-zero
RestartSec=5s                  # wait 5s before restart
StartLimitBurst=5              # max 5 restarts
StartLimitIntervalSec=30s      # within 30s window — then fail permanently

# Resource limits
LimitNOFILE=65536              # max open file descriptors
MemoryMax=512M                 # cgroup memory limit
CPUQuota=200%                  # max 2 CPU cores

# Security hardening
NoNewPrivileges=true           # process cannot gain extra privileges
PrivateTmp=true                # own /tmp (not shared with other services)
ProtectSystem=strict           # /usr, /boot, /etc read-only
ReadWritePaths=/var/lib/myapp  # only this path is writable

# Environment
Environment=APP_ENV=production
EnvironmentFile=/etc/myapp/env  # load from file

[Install]
WantedBy=multi-user.target     # enable for this target
```

### Essential systemctl Commands

```bash
systemctl start myapp
systemctl stop myapp
systemctl restart myapp
systemctl reload myapp          # reload config (sends ExecReload signal)
systemctl status myapp          # detailed status + last log lines
systemctl enable myapp          # auto-start on boot
systemctl disable myapp
systemctl daemon-reload         # reload unit files after editing
systemctl list-units --failed   # see broken services
systemctl list-dependencies myapp  # show dependency tree

# Logs
journalctl -u myapp -f          # follow logs
journalctl -u myapp --since "1 hour ago"
journalctl -u myapp -n 100      # last 100 lines
journalctl -p err -b            # errors since last boot
journalctl --disk-usage         # how much journal space used

# Boot analysis
systemd-analyze                 # total boot time
systemd-analyze blame           # which units took longest
systemd-analyze critical-chain  # critical path of boot
```

### Service Types

| Type | Meaning | Use for |
|------|---------|---------|
| `simple` | ExecStart process IS the service | Most daemons |
| `forking` | ExecStart forks, parent exits | Old-style daemons (nginx, apache) |
| `notify` | Process sends `sd_notify(READY=1)` when ready | Services that take time to init |
| `oneshot` | Process runs and exits (not a daemon) | Init scripts, migrations |
| `idle` | Like simple but waits until boot is done | Low-priority startup tasks |
