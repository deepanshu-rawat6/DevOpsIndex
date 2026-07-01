# Kubernetes RBAC

---

## Auth Chain: Every Request to the API Server

```mermaid
graph LR
    classDef request fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef authn fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef authz fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef admission fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef ok fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef deny fill:#c0392b,stroke:#922b21,color:#fff,rx:8

    REQ["API Request kubectl get pods Pod calling K8s API"]:::request

    REQ --> AUTHN["Authentication Who are you? client cert, bearer token, OIDC (EKS IAM), ServiceAccount token"]:::authn
    AUTHN -->|"identity established"| AUTHZ["Authorization (RBAC) Are you allowed? check Role/ClusterRole bindings"]:::authz
    AUTHN -->|"unknown identity"| DENY1["401 Unauthorized"]:::deny

    AUTHZ -->|"allowed"| ADMISSION["Admission Controllers Mutate then Validate LimitRanger, PodSecurity, Webhooks"]:::admission
    AUTHZ -->|"no matching rule"| DENY2["403 Forbidden"]:::deny

    ADMISSION -->|"passes all webhooks"| PERSIST["Persist to etcd 200 OK"]:::ok
    ADMISSION -->|"webhook rejects"| DENY3["400/403 from webhook"]:::deny
```

---

## RBAC Building Blocks

```mermaid
graph TD
    classDef sa fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef role fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef binding fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef action fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef clusterscope fill:#1abc9c,stroke:#16a085,color:#fff,rx:8

    subgraph Identities["Who (Subject)"]
        SA["ServiceAccount my-app namespace: payments"]:::sa
        USER["User deepanshu (IAM/OIDC)"]:::sa
        GROUP["Group system:masters"]:::sa
    end

    subgraph Permissions["What (Rules)"]
        ROLE["Role namespace-scoped verbs: get,list,watch resources: pods,services"]:::role
        CR["ClusterRole cluster-scoped can reference any namespace or cluster resources like nodes"]:::clusterscope
    end

    subgraph Bindings["Link (Binding)"]
        RB["RoleBinding binds Role or ClusterRole to subjects in ONE namespace"]:::binding
        CRB["ClusterRoleBinding binds ClusterRole to subjects CLUSTER-WIDE"]:::binding
    end

    SA --> RB
    USER --> RB
    ROLE --> RB
    CR --> RB
    CR --> CRB
    SA --> CRB

    RB --> ACTION["Can get/list/watch pods in the payments namespace"]:::action
    CRB --> ACTION2["Can get/list/watch pods in ALL namespaces"]:::action
```

---

## ServiceAccount

A ServiceAccount is a Kubernetes identity for pods. Every pod runs as a ServiceAccount. If you don't specify one, it runs as the `default` ServiceAccount in its namespace.

```mermaid
graph TD
    classDef sa fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef secret fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef pod fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef api fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    SA["ServiceAccount: my-app namespace: payments"]:::sa
    TOKEN["Projected ServiceAccount Token /var/run/secrets/kubernetes.io/serviceaccount/token auto-mounted into pod expires every 1h (rotated by kubelet)"]:::secret
    POD["Pod: my-app uses ServiceAccount: my-app token auto-mounted"]:::pod
    API["K8s API Server validates token identity: system:serviceaccount:payments:my-app"]:::api

    SA --> TOKEN
    TOKEN --> POD
    POD -->|"Bearer token in API calls"| API
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: payments
  annotations:
    # IRSA: also allows pod to assume AWS IAM role
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789:role/my-app-s3-role
automountServiceAccountToken: true   # default — set false if pod doesn't call K8s API
```

---

## Role and ClusterRole

```yaml
# Role — namespaced (only works within payments namespace)
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: payments
rules:
  - apiGroups: [""]            # "" = core API group (pods, services, configmaps)
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]        # apps group (deployments, replicasets)
    resources: ["deployments"]
    verbs: ["get", "list"]
---
# ClusterRole — cluster-scoped (works across all namespaces or for cluster resources)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-reader
rules:
  - apiGroups: [""]
    resources: ["nodes"]       # nodes are cluster-scoped, need ClusterRole
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["nodes", "pods"]
    verbs: ["get", "list"]
```

**Verbs reference:**

| Verb | HTTP | Description |
|------|------|-------------|
| `get` | GET + name | Get a specific resource |
| `list` | GET (collection) | List resources |
| `watch` | GET + watch=true | Stream updates |
| `create` | POST | Create resource |
| `update` | PUT | Replace resource |
| `patch` | PATCH | Partial update |
| `delete` | DELETE | Delete resource |
| `deletecollection` | DELETE (collection) | Delete many |
| `*` | all | Wildcard — all verbs |

---

## RoleBinding and ClusterRoleBinding

```yaml
# RoleBinding: grant Role to ServiceAccount IN one namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-app-pod-reader
  namespace: payments
subjects:
  - kind: ServiceAccount
    name: my-app
    namespace: payments
  - kind: User             # also works for users
    name: deepanshu
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
---
# ClusterRoleBinding: grant ClusterRole across ALL namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: monitoring-cluster-reader
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: cluster-reader
  apiGroup: rbac.authorization.k8s.io
```

**Trick: ClusterRole + RoleBinding** — you can bind a ClusterRole via a RoleBinding to scope it to one namespace. Useful for reusable role definitions:

```yaml
# Define once as ClusterRole
kind: ClusterRole
metadata:
  name: app-role    # reusable template

---
# Bind in namespace A
kind: RoleBinding
metadata:
  namespace: payments    # scoped to payments only
roleRef:
  kind: ClusterRole
  name: app-role

---
# Bind in namespace B with same ClusterRole
kind: RoleBinding
metadata:
  namespace: orders      # scoped to orders only
roleRef:
  kind: ClusterRole
  name: app-role
```

---

## RBAC Patterns

```mermaid
graph TD
    classDef good fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef bad fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef sa fill:#3498db,stroke:#2980b9,color:#fff,rx:8

    subgraph Good["Good Patterns"]
        G1["Dedicated ServiceAccount per app not sharing default SA"]:::good
        G2["Narrow verbs: get,list,watch not wildcard *"]:::good
        G3["Namespace-scoped Role when possible not ClusterRole unless needed"]:::good
        G4["automountServiceAccountToken: false for pods that don't call K8s API"]:::good
    end

    subgraph Bad["Anti-Patterns"]
        B1["Using default ServiceAccount all apps in namespace share same identity"]:::bad
        B2["ClusterRoleBinding to system:masters grants cluster-admin to everyone"]:::bad
        B3["Wildcard resources: * wildcard verbs: * = full cluster access"]:::bad
    end
```

**Debug RBAC issues:**
```bash
# Check what a ServiceAccount can do
kubectl auth can-i get pods \
  --as=system:serviceaccount:payments:my-app \
  -n payments

# List all permissions for a ServiceAccount
kubectl auth can-i --list \
  --as=system:serviceaccount:payments:my-app \
  -n payments

# Describe a RoleBinding to see who has what
kubectl describe rolebinding my-app-pod-reader -n payments

# Check if a specific action is allowed
kubectl auth can-i create deployments --as=system:serviceaccount:payments:my-app -n payments
```


# Check if a specific action is allowed
kubectl auth can-i create deployments --as=system:serviceaccount:payments:my-app -n payments

# Who has cluster-admin? (critical audit check)
kubectl get clusterrolebindings -o json | \
  jq '.items[] | select(.roleRef.name=="cluster-admin") | {name: .metadata.name, subjects: .subjects}'
```

---

## RBAC — Advanced Patterns and EKS

### kubectl auth reconcile

`kubectl apply` on RBAC objects can produce conflicts if a ClusterRole already exists with different rules. `kubectl auth reconcile` is the safe way to apply RBAC — it adds missing rules without removing existing ones:

```bash
# Apply RBAC idempotently (safe for GitOps pipelines)
kubectl auth reconcile -f rbac-manifests/

# Dry-run first
kubectl auth reconcile -f rbac-manifests/ --dry-run=client
```

### Aggregated ClusterRoles

ClusterRoles can be composed from smaller roles using `aggregationRule`. Any ClusterRole with a matching label automatically has its rules merged in. Used by Kubernetes to build `view`, `edit`, `admin` roles from extension API groups:

```yaml
# Base aggregated role — collects rules from labeled sub-roles
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: custom-platform-role
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-platform: "true"
rules: []  # auto-populated from matching ClusterRoles

---
# Sub-role that gets merged in automatically
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-secrets-reader
  labels:
    rbac.example.com/aggregate-to-platform: "true"  # triggers aggregation
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list"]
```

### Token projection and bound service account tokens

Modern K8s (1.21+) uses **projected tokens** — short-lived (1h default), audience-bound, and tied to a specific pod. They replace the old static Secrets-based tokens.

```yaml
# Explicitly configure projected token (usually auto-injected, but here for clarity)
spec:
  volumes:
    - name: token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600      # 1 hour
              audience: "https://kubernetes.default.svc"
  containers:
    - name: app
      volumeMounts:
        - name: token
          mountPath: /var/run/secrets/kubernetes.io/serviceaccount
```

```bash
# Decode the token to inspect claims
kubectl exec <pod> -- cat /var/run/secrets/kubernetes.io/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | jq .
# {
#   "aud": ["https://kubernetes.default.svc"],
#   "exp": 1700000000,
#   "iat": 1699996400,
#   "iss": "https://kubernetes.default.svc",
#   "kubernetes.io": {
#     "namespace": "payments",
#     "pod": { "name": "my-app-xxx", "uid": "..." },
#     "serviceaccount": { "name": "my-app", "uid": "..." }
#   },
#   "sub": "system:serviceaccount:payments:my-app"
# }
```

### EKS — aws-auth ConfigMap (legacy) vs Access Entries (current)

EKS authenticates using IAM. The mapping from IAM identity → Kubernetes username/groups is configured two ways:

**aws-auth ConfigMap (EKS < 1.30, legacy):**
```yaml
# kubectl edit configmap aws-auth -n kube-system
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-auth
  namespace: kube-system
data:
  mapRoles: |
    # Worker node IAM role → system:nodes group (required for nodes to join)
    - rolearn: arn:aws:iam::123456789:role/eks-node-role
      username: system:node:{{EC2PrivateDNSName}}
      groups:
        - system:bootstrappers
        - system:nodes
    # Human IAM role → Kubernetes RBAC group
    - rolearn: arn:aws:iam::123456789:role/devops-team
      username: devops-{{SessionName}}
      groups:
        - platform-admins   # bind this group to a ClusterRole in RBAC
  mapUsers: |
    # Specific IAM user (avoid when possible — use roles)
    - userarn: arn:aws:iam::123456789:user/alice
      username: alice
      groups:
        - developers
```

**Access Entries (EKS 1.30+, recommended):**
```bash
# Create an access entry (replaces aws-auth ConfigMap rows)
aws eks create-access-entry \
  --cluster-name my-cluster \
  --principal-arn arn:aws:iam::123456789:role/devops-team \
  --type STANDARD \
  --kubernetes-groups platform-admins

# Associate with an access policy (AWS-managed or custom)
aws eks associate-access-policy \
  --cluster-name my-cluster \
  --principal-arn arn:aws:iam::123456789:role/devops-team \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope '{"type": "cluster"}'

# List all access entries
aws eks list-access-entries --cluster-name my-cluster
```

Access Entries survive `aws-auth` ConfigMap corruption (a common incident that locks everyone out of the cluster).

### IRSA — IAM Roles for Service Accounts

IRSA lets a Kubernetes ServiceAccount assume an AWS IAM role without static credentials. The pod gets a projected token, exchanges it at the STS OIDC endpoint, and receives temporary AWS credentials.

```bash
# 1. Create OIDC provider for your EKS cluster (one-time per cluster)
eksctl utils associate-iam-oidc-provider \
  --cluster my-cluster --approve

# 2. Create IAM role with trust policy scoped to specific ServiceAccount
OIDC_ID=$(aws eks describe-cluster --name my-cluster \
  --query "cluster.identity.oidc.issuer" --output text | cut -d/ -f5)

aws iam create-role \
  --role-name my-app-s3-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Federated": "arn:aws:iam::123456789:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/'"$OIDC_ID"'"},
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/'"$OIDC_ID"':aud": "sts.amazonaws.com",
          "oidc.eks.us-east-1.amazonaws.com/id/'"$OIDC_ID"':sub": "system:serviceaccount:payments:my-app"
        }
      }
    }]
  }'
```

```yaml
# 3. Annotate the ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: payments
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789:role/my-app-s3-role
    eks.amazonaws.com/token-expiration: "3600"  # optional: shorter token lifetime
```

```bash
# 4. Verify — pod should have these env vars injected by the EKS pod identity webhook:
kubectl exec <pod> -- env | grep AWS
# AWS_ROLE_ARN=arn:aws:iam::123456789:role/my-app-s3-role
# AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token
# AWS_DEFAULT_REGION=us-east-1

# If missing: check the pod admission mutation webhook is running
kubectl get mutatingwebhookconfigurations | grep pod-identity
```

### Common RBAC misconfigurations

| Misconfiguration | Risk | Detection |
|---|---|---|
| `default` SA used for all pods | Blast radius: any compromised pod has the same identity | `kubectl get rolebindings,clusterrolebindings -A -o json \| jq '.items[].subjects[] \| select(.name=="default")'` |
| `cluster-admin` for CI/CD SA | CI pipeline compromise = full cluster takeover | `kubectl get clusterrolebindings -o json \| jq ... \| select(.roleRef.name=="cluster-admin")'` |
| `automountServiceAccountToken: true` on non-API pods | Token in every pod, even ones that don't need K8s API | Set `false` on Deployment spec, override on SA |
| Wildcard verb+resource | `verbs: ["*"] resources: ["*"]` = cluster-admin equivalent | Audit: `kubectl get roles,clusterroles -A -o yaml \| grep '"*"'` |
| RoleBinding to system:authenticated | Every authenticated user (including service accounts) gets the role | Audit ClusterRoleBindings for system:authenticated subject |
| Stale bindings after team changes | Former employees' IAM roles still mapped in aws-auth | Review `aws-auth` ConfigMap quarterly |

### RBAC audit one-liners

```bash
# Find all cluster-admin bindings
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] | select(.roleRef.name=="cluster-admin") |
  "\(.metadata.name): \(.subjects // [] | map(.name) | join(", "))"'

# Find all ServiceAccounts with cluster-wide permissions
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] | .subjects[]? | select(.kind=="ServiceAccount") |
  "\(.namespace)/\(.name)"' | sort -u

# What can a given ServiceAccount do across all namespaces?
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  kubectl auth can-i --list \
    --as=system:serviceaccount:payments:my-app \
    -n $ns 2>/dev/null | grep -v "^Resources" | grep -v "^\*"
done
```
