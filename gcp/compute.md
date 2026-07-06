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
| Free control plane | GKE Standard: free | EKS: $73/mo |
