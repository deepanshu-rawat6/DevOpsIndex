# Kubernetes Storage

---

## PV / PVC / StorageClass — The Three-Layer Model

```mermaid
graph TD
    classDef sc fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef pv fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef pvc fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef pod fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef disk fill:#34495e,stroke:#2c3e50,color:#fff,rx:8

    SC["StorageClass: gp3-encrypted provisioner: ebs.csi.aws.com parameters: type=gp3, encrypted=true reclaimPolicy: Delete volumeBindingMode: WaitForFirstConsumer"]:::sc

    PV["PersistentVolume: pv-ebs-abc123 50Gi, ReadWriteOnce status: Bound claimRef: postgres/postgres-data-pvc"]:::pv

    PVC["PersistentVolumeClaim: postgres-data-pvc requests: 50Gi, ReadWriteOnce storageClassName: gp3-encrypted status: Bound --> pv-ebs-abc123"]:::pvc

    POD["Pod: postgres-0 volumeMounts:   - name: data     mountPath: /var/lib/postgresql/data"]:::pod

    DISK["EBS Volume: vol-0abc123 us-east-1b 50 GiB gp3"]:::disk

    SC -->|"dynamic provisioning: creates PV + EBS volume automatically"| PV
    PV <-->|"bound"| PVC
    PVC --> POD
    PV --> DISK
```

**The three layers:**
- **StorageClass** — describes the type of storage (provisioner, disk type, encryption, reclaim policy). Created once by an admin, used by many PVCs.
- **PersistentVolume (PV)** — represents an actual piece of storage. Can be pre-provisioned by admin or dynamically created by the CSI driver when a PVC is created.
- **PersistentVolumeClaim (PVC)** — a pod's request for storage. Declares size and access mode. Kubernetes binds it to a matching PV.

---

## Dynamic Provisioning Flow

```mermaid
sequenceDiagram
    participant USER as Developer
    participant API as API Server
    participant CTRL as PV Controller
    participant CSI as EBS CSI Driver
    participant AWS as AWS EBS API

    USER->>API: Create PVC (50Gi, gp3-encrypted)
    API->>CTRL: Watch: new PVC with storageClass=gp3-encrypted
    CTRL->>CSI: CreateVolume(50Gi, gp3, encrypted, us-east-1b)
    CSI->>AWS: ec2:CreateVolume
    AWS-->>CSI: vol-0abc123 created
    CSI-->>CTRL: Volume ready
    CTRL->>API: Create PV bound to this PVC
    API-->>USER: PVC status: Bound

    Note over USER: Pod using the PVC is scheduled
    CTRL->>CSI: ControllerPublishVolume (attach to node i-xyz)
    CSI->>AWS: ec2:AttachVolume(vol-0abc123, i-xyz)
    AWS-->>CSI: Attached at /dev/xvdba
    CSI->>CSI: NodeStageVolume (format + mount to staging path)
    CSI->>CSI: NodePublishVolume (bind-mount into pod path)
```

**volumeBindingMode: WaitForFirstConsumer** — PV/EBS not provisioned until a pod using the PVC is scheduled. Prevents EBS volumes in the wrong AZ. Always use this for EBS.

---

## Access Modes

```mermaid
graph LR
    classDef rwo fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef rwx fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef rox fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef rwop fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    RWO["ReadWriteOnce (RWO) One node can read+write EBS, local disk Most common for databases"]:::rwo

    ROX["ReadOnlyMany (ROX) Many nodes can read EFS, NFS with read-only data Config files, assets"]:::rox

    RWX["ReadWriteMany (RWX) Many nodes can read+write EFS, NFS, CephFS Shared workspace, logs"]:::rwx

    RWOP["ReadWriteOncePod (RWOP) One POD can read+write (K8s 1.22+) Stronger than RWO Guarantees single-writer"]:::rwop
```

| Access Mode | Storage backends | Use case |
|-------------|-----------------|----------|
| `ReadWriteOnce` | EBS, local disk | Single-pod databases (Postgres, MySQL) |
| `ReadOnlyMany` | EFS, NFS, S3 (via CSI) | Shared config, ML model serving |
| `ReadWriteMany` | EFS, NFS, CephFS, Portworx | Shared workspaces, legacy apps |
| `ReadWriteOncePod` | EBS, CSI drivers | Strict single-writer guarantee |

---

## Reclaim Policies

What happens to the PV (and underlying disk) when the PVC is deleted:

```mermaid
graph TD
    classDef delete fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef retain fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef recycle fill:#f39c12,stroke:#d68910,color:#000,rx:8

    PVC_DEL["PVC deleted"] --> RP{ReclaimPolicy}

    RP -->|"Delete (default for dynamic)"| DEL["PV deleted EBS volume deleted Data gone permanently"]:::delete

    RP -->|"Retain"| RET["PV status: Released EBS volume kept Admin must manually reclaim or delete Data preserved"]:::retain

    RP -->|"Recycle (deprecated)"| REC["PV scrubbed (rm -rf /) Made Available for new PVC"]:::recycle
```

**Production rule:** Use `Retain` for databases in production. Use `Delete` for ephemeral/dev workloads. Never lose data accidentally.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-retain
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Retain             # keep EBS volume after PVC deletion
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true        # allow resize without recreating
```

---

## CSI (Container Storage Interface)

CSI is the standard interface between Kubernetes and storage vendors. Any storage system (EBS, EFS, Ceph, NetApp, etc.) can implement the CSI spec to work with Kubernetes.

```mermaid
graph TD
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef csi fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef storage fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    subgraph K8s["Kubernetes"]
        KUBELET["kubelet calls CSI Node Service"]:::k8s
        CTRL_MGR["External Provisioner calls CSI Controller Service"]:::k8s
    end

    subgraph CSIDriver["CSI Driver (e.g. aws-ebs-csi-driver)"]
        CTRL_SVC["Controller Service CreateVolume, DeleteVolume AttachVolume, DetachVolume CreateSnapshot"]:::csi
        NODE_SVC["Node Service NodeStageVolume (format+mount to staging) NodePublishVolume (bind-mount to pod path) NodeUnpublishVolume"]:::csi
    end

    subgraph StorageBackend["Storage Backend"]
        EBS["AWS EBS"]:::storage
        EFS["AWS EFS"]:::storage
        S3["S3 (Mountpoint CSI)"]:::storage
    end

    CTRL_MGR --> CTRL_SVC
    KUBELET --> NODE_SVC
    CTRL_SVC --> EBS & EFS & S3
    NODE_SVC --> EBS & EFS
```

**Why CSI replaced in-tree drivers:** Before CSI, storage drivers were compiled into the Kubernetes binary. Updating a storage driver required a Kubernetes upgrade. CSI drivers are out-of-tree — deployed as pods, updated independently.

**Required CSI drivers in EKS (as add-ons):**
- `aws-ebs-csi-driver` — PVCs backed by EBS (gp3, io2). Required since K8s 1.23 (in-tree deprecated).
- `aws-efs-csi-driver` — PVCs backed by EFS (ReadWriteMany across AZs).
- `mountpoint-s3-csi-driver` — mount S3 buckets as a filesystem (read-heavy workloads, ML data).

---

## Volume Snapshots

```yaml
# Create a snapshot of a PVC
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-snapshot-2026-01-15
spec:
  volumeSnapshotClassName: csi-aws-vsc
  source:
    persistentVolumeClaimName: postgres-data-pvc

---
# Restore from snapshot into a new PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
spec:
  dataSource:
    name: postgres-snapshot-2026-01-15
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Gi
  storageClassName: gp3-retain
```

Use snapshots for: pre-upgrade database backups, cloning production data to staging, disaster recovery checkpoints.

---

## ConfigMap vs Secret

```mermaid
graph LR
    CM["ConfigMap<br>non-sensitive config<br>app.properties, nginx.conf<br>feature flags, URLs<br>stored in etcd as plaintext"] --> POD
    SEC["Secret<br>sensitive data<br>passwords, tokens, TLS certs<br>stored in etcd base64-encoded<br>(NOT encrypted by default)"] --> POD["Pod"]

    POD -->|"mount as volume"| VOL["File in container<br>/etc/config/app.properties"]
    POD -->|"inject as env var"| ENV["ENV DB_PASS=s3cr3t"]
```

**Key differences:**

| | ConfigMap | Secret |
|--|-----------|--------|
| Data type | Non-sensitive | Sensitive (passwords, tokens, certs) |
| etcd storage | Plaintext | Base64-encoded (NOT encrypted without extra config) |
| K8s RBAC | `get configmaps` | `get secrets` (separate permission) |
| Mounted as | File or env var | File, env var, or imagePullSecret |
| Max size | 1MB | 1MB |

**Base64 ≠ encryption.** A Secret's value is base64-encoded in etcd — anyone with `kubectl get secret -o yaml` can decode it immediately. Real protection requires **encryption at rest**.

### Encryption at Rest

```yaml
# /etc/kubernetes/encryption-config.yaml (on control plane)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources: ["secrets"]
  providers:
  - aescbc:                          # AES-CBC encryption
      keys:
      - name: key1
        secret: <base64-encoded-32-byte-key>   # generated: head -c 32 /dev/urandom | base64
  - identity: {}                     # fallback: unencrypted (for existing secrets)
```

```bash
# Enable on kube-apiserver
--encryption-provider-config=/etc/kubernetes/encryption-config.yaml

# Encrypt all existing secrets (re-writes them with the new provider)
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

# Verify a secret is encrypted in etcd
ETCDCTL_API=3 etcdctl get /registry/secrets/default/my-secret | hexdump -C | head
# If encrypted: shows random bytes, not recognizable base64
# If not encrypted: shows "k8s:enc:aescbc:v1:key1:" prefix if encrypted
```

**EKS/GKE managed encryption:**
```bash
# EKS: enable envelope encryption with KMS
aws eks create-cluster --name my-cluster \
  --encryption-config '[{"provider":{"keyArn":"arn:aws:kms:..."},"resources":["secrets"]}]'

# GKE: application-layer encryption (CMEK)
gcloud container clusters create my-cluster \
  --database-encryption-key projects/PROJECT/locations/REGION/keyRings/RING/cryptoKeys/KEY
```

### Using Secrets Safely

```yaml
# Mount as file (preferred for large secrets, certificates)
spec:
  volumes:
  - name: tls-cert
    secret:
      secretName: my-tls-secret
  containers:
  - volumeMounts:
    - name: tls-cert
      mountPath: /etc/ssl/certs
      readOnly: true

# Env var (avoid for multi-line secrets, visible in process list)
env:
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: db-secret
      key: password

# Never: hardcode in container spec or ConfigMap
# Never: commit Secret YAML with real values to git
# Better: use External Secrets Operator (ESO) → pull from AWS SM/Vault at runtime
```
