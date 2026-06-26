# GitOps Secrets Management

Kubernetes Secrets must not be committed to git in plaintext. Two production-grade approaches: Sealed Secrets (encrypt-in-git) and External Secrets Operator (reference-in-git).

---

## The Problem

```mermaid
flowchart LR
    BAD["kubectl create secret generic db-pass<br>--from-literal=password=s3cr3t<br>--> base64 in git = plaintext"]:::warn
    GOOD1["Sealed Secrets<br>Encrypt with cluster key<br>commit ciphertext to git"]
    GOOD2["External Secrets Operator<br>Store secret in AWS SM/Vault<br>git holds only a reference"]
    BAD -->|"never"| GOOD1
    BAD -->|"never"| GOOD2

    classDef warn fill:#e74c3c,stroke:#c0392b,color:#fff
```

**Base64 is NOT encryption.** A K8s Secret in git is fully readable by anyone with repo access.

---

## Sealed Secrets

### How it works

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant kubeseal as kubeseal CLI
    participant Ctrl as SealedSecrets Controller (in cluster)
    participant K8s as Kubernetes API

    Dev->>kubeseal: kubeseal --raw < secret.yaml
    kubeseal->>Ctrl: Fetch cluster public key
    Ctrl-->>kubeseal: RSA public key
    kubeseal->>kubeseal: Encrypt with public key
    kubeseal-->>Dev: SealedSecret YAML (safe to commit)
    Dev->>K8s: git commit + ArgoCD syncs SealedSecret
    K8s->>Ctrl: SealedSecret created
    Ctrl->>Ctrl: Decrypt with private key (only in cluster)
    Ctrl->>K8s: Create real Kubernetes Secret
```

**Key properties:**
- Ciphertext is **cluster-specific** — a secret sealed for cluster A cannot be decrypted by cluster B
- Private key lives only in the cluster (`sealed-secrets-key` Secret in `kube-system`)
- Safe to commit the `SealedSecret` YAML to any git repo, including public repos

### Install

```bash
# Install controller via Helm
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system

# Install kubeseal CLI (macOS)
brew install kubeseal
```

### Sealing a secret

```bash
# 1. Create a plain secret YAML (do NOT apply this to cluster)
kubectl create secret generic db-credentials \
  --from-literal=password=s3cr3t \
  --from-literal=username=appuser \
  --dry-run=client -o yaml > secret.yaml

# 2. Seal it (fetches public key from cluster automatically)
kubeseal --format yaml < secret.yaml > sealed-secret.yaml

# 3. Commit sealed-secret.yaml to git — safe!
# ArgoCD syncs it, controller decrypts it into a real Secret

# Seal for a specific namespace (secret is namespace-scoped by default)
kubeseal --namespace production --format yaml < secret.yaml > sealed-secret.yaml
```

### SealedSecret output

```yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  encryptedData:
    password: AgBk3n...  # encrypted, safe to commit
    username: AgCm2p...
  template:
    metadata:
      name: db-credentials
      namespace: production
```

### Key rotation

```bash
# The controller generates a new key every 30 days automatically
# Old keys are retained for decryption of existing secrets

# Manually rotate (emergency — after key compromise)
kubectl -n kube-system delete secret sealed-secrets-key
kubectl -n kube-system rollout restart deployment/sealed-secrets-controller
# All existing SealedSecrets must be re-sealed with the new key!

# Backup the private key (store in a vault, not in git)
kubectl -n kube-system get secret sealed-secrets-key -o yaml > sealed-secrets-key-backup.yaml
```

### Limitations
- If the controller's private key is lost, all sealed secrets are unrecoverable
- Rotating the key requires re-sealing all secrets
- Secret values are static — rotation requires a new seal and commit

---

## External Secrets Operator (ESO)

### How it works

```mermaid
flowchart TD
    SM["AWS Secrets Manager<br>(or Vault, SSM, GCP SM)"] -->|"ESO syncs"| K8S_SECRET["Kubernetes Secret<br>(auto-created, kept in sync)"]
    GIT["Git: ExternalSecret CRD<br>(only a reference — no value)"] -->|"ArgoCD applies"| ES_CRD["ExternalSecret object in cluster"]
    ES_CRD -->|"ESO controller reads"| SM
    K8S_SECRET -->|"mounted as env/volume"| POD["Pod"]
```

**Key difference from Sealed Secrets:** the actual secret value never touches git. Git contains only `ExternalSecret` — a pointer to where the secret lives.

### Install

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace
```

### EKS + IRSA pattern (recommended for AWS)

ESO needs permission to read from AWS Secrets Manager. Use IRSA — no static credentials.

```bash
# 1. Create IAM policy for ESO
cat > eso-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
    "Resource": "arn:aws:secretsmanager:us-east-1:123456789:secret:my-app/*"
  }]
}
EOF
aws iam create-policy --policy-name ESO-SecretsManager --policy-document file://eso-policy.json

# 2. Create IAM role with trust policy for ESO service account
eksctl create iamserviceaccount \
  --name external-secrets \
  --namespace external-secrets \
  --cluster my-cluster \
  --attach-policy-arn arn:aws:iam::123456789:policy/ESO-SecretsManager \
  --approve
```

### SecretStore (cluster-scoped)

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets          # the IRSA service account
            namespace: external-secrets
```

### ExternalSecret (commit this to git)

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  refreshInterval: 1h                        # re-sync from AWS SM every hour
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: db-credentials                     # name of the K8s Secret to create
    creationPolicy: Owner                    # ESO owns the secret lifecycle
  data:
    - secretKey: password                    # key in K8s Secret
      remoteRef:
        key: my-app/production/db            # path in AWS Secrets Manager
        property: password                   # JSON key within the secret
    - secretKey: username
      remoteRef:
        key: my-app/production/db
        property: username
```

### Secret rotation (ESO advantage)

```bash
# Update secret in AWS Secrets Manager
aws secretsmanager update-secret \
  --secret-id my-app/production/db \
  --secret-string '{"username":"appuser","password":"n3w_p4ss"}'

# ESO syncs automatically within refreshInterval (default 1h)
# Force immediate refresh:
kubectl annotate externalsecret db-credentials -n production \
  force-sync=$(date +%s) --overwrite
```

---

## Comparison

| | Sealed Secrets | External Secrets Operator |
|--|---------------|--------------------------|
| Secret storage | Encrypted in git | External store (AWS SM, Vault, SSM) |
| Git content | Ciphertext (SealedSecret YAML) | Reference only (ExternalSecret YAML) |
| Rotation | Requires re-seal + git commit | Automatic (ESO re-syncs) |
| Multi-cluster | Each cluster needs its own seal | One ESO + SecretStore per cluster, same SM |
| Key loss risk | Unrecoverable if private key lost | No key — secrets always in SM |
| AWS native | No | Yes (IRSA, SM versioning, rotation) |
| Audit trail | Git history | AWS CloudTrail + SM version history |
| Best for | Simple setups, no external vault | Production EKS, secret rotation needed |

---

## Decision

```
New EKS cluster on AWS?
  → ESO + AWS Secrets Manager + IRSA
  → Secrets rotate without git commits
  → CloudTrail audits every secret access
  → IRSA = no static credentials in cluster

Air-gapped / no cloud secret store?
  → Sealed Secrets
  → Backup the private key offline
  → Re-seal on key rotation
```
