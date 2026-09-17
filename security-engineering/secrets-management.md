# Secrets Management: Vault, External Secrets, and GitOps-Safe Patterns

A secret is any value that grants access to a resource: database passwords, API keys, TLS private keys, OAuth client secrets. The most common secrets management mistake is storing these in environment variables or Kubernetes Secrets without additional protection — both of which leak secrets through ordinary operational commands.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Why Environment Variables and K8s Secrets Are Not Enough

**Environment variables** feel safe but are exposed in multiple ways:
- `ps auxe` on the host shows environment variables for every process (on Linux, readable by root)
- `docker inspect <container>` returns the full env block including secrets — accessible to anyone with Docker socket access
- Application crashes often dump environment variables in error messages or stack traces
- Third-party libraries (APM agents, crash reporters) may capture and send environment variables to external services
- `kubectl describe pod` shows env vars that were set from literal values (not from secrets)

**Kubernetes Secrets** are base64-encoded, not encrypted. By default:
- Secrets are stored in etcd as plain base64 — anyone with etcd access or an etcd backup can read every secret
- Any pod in the same namespace can read a Secret if it has `get` or `list` RBAC permissions
- `kubectl get secret mysecret -o yaml` returns the base64 value; `base64 -d` decodes it in one step
- Secrets can be enabled for etcd encryption at rest (`EncryptionConfiguration`), but this is not on by default in most managed Kubernetes distributions

**Git history** is permanent. A secret committed and then deleted is still in `git log --all -p`. GitHub's secret scanning catches known patterns (AWS keys, GitHub tokens) on push, but custom secrets are not detected.

---

## 2. HashiCorp Vault

Vault is the industry standard for secrets management. It provides:
- **Dynamic secrets**: generate short-lived database credentials on demand (no shared long-lived password)
- **Lease management**: secrets expire automatically; Vault revokes them
- **Audit log**: every secret access is logged with the caller's identity
- **Fine-grained policies**: a service can only read the secrets it needs, nothing else

### Kubernetes Auth Method

The most common Vault authentication pattern in Kubernetes: pods authenticate to Vault using their ServiceAccount JWT token. Vault verifies the JWT against the Kubernetes API, and if valid, issues a Vault token scoped to a policy.

```bash
# Enable the Kubernetes auth method
vault auth enable kubernetes

# Configure with the cluster's API server and CA cert
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

# Create a role binding a Kubernetes ServiceAccount to a Vault policy
vault write auth/kubernetes/role/payments-api \
  bound_service_account_names=payments-api \
  bound_service_account_namespaces=payments \
  policies=payments-policy \
  ttl=1h
```

### Dynamic Database Secrets

```bash
# Enable the database secrets engine
vault secrets enable database

# Configure a PostgreSQL connection
vault write database/config/payments-db \
  plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@postgres:5432/payments" \
  allowed_roles="payments-api" \
  username="vault-admin" \
  password="vault-admin-password"

# Create a role that generates time-limited credentials
vault write database/roles/payments-api \
  db_name=payments-db \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="15m" \
  max_ttl="1h"
```

When the payments-api pod needs a database credential, it calls Vault's API, receives a unique username/password valid for 15 minutes, and connects to Postgres. When the lease expires, Vault drops the role from Postgres. No long-lived shared password ever exists.

### Vault Policy HCL

```hcl
# payments-policy.hcl
path "database/creds/payments-api" {
  capabilities = ["read"]
}

path "secret/data/payments/*" {
  capabilities = ["read"]
}

# Explicitly deny everything else
path "*" {
  capabilities = ["deny"]
}
```

<div class="quiz-card">
  <p class="quiz-q">A developer rotates the Postgres root password (the one Vault uses as `vault-admin`) without telling the platform team. Vault's database connection breaks. What is the blast radius of this failure, and how does dynamic secrets make recovery faster than static secrets?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Blast radius: Vault can no longer generate new database credentials for any role configured on that database connection. Existing credentials (already issued leases) continue to work until they expire (up to 1 hour). New pod startups that need credentials will fail — they cannot authenticate to the database. Recovery with dynamic secrets is faster than static secrets because: (1) there is only one place to update (the Vault database config for that connection), not every service's secret store; (2) once the Vault connection is fixed, all services automatically get fresh valid credentials on their next renewal cycle; (3) because credentials have 15-minute TTLs, within 15 minutes all services have rotated to credentials created through the fixed connection. With static secrets, you'd need to update every service's database password manually, restart all affected deployments, and verify each one — a process that takes hours in a large environment. Prevention: use a dedicated Vault admin role in Postgres (least-privilege), document it clearly, and alert on Vault connection errors before they cause service failures.</div>
</div>

---

## 3. External Secrets Operator

ESO is a Kubernetes operator that syncs secrets from external providers (Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, 1Password) into native Kubernetes Secrets. Applications don't need Vault SDKs — they just read the Kubernetes Secret that ESO maintains.

```mermaid
sequenceDiagram
    participant ESO as External Secrets Operator
    participant Vault as HashiCorp Vault
    participant K8s as Kubernetes API
    participant Pod as Application Pod

    ESO->>Vault: auth (ServiceAccount JWT)
    Vault->>ESO: Vault token
    ESO->>Vault: GET secret/data/payments/db-password
    Vault->>ESO: {"password": "s3cr3t", "lease": "1h"}
    ESO->>K8s: create/update Secret "payments-db-secret"
    Pod->>K8s: mount Secret as volume or env
    K8s->>Pod: secret value
    note over ESO: refreshInterval: 1h — ESO re-syncs
```

**SecretStore** (namespaced or ClusterSecretStore for cluster-wide):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: payments
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "payments-api"
          serviceAccountRef:
            name: payments-api
```

**ExternalSecret** (what to sync):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-db-secret
  namespace: payments
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: payments-db-credentials   # creates this K8s Secret
    creationPolicy: Owner
  data:
    - secretKey: password           # key in the K8s Secret
      remoteRef:
        key: payments/db-password   # Vault path
        property: password          # JSON field within the secret
```

<div class="quiz-card">
  <p class="quiz-q">ESO has a `refreshInterval: 1h` on an ExternalSecret. Vault issues a database credential with a `default_ttl: 15m`. What happens after 15 minutes — does ESO update the Kubernetes Secret before the credential expires?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — ESO only syncs according to its `refreshInterval`, which is 1 hour. After 15 minutes, the Vault credential expires, but ESO hasn't re-synced yet. The Kubernetes Secret still holds the expired credential. Applications reading from the Secret will fail to authenticate to the database. The fix: set ESO's `refreshInterval` to less than Vault's `default_ttl`. A safe rule is to refresh at `default_ttl × 0.75` — if the TTL is 15 minutes, set `refreshInterval: 10m`. This ensures ESO always renews the credential before it expires, with a 5-minute buffer for sync delays. Alternatively, use Vault Agent Injector instead of ESO for dynamic database credentials — Vault Agent handles lease renewal automatically and injects the credential directly into the pod without going through a Kubernetes Secret.</div>
</div>

---

## 4. Sealed Secrets

Sealed Secrets (Bitnami) solves a specific GitOps problem: how do you commit a secret to a Git repository without exposing the secret value? The answer is asymmetric encryption using a cluster-managed private key.

**How it works:**
1. The Sealed Secrets controller generates a public/private key pair on install and stores the private key in a Kubernetes Secret (cluster-admin only).
2. You use `kubeseal` (which talks to the controller) to encrypt your secret with the cluster's public key.
3. The encrypted `SealedSecret` CR is committed to Git — it is safe to commit because only the cluster's private key can decrypt it.
4. The controller watches for `SealedSecret` objects, decrypts them, and creates the corresponding `Secret`.

```bash
# Encrypt a secret using the cluster's public key
kubectl create secret generic payments-api-key \
  --from-literal=api-key=supersecret --dry-run=client -o yaml \
  | kubeseal --format yaml > sealed-payments-api-key.yaml

# Commit sealed-payments-api-key.yaml to Git — safe
git add sealed-payments-api-key.yaml && git commit -m "add sealed secret"
```

**Key rotation:** The Sealed Secrets controller can be configured to automatically rotate the encryption key. Old seals continue to work until re-sealed with the new key. Critical: back up the private key to an external store (Vault, AWS KMS) — if the cluster is destroyed and the private key is lost, all sealed secrets become undecryptable.

---

## 5. SOPS: GitOps-Friendly Secret Encryption

SOPS (Secrets OPerationS, Mozilla) encrypts YAML and JSON files at the value level — keys remain visible, only values are encrypted. This makes diffs readable in Git and allows partial encryption (public config + encrypted secrets in the same file).

```yaml
# .sops.yaml — project-level encryption config
creation_rules:
  - path_regex: secrets/.*\.yaml$
    age: age1abc123...    # public key of the age recipient
    # Or use AWS KMS: kms: arn:aws:kms:us-east-1:123456789:key/...
```

```bash
# Encrypt in place
sops --encrypt --in-place secrets/payments.yaml

# Decrypt for editing
sops secrets/payments.yaml   # opens in $EDITOR, saves encrypted

# Use in CI (with age private key in an env var)
SOPS_AGE_KEY=$AGE_PRIVATE_KEY sops --decrypt secrets/payments.yaml | kubectl apply -f -
```

**Encrypted file in Git:**

```yaml
# secrets/payments.yaml (committed to Git — values are ciphertext)
database_password: ENC[AES256_GCM,data:abc123...,iv:xyz...,tag:...,type:str]
api_key: ENC[AES256_GCM,data:def456...,iv:uvw...,tag:...,type:str]
sops:
  kms: []
  age:
    - recipient: age1abc123...
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        ...
```

<div class="tab-group">
  <div class="tab-buttons">
    <button class="tab-btn active" data-tab="sealed">Sealed Secrets</button>
    <button class="tab-btn" data-tab="eso">External Secrets Operator</button>
    <button class="tab-btn" data-tab="sops">SOPS</button>
  </div>
  <div class="tab-panel active" data-tab-panel="sealed">

**Sealed Secrets** — cluster-native encryption for GitOps.

- Secrets live in Git (encrypted), synced to Kubernetes automatically
- No external dependency at runtime — the controller is self-contained
- Key tied to the cluster — sealed secrets cannot be decrypted outside the cluster that sealed them
- **Best for**: teams that want all configuration (including secrets) in Git with no external secrets backend
- **Risk**: cluster key loss = all secrets lost. Back up the controller key.

  </div>
  <div class="tab-panel" data-tab-panel="eso">

**External Secrets Operator** — sync from an external truth source.

- Secrets live in Vault, AWS SSM, GCP Secret Manager — ESO syncs to Kubernetes
- Supports dynamic secrets (Vault DB credentials with TTLs)
- Centralized secrets management across multiple clusters
- **Best for**: organizations already using Vault or a cloud secrets manager; multi-cluster deployments
- **Risk**: ESO is an additional dependency; if it crashes or can't reach Vault, secrets don't refresh

  </div>
  <div class="tab-panel" data-tab-panel="sops">

**SOPS** — file-level encryption, not Kubernetes-specific.

- Encrypts any YAML/JSON, not just Kubernetes secrets — can manage Helm values, Terraform variables, application config
- Works with age (simple), AWS KMS, GCP KMS, Azure Key Vault, PGP
- Git-friendly: encrypted values in plain text files, diffs show key changes
- **Best for**: teams using Flux or ArgoCD with encrypted secrets in the GitOps repo; multi-tool environments where Kubernetes is one of several targets
- **Risk**: requires discipline — easy to accidentally commit an unencrypted file if the `.sops.yaml` regex doesn't cover all paths

  </div>
</div>
