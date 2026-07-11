# GCP Compute Engine (GCE)

Compute Engine is GCP's VM service — equivalent to AWS EC2. Google's infrastructure advantage shows up here: live migration, custom machine types, and better sustained use economics.

---

## Machine Families Overview

```
AWS EC2 Instance Families          GCP Machine Families
──────────────────────────────────────────────────────────
t3, t4g (burstable)             →  e2 (cost-optimized, shared/dedicated)
m5, m6i (general purpose)       →  n2, n2d, n4 (general purpose)
c5, c6i (compute optimized)     →  c2, c3 (compute optimized)
r5, r6i (memory optimized)      →  m1, m2, m3 (memory optimized)
p3, p4 (GPU)                    →  a2, g2 (GPU — A100/L4)
inf1, trn1 (ML inferencing)     →  a3 (H100 GPU), TPU (unique to GCP)
```

### Machine Family Quick Guide

| Family | vCPU range | Best for | AWS analog |
|--------|-----------|----------|-----------|
| **e2** | 2–32 | Dev/test, low-traffic services | t3/t3a |
| **n2** | 2–128 | General purpose production | m5/m6i |
| **n2d** | 2–224 | Same as n2, AMD EPYC, cheaper | m6a |
| **c2** | 4–60 | CPU-bound: gaming, HPC, media | c5 |
| **c3** | 4–176 | Latest gen compute optimized | c6i |
| **m1** | 40–160 | High-memory: SAP, in-memory DB | r5 |
| **m3** | 4–128 | Memory optimized, newer gen | r6i |
| **a2** | 12–96 | A100 GPU workloads | p4 |
| **g2** | 4–96 | L4 GPU, inference | g5 |

---

## Custom Machine Types — GCP's Killer Feature

AWS forces you into predefined sizes (4 vCPU → 16GB, or 8 vCPU → 32GB, etc.). GCP lets you specify exact vCPU and memory independently:

```bash
# AWS: you'd pick m5.xlarge (4 vCPU, 16 GB) even if you need 4 vCPU, 10 GB
# GCP: specify exactly what you need
gcloud compute instances create my-vm \
  --machine-type=custom-4-10240    # 4 vCPUs, 10240 MB (10 GB)

# Format: custom-{vCPUs}-{memoryMB}
# Constraints: memory must be between 0.9 GB and 6.5 GB per vCPU

# Extended memory (beyond 6.5 GB/vCPU)
gcloud compute instances create my-vm \
  --machine-type=custom-4-30720-ext    # 4 vCPUs, 30 GB (extended)
```

This often saves 20-40% cost compared to the next-size-up predefined instance on AWS.

---

## Creating a VM

```bash
# Minimal VM
gcloud compute instances create my-vm \
  --zone=us-central1-a \
  --machine-type=n2-standard-2

# Production VM with all options
gcloud compute instances create prod-vm \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-ssd \
  --network=my-vpc \
  --subnet=us-subnet \
  --no-address \                     # no external IP (private VM)
  --service-account=my-app-sa@project.iam.gserviceaccount.com \
  --scopes=cloud-platform \          # allow SA to call any GCP API it has IAM for
  --tags=backend \                   # firewall rule selector
  --metadata=startup-script='#!/bin/bash
    apt-get update -y
    apt-get install -y nginx'
```

### Key Flags vs AWS

| AWS EC2 | GCP gcloud | Notes |
|---------|-----------|-------|
| `--image-id ami-xxx` | `--image-family=debian-12 --image-project=debian-cloud` | Use families, not specific image IDs |
| `--iam-instance-profile` | `--service-account=` | GCP SA = EC2 instance profile |
| `--security-group-ids` | `--tags=` or `--network=` | Tags select firewall rules |
| `--subnet-id` | `--subnet=` | Same concept |
| `--associate-public-ip-address` | (default is to assign external IP) | Use `--no-address` to suppress |
| `--user-data` | `--metadata=startup-script=` | Same concept |

---

## Disk Types

| Disk type | IOPS | Throughput | Use case | AWS analog |
|-----------|------|-----------|----------|-----------|
| `pd-standard` | Shared | Low | Dev/test, cold data | gp2 (old) |
| `pd-balanced` | 3,000 IOPS/TB | Medium | Most workloads, default | gp3 |
| `pd-ssd` | 30,000 IOPS | High | Databases, latency-sensitive | io1 |
| `pd-extreme` | 120,000 IOPS | Very high | High-perf databases | io2 Block Express |
| `hyperdisk-balanced` | Up to 160,000 IOPS | Configurable | Latest gen, best perf | io2 |

```bash
# Add a persistent disk to a running VM
gcloud compute disks create my-data-disk \
  --zone=us-central1-a \
  --size=200GB \
  --type=pd-ssd

gcloud compute instances attach-disk my-vm \
  --disk=my-data-disk \
  --zone=us-central1-a

# Resize a disk (can be done live, no reboot needed)
gcloud compute disks resize my-data-disk \
  --size=400GB \
  --zone=us-central1-a
# Then: sudo resize2fs /dev/sdb (inside VM)
```

**GCP advantage**: Persistent Disk can be attached to multiple VMs in read-only mode (for shared datasets). EBS multi-attach is limited and complex.

---

## Preemptible VMs and Spot VMs

Two types of discounted VMs:

| | Preemptible VM | Spot VM |
|--|---|---|
| **Max runtime** | 24 hours (hard limit) | No limit |
| **Preemption notice** | 30 seconds via ACPI shutdown | 30 seconds |
| **Discount** | 60–91% off | 60–91% off |
| **Availability** | Less predictable | More predictable than preemptible |
| **AWS analog** | Spot Instance (but 24hr cap is GCP-specific) | Spot Instance |
| **Use case** | Batch jobs, HPC, ML training | Same, but better for longer jobs |

```bash
# Spot VM (recommended over preemptible for new workloads)
gcloud compute instances create my-spot-vm \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP   # STOP or DELETE on preemption

# Preemptible (legacy)
gcloud compute instances create my-preemptible-vm \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --preemptible
```

### Handling Preemption

```bash
# Check if VM was preempted
gcloud compute instances describe my-vm \
  --zone=us-central1-a \
  --format='get(scheduling.preempted)'

# Use a startup script to resume work after preemption
--metadata=startup-script='#!/bin/bash
  # check if this is a restart after preemption
  PREEMPTED=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/preempted" -H "Metadata-Flavor: Google")
  if [ "$PREEMPTED" = "true" ]; then
    # resume from checkpoint
    gsutil cp gs://my-bucket/checkpoint.pkl /tmp/checkpoint.pkl
  fi
  python3 /opt/train.py'
```

---

## Instance Templates and Managed Instance Groups (MIGs)

AWS: Launch Template + Auto Scaling Group. GCP: Instance Template + Managed Instance Group.

```bash
# Instance Template = Launch Template
gcloud compute instance-templates create my-template \
  --machine-type=n2-standard-2 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=backend \
  --service-account=my-app-sa@project.iam.gserviceaccount.com \
  --metadata=startup-script='#!/bin/bash
    apt-get install -y my-app
    systemctl start my-app'

# Managed Instance Group = Auto Scaling Group
gcloud compute instance-groups managed create my-mig \
  --template=my-template \
  --size=3 \
  --region=us-central1

# Enable autoscaling (= ASG scaling policy)
gcloud compute instance-groups managed set-autoscaling my-mig \
  --region=us-central1 \
  --min-num-replicas=2 \
  --max-num-replicas=20 \
  --target-cpu-utilization=0.60 \
  --cool-down-period=90
```

### MIG Health Checks (= ASG Health Checks)

```bash
# Create health check
gcloud compute health-checks create http my-health-check \
  --port=8080 \
  --request-path=/health \
  --check-interval=10s \
  --timeout=5s \
  --healthy-threshold=2 \
  --unhealthy-threshold=3

# Attach to MIG
gcloud compute instance-groups managed update my-mig \
  --health-checks=my-health-check \
  --initial-delay=120s \
  --region=us-central1
```

---

## SSH and Connectivity

```bash
# SSH to a VM (gcloud handles key management — no .pem files needed)
gcloud compute ssh my-vm --zone=us-central1-a

# SSH to a private VM (no external IP) via OS Login + IAP tunnel
# IAP = Identity-Aware Proxy (GCP's Session Manager equivalent)
gcloud compute ssh my-vm \
  --zone=us-central1-a \
  --tunnel-through-iap

# Required firewall rule for IAP
gcloud compute firewall-rules create allow-iap-ssh \
  --network=my-vpc \
  --direction=INGRESS \
  --action=ALLOW \
  --source-ranges=35.235.240.0/20 \  # Google IAP IP range
  --rules=tcp:22
```

**GCP advantage**: IAP tunneling is like AWS Systems Manager Session Manager — SSH to private VMs without bastion hosts or public IPs. No .pem files, keys rotated per session.

---

## Live Migration — GCP's Unique Advantage

AWS: when underlying hardware needs maintenance, your instance gets rebooted (scheduled maintenance event). GCP: VMs are **live migrated** — moved to another host transparently while running. You see a brief performance dip (~10ms) but no reboot, no downtime.

This is why GCP claims better VM availability SLAs. For stateful applications (databases running on GCE), this is significant.

---

## Pricing Model

```
On-demand:          full price, no commitment
Preemptible/Spot:   60-91% discount, can be preempted
Committed use:      1yr = 37% off, 3yr = 55% off (like Reserved Instances, but simpler)
Sustained use:      AUTOMATIC — run >25% of month → auto-discount, no commitment

Example n2-standard-4 (us-central1):
  On-demand:   $0.19/hr  (~$140/mo)
  Sustained:   auto ~25% off if running all month (~$105/mo)
  1yr commit:  ~$88/mo
  3yr commit:  ~$63/mo
  Spot VM:     ~$0.057/hr (~$42/mo)
```

Sustained use discounts are **fully automatic** — just run a VM for most of the month and Google discounts it. AWS requires you to purchase Reserved Instances upfront.

---

## GCE vs EC2 — Summary

| Feature | GCP GCE | AWS EC2 |
|---------|---------|---------|
| Custom machine types | Yes — any CPU/mem combo | No — fixed sizes |
| Live migration | Yes — no reboot on host maintenance | No — instance restart |
| Sustained use discount | Automatic | Requires RI purchase |
| SSH key management | gcloud handles it / IAP tunnel | .pem files / SSM |
| Boot disk resize | Online (no reboot) | Offline (stop/start) |
| Spot/Preemptible notice | 30 seconds ACPI | 2 minutes (Spot) |
| GPU types | A100, H100, L4, T4 | V100, A100, H100, Inf |
| TPU access | Yes (unique to GCP) | No |
| Free control plane | GKE: one free zonal cluster/account, then $73/mo | EKS: $73/mo per cluster |

---

## Instance Groups

Instance groups let you manage multiple VMs as a single unit and attach them to load balancers. Two types: **Managed** (GCP controls the VMs) and **Unmanaged** (you control the VMs, GCP just groups them).

### Managed Instance Group (MIG)

A MIG creates **identical VMs from an instance template** and manages them automatically — auto-healing, auto-scaling, rolling updates, and multi-zone distribution.

```
Instance Template (blueprint)
    │
    ▼
Managed Instance Group
    ├── VM-1 (identical)
    ├── VM-2 (identical)
    └── VM-3 (identical)
         ↑ GCP auto-recreates any that fail health checks
```

**AWS analog:** Auto Scaling Group + Launch Template.

```bash
# 1. Create instance template
gcloud compute instance-templates create my-template \
  --machine-type=n2-standard-2 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=backend \
  --service-account=my-app-sa@project.iam.gserviceaccount.com \
  --metadata=startup-script='#!/bin/bash
    apt-get install -y my-app
    systemctl start my-app'

# 2. Regional MIG (spreads VMs across zones automatically — recommended)
gcloud compute instance-groups managed create my-mig \
  --template=my-template \
  --size=3 \
  --region=us-central1     # distributes across us-central1-a/b/c

# Zonal MIG (single zone, simpler but no zone-level HA)
gcloud compute instance-groups managed create my-mig-zonal \
  --template=my-template \
  --size=3 \
  --zone=us-central1-a
```

#### Auto-healing

```bash
# Create health check
gcloud compute health-checks create http my-hc \
  --port=8080 \
  --request-path=/health \
  --check-interval=10s \
  --unhealthy-threshold=3    # 3 consecutive failures → VM is recreated

# Attach health check to MIG
gcloud compute instance-groups managed update my-mig \
  --health-checks=my-hc \
  --initial-delay=120s \     # grace period after boot before checks count
  --region=us-central1
```

#### Auto-scaling

```bash
# Scale on CPU
gcloud compute instance-groups managed set-autoscaling my-mig \
  --region=us-central1 \
  --min-num-replicas=2 \
  --max-num-replicas=20 \
  --target-cpu-utilization=0.60 \
  --cool-down-period=90s

# Scale on HTTP load (requests/sec per instance)
gcloud compute instance-groups managed set-autoscaling my-mig \
  --region=us-central1 \
  --max-num-replicas=20 \
  --target-load-balancing-utilization=0.8

# Scale on Pub/Sub queue depth (custom metric)
gcloud compute instance-groups managed set-autoscaling my-mig \
  --region=us-central1 \
  --max-num-replicas=50 \
  --custom-metric-utilization=metric=pubsub.googleapis.com/subscription/num_undelivered_messages,utilization-target=100,utilization-target-type=GAUGE
```

#### Rolling Updates

```bash
# Zero-downtime rolling update to new template version
gcloud compute instance-groups managed rolling-action start-update my-mig \
  --version=template=my-template-v2 \
  --region=us-central1 \
  --max-surge=3 \            # create 3 extra VMs during rollout (no capacity drop)
  --max-unavailable=0        # never remove a VM before its replacement is healthy

# Canary: 10% of VMs on new version first
gcloud compute instance-groups managed rolling-action start-update my-mig \
  --version=template=my-template-v1 \
  --canary-version=template=my-template-v2,target-size=10% \
  --region=us-central1

# Rollback instantly
gcloud compute instance-groups managed rolling-action start-update my-mig \
  --version=template=my-template-v1 \
  --region=us-central1
```

#### Stateful MIG (for databases and stateful apps)

By default, when a VM in a MIG is recreated, its disk is wiped. Stateful MIG preserves per-VM state:

```bash
gcloud compute instance-groups managed update my-stateful-mig \
  --stateful-disk=device-name=data-disk,auto-delete=never \
  --stateful-external-ip=interface-name=nic0,auto-delete=never \
  --region=us-central1
# Each VM keeps its disk and IP across restarts/updates
```

---

### Unmanaged Instance Group (UIG)

A UIG is just a **label/grouping** for existing VMs. GCP does nothing automatically — no auto-healing, no auto-scaling, no rolling updates. You manually add and remove VMs. VMs in a UIG can have different machine types, images, and configs.

```
Unmanaged Instance Group
    ├── VM-A (n2-standard-4, debian)
    ├── VM-B (e2-standard-2, ubuntu)   ← different configs allowed
    └── VM-C (n1-standard-8, custom)
```

**The only real use case:** attaching a set of heterogeneous or pre-existing VMs to a load balancer. Load balancers require a backend to be an instance group or NEG — if your VMs already exist and aren't identical, UIG is how you group them.

```bash
# Create UIG
gcloud compute instance-groups unmanaged create my-uig \
  --zone=us-central1-a

# Add existing VMs
gcloud compute instance-groups unmanaged add-instances my-uig \
  --instances=vm-a,vm-b,vm-c \
  --zone=us-central1-a

# Define named ports (required for load balancer backend)
gcloud compute instance-groups unmanaged set-named-ports my-uig \
  --named-ports=http:8080 \
  --zone=us-central1-a

# Remove a VM
gcloud compute instance-groups unmanaged remove-instances my-uig \
  --instances=vm-a \
  --zone=us-central1-a
```

---

### MIG vs UIG — When to Use Which

| | Managed (MIG) | Unmanaged (UIG) |
|--|---|---|
| **Auto-healing** | Yes — recreates failed VMs | No |
| **Auto-scaling** | Yes | No |
| **Rolling updates** | Yes | No |
| **VM uniformity** | Required (all from same template) | Not required |
| **Multi-zone HA** | Yes (regional MIG) | No (single zone only) |
| **Load balancer backend** | Yes | Yes |
| **AWS analog** | Auto Scaling Group | No direct equivalent |
| **Use when** | All production workloads | Legacy/heterogeneous VMs |

**Rule of thumb:** always use MIG. UIG is a legacy escape hatch for VMs you can't recreate from a template.

---

## Logging and Serial Ports

Two separate but related debugging features available on every GCE instance.

### Logging Tab

The Logging tab on a VM instance page shows **Cloud Logging entries scoped to that VM** — a filtered view of:
- OS-level logs (syslog, kernel messages) — collected by the **Ops Agent**
- Startup script output
- Application logs (if Ops Agent is configured to tail them)

It's identical to querying Cloud Logging with:
```
resource.type="gce_instance"
resource.labels.instance_id="1234567890"
```

Useful for quick instance-specific log review without opening the full Logging console.

---

### Serial Ports — The Emergency Console

A serial port (COM port) is a **low-level hardware communication channel** that exists independently of the OS and network stack. Unlike SSH (which requires the OS, network, and sshd to be running), serial ports work:
- During BIOS/UEFI POST
- During kernel boot (before network is up)
- During kernel panics and OS crashes
- When the VM is completely unresponsive

```
Boot sequence and serial port visibility:
  BIOS/UEFI → GRUB → kernel → initramfs → systemd → sshd → your app
  ────────────────────────────────────────────────────
  Serial port captures EVERYTHING above this line
  SSH only works after sshd starts (far right)
```

Think of it as plugging a physical monitor into a server in a datacenter — the only way to see what's happening when nothing else works.

---

### Serial Port 1 (COM1) — Primary Boot Console

**The most important serial port.** This is read-only output from the VM and captures:
- GRUB bootloader messages
- Linux kernel boot messages (`dmesg` equivalent)
- `systemd` unit startup sequence
- OOM killer events (`Out of memory: Kill process...`)
- Kernel panics (with full stack trace)
- `cloud-init` and startup script output (on Debian/Ubuntu images)
- `fsck` filesystem checks blocking boot

```bash
# View serial port 1 output
gcloud compute instances get-serial-port-output my-vm \
  --zone=us-central1-a \
  --port=1

# Follow output (keep polling for new lines)
gcloud compute instances get-serial-port-output my-vm \
  --zone=us-central1-a \
  --port=1 \
  --start=0
```

Example output you'd see on port 1:
```
[    0.000000] Linux version 5.15.0-1030-gcp (x86_64)
[    0.000000] BIOS-provided physical RAM map
[    1.234567] EXT4-fs (sda1): mounted filesystem with ordered data mode
[    5.678901] systemd[1]: Starting OpenSSH Server Daemon...
[    6.123456] systemd[1]: Started OpenSSH Server Daemon.
              ← SSH now works, port 1 has everything before this
```

**Common debugging scenarios with port 1:**

| Symptom | What port 1 shows |
|---------|------------------|
| VM won't SSH | `sshd` failed to start, see systemd error |
| VM stuck booting | `fsck` running, or kernel module load failure |
| VM keeps restarting | OOM kill (`Out of memory: Kill process`) |
| Startup script not running | `cloud-init` errors, or script syntax error |
| Kernel panic | Full stack trace for root cause |

---

### Serial Port 2 (COM2) — Interactive Console

Port 2 is **interactive** — you can connect to it and get a login shell. This is your last-resort access method when SSH is completely broken.

```bash
# Step 1: enable interactive serial port access (disabled by default)
gcloud compute instances add-metadata my-vm \
  --metadata=serial-port-enable=TRUE \
  --zone=us-central1-a

# Step 2: connect
gcloud compute connect-to-serial-port my-vm \
  --zone=us-central1-a \
  --port=2
# You'll get a login prompt — enter OS username + password
# Press Enter a few times if you don't see the prompt
# Exit with: ~.  (tilde + dot)
```

You can also connect from the GCP Console: VM details → **Remote Access → Connect to serial console**.

**Use port 2 when:**
- `sshd` crashed or was misconfigured (`/etc/ssh/sshd_config` broken)
- SSH keys were accidentally wiped
- Network config is broken (can't reach the VM at all)
- Need to reset a password or fix `/etc/fstab`
- VM is up but SSH returns `Connection refused` or `Permission denied`

---

### Serial Ports 3 and 4 (COM3, COM4)

Available for custom use — rarely needed. Some specialized software uses these for debug output channels. Available via the same `gcloud compute connect-to-serial-port` command with `--port=3` or `--port=4`.

---

### Serial Port Summary

| Port | Type | What it's for |
|------|------|---------------|
| **Port 1** | Read-only output | Kernel boot, dmesg, systemd, OOM, kernel panic — **use this first when debugging** |
| **Port 2** | Interactive shell | Emergency login when SSH is broken |
| **Port 3** | Interactive | Custom application debug output |
| **Port 4** | Interactive | Custom use, rarely needed |

---

### Stream Serial Port Output to Cloud Logging

For production VMs, enable automatic streaming of serial port 1 output to Cloud Logging. This lets you set alerts on kernel panics or OOM events:

```bash
# Enable for a single VM
gcloud compute instances add-metadata my-vm \
  --metadata=serial-port-logging-enable=true \
  --zone=us-central1-a

# Enable project-wide (all VMs)
gcloud compute project-info add-metadata \
  --metadata=serial-port-logging-enable=true
```

Serial port output then appears in Cloud Logging:
```
resource.type = "gce_instance"
logName = "projects/PROJECT/logs/serialconsole.googleapis.com%2Fserial_port_1_output"
```

Set a log-based alert for production incidents:
```bash
# Alert on kernel panic
gcloud logging metrics create kernel-panic \
  --description="Kernel panic detected on GCE instance" \
  --log-filter='resource.type="gce_instance"
    logName="projects/PROJECT/logs/serialconsole.googleapis.com%2Fserial_port_1_output"
    textPayload:"Kernel panic"'
```

---

### SSH vs Serial Port — Decision Tree

```
VM is unresponsive / can't SSH
         │
         ▼
   Check Serial Port 1 output first
         │
         ├── Kernel panic / OOM → fix the root cause (memory, disk)
         ├── fsck running → wait or force-skip (risky)
         ├── systemd unit failed → fix unit config via port 2
         ├── sshd not started → connect via port 2, restart sshd
         └── Network config broken → connect via port 2, fix /etc/network
```
