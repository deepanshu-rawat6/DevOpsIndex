# ArgoCD

ArgoCD is a declarative GitOps continuous delivery tool for Kubernetes. Git is the single source of truth; ArgoCD continuously syncs the cluster to match it.

---

## GitOps Model

```mermaid
graph LR
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    DEV["Developer pushes K8s manifest to git"]:::green --> GIT["Git repo (manifests, Helm charts, Kustomize)"]:::green
    GIT --> ARGO["ArgoCD controller watches git repo"]:::green
    ARGO --> DIFF["Computes diff: git state vs cluster state"]:::green
    DIFF -->|"out of sync"| SYNC["Syncs cluster to match git (kubectl apply equivalent)"]:::green
    SYNC --> CLUSTER["Kubernetes Cluster"]:::k8s
    CLUSTER -->|"health checks"| ARGO
```

**Pull-based vs push-based:**
- Push (Jenkins/GHA): pipeline has cluster credentials, applies changes directly
- Pull (ArgoCD): agent inside cluster pulls changes from git, no external credentials needed

**Why GitOps wins for Kubernetes:**
- Cluster credentials never leave the cluster — no secrets in CI pipelines
- Full audit trail in git: who changed what, when, and why (via PR description)
- Rollback = `git revert` + ArgoCD auto-syncs back
- Multi-cluster: one ArgoCD instance can manage many clusters

---

## Application CRD

The `Application` is ArgoCD's core resource. It defines what to deploy and where.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  # Where to deploy
  destination:
    server: https://kubernetes.default.svc   # in-cluster
    namespace: production

  # Source: where the K8s manifests live
  source:
    repoURL: https://github.com/my-org/my-app-manifests
    targetRevision: main     # branch, tag, or commit SHA
    path: k8s/production     # directory within repo

  # Sync policy
  syncPolicy:
    automated:
      prune: true      # delete resources removed from git
      selfHeal: true   # revert manual cluster changes back to git state
    syncOptions:
      - CreateNamespace=true

  # Health check — what does "healthy" mean for this app?
  # ArgoCD has built-in health checks for Deployment, StatefulSet, Ingress, etc.
```

**Without `automated` sync:** ArgoCD detects drift but waits for a human to click "Sync" or run `argocd app sync my-app`. Manual sync = change management gate before applying to production.

---

## Sync Policies

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    subgraph ManualSync["Manual Sync (default)"]
        DETECT["ArgoCD detects OutOfSync"]:::green --> WAIT["Waits for human approval"]:::orange
        WAIT --> SYNC_BTN["Human clicks Sync / argocd app sync"]:::green
        SYNC_BTN --> APPLY["Apply changes to cluster"]:::blue
    end

    subgraph AutoSync["Automated Sync"]
        A_DETECT["ArgoCD detects OutOfSync"]:::green --> AUTO_APPLY["Immediately applies changes"]:::blue
        AUTO_APPLY --> HEALTH["Health assessment"]:::yellow
        HEALTH -->|"Degraded"| ROLLBACK["Auto-rollback to previous state"]:::blue
    end

    subgraph SelfHeal["Self-Heal (automated + selfHeal: true)"]
        KUBECTL["kubectl edit deployment (manual change)"]:::green --> DRIFT2["ArgoCD detects drift within 3min"]:::red
        DRIFT2 --> REVERT["Reverts manual change to match git"]:::green
    end
```

| Policy | Use case |
|--------|----------|
| Manual sync | Production — require human approval for every deployment |
| Auto sync without self-heal | Staging — auto-deploy new commits, allow temporary manual patches |
| Auto sync + self-heal | Dev/ephemeral — full automation, git is absolute truth |
| Auto sync + prune | Any — clean up resources deleted from git |

---

## Sync Waves and Hooks

Control the order of resource application within a single sync:

```yaml
# Database migration job — must complete BEFORE app deployment
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync        # runs before the main sync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded  # clean up after
    argocd.argoproj.io/sync-wave: "-1"      # wave order (lower = earlier)
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: my-app:v2
          command: ["/app/server", "migrate"]
---
# Main deployment — runs after migration completes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "0"   # default wave
```

**Hook types:**
- `PreSync` — runs before sync (migrations, backups)
- `Sync` — runs during sync alongside regular resources
- `PostSync` — runs after all resources are healthy (smoke tests, notifications)
- `SyncFail` — runs if sync fails (alert, rollback trigger)

---

## App of Apps Pattern

Manage multiple applications from a single ArgoCD Application. The root app deploys other Application CRDs.

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    ROOT["ArgoCD Application: apps-root points to: clusters/prod/apps/"]:::blue --> APP1["Application CRD: payments-service"]:::teal
    ROOT --> APP2["Application CRD: api-gateway"]:::orange
    ROOT --> APP3["Application CRD: worker-service"]:::teal
    ROOT --> APP4["Application CRD: monitoring-stack"]:::blue

    APP1 --> DEPLOY1["Deploys: payments deployment + service + ingress"]:::green
    APP2 --> DEPLOY2["Deploys: api-gateway resources"]:::green
    APP4 --> DEPLOY4["Deploys: Prometheus + Grafana + Alertmanager"]:::green
```

```
clusters/prod/apps/
├── apps-root.yaml          # root Application
├── payments-service.yaml   # Application pointing to payments manifests
├── api-gateway.yaml
└── monitoring-stack.yaml   # Application pointing to monitoring Helm chart
```

**Why:** New applications are added by adding a new Application YAML to git — ArgoCD picks it up automatically. No manual ArgoCD configuration required.

---

## Multi-Cluster Management

One ArgoCD instance can manage many clusters:

```yaml
# Register external cluster
argocd cluster add my-prod-cluster --name production

# Application targeting external cluster
spec:
  destination:
    server: https://my-prod-cluster-api-endpoint:6443
    namespace: payments
```

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    ARGO_CTRL["ArgoCD Controller in management cluster"]:::purple --> CLUSTER_PROD["Production cluster us-east-1"]:::blue
    ARGO_CTRL --> CLUSTER_STG["Staging cluster us-east-1"]:::blue
    ARGO_CTRL --> CLUSTER_EU["EU cluster eu-west-1"]:::blue

    GIT["Git: manifests per cluster clusters/prod/ clusters/staging/ clusters/eu/"]:::green --> ARGO_CTRL
```

**ApplicationSet** — generate Applications automatically for each cluster from a template:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: my-app-all-clusters
spec:
  generators:
    - clusters: {}   # generates one Application per registered cluster
  template:
    spec:
      source:
        repoURL: https://github.com/my-org/manifests
        path: "clusters/{{name}}"   # {{name}} = cluster name
      destination:
        server: "{{server}}"        # cluster API endpoint
        namespace: my-app
```

---

## Rollback

```bash
# View sync history
argocd app history my-app

# Rollback to previous revision
argocd app rollback my-app <revision-id>

# Or: git revert the commit, ArgoCD auto-syncs back
git revert HEAD
git push origin main
# ArgoCD detects the new commit and syncs (which undoes the bad deploy)
```

**Git revert is the preferred rollback** — it's auditable, goes through the same review process, and keeps a clean history. ArgoCD's built-in rollback is useful for emergency hotfixes.

---

## Image Updater

ArgoCD Image Updater automatically updates image tags in git when new images are pushed:

```yaml
# Annotation on Application
annotations:
  argocd-image-updater.argoproj.io/image-list: myapp=123456.dkr.ecr.us-east-1.amazonaws.com/my-app
  argocd-image-updater.argoproj.io/myapp.update-strategy: semver   # or digest, latest, name
  argocd-image-updater.argoproj.io/write-back-method: git          # commit new tag to git
```

**Flow:**
1. CI builds and pushes `my-app:v1.2.3` to ECR
2. Image Updater polls ECR, detects new tag
3. Updates the image tag in the git repo (via commit)
4. ArgoCD detects the git change, syncs the cluster
5. Full GitOps: no CI pipeline needs cluster credentials

---

## Health Checks and Notifications

ArgoCD has built-in health assessments for standard K8s resources. Custom health checks via Lua scripts:

```yaml
# config in argocd-cm ConfigMap
resource.customizations.health.argoproj.io_Rollout: |
  hs = {}
  if obj.status ~= nil then
    if obj.status.phase == "Healthy" then
      hs.status = "Healthy"
    elseif obj.status.phase == "Degraded" then
      hs.status = "Degraded"
      hs.message = obj.status.message
    end
  end
  return hs
```

**Notifications** — alert on sync events via Slack, PagerDuty, email:

```yaml
# argocd-notifications-cm
triggers:
  - name: on-sync-failed
    condition: app.status.sync.status == 'Unknown'
    template: app-sync-failed

templates:
  - name: app-sync-failed
    message: |
      Application {{.app.metadata.name}} sync failed.
      Error: {{.app.status.conditions[0].message}}
```

---

## Multi-Cluster Deployments

### Where does ArgoCD live?

ArgoCD is installed in **one cluster** — the "management cluster" (or hub cluster). It then connects to N target clusters and deploys into them. ArgoCD itself never needs to run in every cluster.

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8

    GIT["Git repo: manifests per cluster"]:::green

    subgraph MGMT["Management Cluster (ArgoCD lives here)"]
        ARGO["ArgoCD<br/>argocd-server<br/>argocd-application-controller"]:::blue
    end

    subgraph C1["Cluster 1: production-us"]
        APP1["Deployed apps"]:::k8s
    end
    subgraph C2["Cluster 2: production-eu"]
        APP2["Deployed apps"]:::k8s
    end
    subgraph C3["Cluster 3: staging"]
        APP3["Deployed apps"]:::k8s
    end

    GIT -->|watches| ARGO
    ARGO -->|kubectl API via kubeconfig/ServiceAccount| C1
    ARGO -->|kubectl API| C2
    ARGO -->|kubectl API| C3
```

**Connectivity:** ArgoCD connects to target clusters using a ServiceAccount token. It uses the Kubernetes API — needs network access from the management cluster to target cluster API servers (typically via private endpoint, VPN, or VPC peering).

### Step 1: Register target clusters

```bash
# Login to ArgoCD CLI
argocd login <argocd-server-host>

# Add each target cluster (uses your current kubeconfig context)
argocd cluster add production-us-context --name production-us
argocd cluster add production-eu-context --name production-eu
argocd cluster add staging-context       --name staging

# Verify
argocd cluster list
# SERVER                          NAME             STATUS
# https://prod-us.eks.amazonaws.com   production-us    Successful
# https://prod-eu.eks.amazonaws.com   production-eu    Successful
# https://staging.eks.amazonaws.com   staging          Successful
```

This creates a Secret in the `argocd` namespace with the cluster credentials.

### Step 2: One Application per cluster (manual)

```yaml
# app-production-us.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-production-us
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/my-org/k8s-manifests
    targetRevision: main
    path: apps/myapp/overlays/production-us   # kustomize overlay per cluster
  destination:
    server: https://prod-us.eks.amazonaws.com  # target cluster API
    namespace: myapp
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Repeat for each cluster. This works but doesn't scale — 3 clusters × 10 apps = 30 Application manifests.

### Step 3: ApplicationSet — the scalable way

`ApplicationSet` is an ArgoCD controller that generates `Application` objects automatically from a template + generator. One manifest, N applications.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - cluster: production-us
        url: https://prod-us.eks.amazonaws.com
        env: production
      - cluster: production-eu
        url: https://prod-eu.eks.amazonaws.com
        env: production
      - cluster: staging
        url: https://staging.eks.amazonaws.com
        env: staging
  template:
    metadata:
      name: "myapp-{{cluster}}"          # generates: myapp-production-us, myapp-production-eu, myapp-staging
    spec:
      project: default
      source:
        repoURL: https://github.com/my-org/k8s-manifests
        targetRevision: main
        path: "apps/myapp/overlays/{{cluster}}"   # per-cluster kustomize overlay
      destination:
        server: "{{url}}"
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

This generates 3 `Application` objects automatically. Add a 4th cluster → add one list element.

### Git repo structure for multi-cluster

```
k8s-manifests/
├── apps/
│   └── myapp/
│       ├── base/                    # shared manifests (Deployment, Service)
│       │   ├── deployment.yaml
│       │   └── kustomization.yaml
│       └── overlays/
│           ├── production-us/       # cluster-specific patches
│           │   ├── kustomization.yaml
│           │   └── patch-replicas.yaml   # replicas: 10
│           ├── production-eu/
│           │   ├── kustomization.yaml
│           │   └── patch-replicas.yaml   # replicas: 5
│           └── staging/
│               ├── kustomization.yaml
│               └── patch-replicas.yaml   # replicas: 2
```

### Progressive delivery across clusters

Deploy to staging first, promote to prod after health check:

```yaml
# Use sync waves: staging syncs first, prod only after staging is healthy
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "1"    # staging: wave 1 (first)
    # prod clusters: wave 2 (after wave 1 healthy)
```

Or use ArgoCD's **Rollout** integration with Argo Rollouts for canary/blue-green per cluster.

### Hub-spoke vs. standalone ArgoCD per cluster

| | Hub (one ArgoCD, N clusters) | Standalone (ArgoCD per cluster) |
|--|-----------------------------|---------------------------------|
| **Ops overhead** | One ArgoCD to maintain | N ArgoCD instances |
| **Blast radius** | ArgoCD cluster down = no deploys to any cluster | One cluster's ArgoCD down = only that cluster affected |
| **Network** | Needs API access to all target clusters | Only needs access to own cluster |
| **Use case** | Small/medium orgs, central platform team | Large orgs, strict isolation, air-gapped clusters |

---

## Projects and RBAC

ArgoCD Projects group Applications and enforce what can be deployed where. RBAC controls who can do what.

### AppProject — boundaries for a team

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments
  namespace: argocd
spec:
  description: "Payments team — production and staging"

  # Which git repos this project can source from
  sourceRepos:
    - https://github.com/my-org/payments-manifests
    - https://github.com/my-org/shared-charts

  # Which clusters + namespaces Applications in this project can deploy to
  destinations:
    - server: https://kubernetes.default.svc
      namespace: payments-prod
    - server: https://kubernetes.default.svc
      namespace: payments-staging

  # Block deploying cluster-scoped resources (RBAC, CRDs, etc.)
  clusterResourceWhitelist: []          # empty = no cluster-scoped resources allowed

  # Allow only these namespaced resource types
  namespaceResourceWhitelist:
    - group: apps
      kind: Deployment
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: autoscaling
      kind: HorizontalPodAutoscaler

  # Sync windows — prevent deploys outside business hours in prod
  syncWindows:
    - kind: deny
      schedule: "0 22 * * *"    # deny at 10pm every day
      duration: 8h               # for 8 hours (10pm–6am)
      applications: ["*"]
      namespaces: ["payments-prod"]
    - kind: allow
      schedule: "0 9 * * 1-5"   # allow weekdays 9am
      duration: 9h
      applications: ["*"]
      namespaces: ["payments-prod"]
```

### RBAC — who can do what

ArgoCD RBAC is configured in the `argocd-rbac-cm` ConfigMap. Roles are defined with `p` (policy) lines, then bound to users/groups.

```yaml
# kubectl edit configmap argocd-rbac-cm -n argocd
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly   # default role for authenticated users

  policy.csv: |
    # Format: p, <role>, <resource>, <action>, <object>, allow|deny

    # Platform team — full access to everything
    p, role:platform-admin, *, *, *, allow

    # Payments team — can sync/manage apps in team-payments project only
    p, role:payments-dev, applications, get,      team-payments/*, allow
    p, role:payments-dev, applications, sync,     team-payments/*, allow
    p, role:payments-dev, applications, action/*, team-payments/*, allow
    p, role:payments-dev, logs,         get,      team-payments/*, allow
    p, role:payments-dev, exec,         create,   team-payments/*, deny   # no exec into pods

    # Read-only role for external auditors
    p, role:auditor, applications, get, */*, allow
    p, role:auditor, clusters,     get, *,   allow

    # Bind GitHub SSO groups to roles
    g, my-org:platform-team, role:platform-admin
    g, my-org:payments,      role:payments-dev
    g, my-org:security-audit, role:auditor
```

**Resource types for RBAC:**

| Resource | Actions |
|----------|---------|
| `applications` | get, create, update, delete, sync, override, action/\* |
| `applicationsets` | get, create, update, delete |
| `clusters` | get, create, update, delete |
| `repositories` | get, create, update, delete |
| `logs` | get |
| `exec` | create |

### SSO Integration (Dex + GitHub)

```yaml
# argocd-cm ConfigMap
data:
  url: https://argocd.my-company.com

  dex.config: |
    connectors:
    - type: github
      id: github
      name: GitHub
      config:
        clientID: $dex.github.clientID        # from argocd-secret
        clientSecret: $dex.github.clientSecret
        orgs:
        - name: my-org
          teams:
          - platform-team
          - payments
          - security-audit
```

```bash
# Verify RBAC — test what a user can do
argocd admin settings rbac can role:payments-dev sync applications team-payments/my-app
# → true or false

# List effective permissions for a user
argocd admin settings rbac can --user john@my-org.com sync applications team-payments/my-app
```

### Project best practices

```
One AppProject per team (not per application)
  → Team owns all their apps under one project
  → Limits blast radius: team can't accidentally deploy to another team's namespace

Always set clusterResourceWhitelist: []
  → Prevents teams from creating ClusterRoles, CRDs, etc.
  → Platform team's project is the only one with cluster resource access

Use syncWindows on production projects
  → Prevents deploys during peak traffic hours
  → Exception: allow override for emergency hotfixes (manual sync with --override)

Separate projects for prod vs non-prod
  → Different sync policies (manual for prod, auto for staging)
  → Different RBAC (only platform team can sync prod)
```
