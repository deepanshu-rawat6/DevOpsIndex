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
