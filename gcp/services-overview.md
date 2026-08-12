# GCP Services Overview

IAM, load balancers, DNS, and compute orchestration — GCP building blocks every backend engineer works with.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## IAM (Identity and Access Management)

GCP IAM controls **who** (member) can do **what** (role/permission) on **which** resource. The model is `member + role → resource`.

### Core Concepts

**Members (Identities):**
- `user:` — Google account (human)
- `serviceAccount:` — machine identity for apps/VMs/GKE pods
- `group:` — Google Group (collection of users)
- `allUsers` / `allAuthenticatedUsers` — public access (use carefully)

**Roles (what they can do):**
- **Primitive** — `roles/owner`, `roles/editor`, `roles/viewer` — broad, avoid in prod
- **Predefined** — e.g. `roles/storage.objectViewer`, `roles/container.developer` — fine-grained, Google-managed
- **Custom** — you define exact permissions, e.g. `compute.instances.get` only

**Policy binding:** Attaches a member to a role on a resource.

```json
{
  "bindings": [
    {
      "role": "roles/storage.objectViewer",
      "members": ["serviceAccount:my-app@my-project.iam.gserviceaccount.com"]
    }
  ]
}
```

### Resource Hierarchy

```mermaid
graph TD
    classDef gcp fill:#4285f4,stroke:#2a56c6,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef binding fill:#8e44ad,stroke:#6c3483,color:#fff,rx:8

    subgraph L0["Organization node"]
        ORG["Organization: domain.com<br/>binding: roles/viewer for group:all-eng"]:::gcp
    end

    subgraph L1["Folders — inherit every Org-level binding"]
        FOLDER_A["Folder: Production"]:::orange
        FOLDER_B["Folder: Dev"]:::blue
    end

    subgraph L2["Projects — inherit Org + Folder bindings"]
        PROJ1["Project: prod-backend"]:::green
        PROJ2["Project: prod-data"]:::green
        PROJ3["Project: dev-backend"]:::blue
    end

    subgraph L3["Resources — effective policy = union of every level above"]
        RES["Resources: GCE, GCS, GKE, etc."]:::gcp
    end

    ORG -->|"inherits down"| FOLDER_A
    ORG -->|"inherits down"| FOLDER_B
    FOLDER_A -->|"inherits down"| PROJ1
    FOLDER_A -->|"inherits down"| PROJ2
    FOLDER_B -->|"inherits down"| PROJ3
    PROJ1 -->|"inherits down"| RES

    NEWBINDING["New binding added directly<br/>on prod-backend project"]:::binding -.->|"additive only — cannot revoke<br/>what Org/Folder already granted"| PROJ1
```

IAM policies **inherit downward** — a binding at the Organization level applies to all folders, projects, and resources within it. This is additive; you can't deny at a lower level what's allowed higher up (no deny overrides like AWS explicit deny). The dashed edge above shows why: a narrower binding added directly on `prod-backend` layers on top of everything inherited from Org and Folder — it can only add access, never take away what a higher level already granted.

**AWS parallel:** AWS doesn't have a native Organization → Folder → Account hierarchy at the IAM policy level in the same way. GCP's hierarchy maps loosely to AWS Organizations + SCPs.

### Service Accounts

Service accounts are both an **identity** (for IAM bindings) and a **credential source** (for apps). A GCE VM or GKE pod runs as a service account automatically.

```bash
# Create a service account
gcloud iam service-accounts create my-app-sa \
  --display-name="My App Service Account"

# Grant it a role on a specific resource
gcloud storage buckets add-iam-policy-binding gs://my-bucket \
  --member="serviceAccount:my-app-sa@my-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

### Workload Identity (for GKE)

GKE pods authenticate to GCP APIs as a service account without any key files — using **Workload Identity**. A Kubernetes Service Account is bound to a GCP Service Account, and the actual token exchange happens transparently underneath whatever client library the app is already using:

```mermaid
sequenceDiagram
    participant Pod as App code in Pod, uses ADC
    participant Meta as GKE metadata server
    participant STS as GCP Security Token Service
    participant IAMChk as IAM policy check
    participant API as Target GCP API, e.g. Cloud Storage

    Pod->>Meta: Request credentials via Application Default Credentials
    Meta-->>Pod: Kubernetes-signed OIDC ID token, subject = KSA k8s-sa-name
    Pod->>STS: Exchange ID token for a federated access token
    STS->>IAMChk: Does this KSA hold roles/iam.workloadIdentityUser on the target GSA
    IAMChk-->>STS: Binding found, allow impersonation
    STS-->>Pod: Short-lived OAuth2 access token, scoped as the GSA
    Pod->>API: Call API with the GSA access token
    API-->>Pod: Response, authorized by the GSA's IAM roles
```

Walking through the same exchange one step at a time:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. App asks for credentials.</strong> Code running in the pod calls Google's Application Default Credentials (ADC) library exactly like it would on any GCP compute — no key file, no <code>GOOGLE_APPLICATION_CREDENTIALS</code> env var pointing at a downloaded JSON secret.
    </div>
    <div class="stepper-panel">
      <strong>2. The GKE metadata server answers as the Kubernetes Service Account.</strong> The per-node metadata server intercepts the request and returns a Kubernetes-signed OIDC identity token whose subject is the pod's KSA (<code>namespace/k8s-sa-name</code>), not a long-lived secret.
    </div>
    <div class="stepper-panel">
      <strong>3. Token exchange with GCP's STS.</strong> The client library sends that KSA token to Google's Security Token Service (<code>sts.googleapis.com</code>), asking to trade it for a real GCP access token.
    </div>
    <div class="stepper-panel">
      <strong>4. IAM checks the binding.</strong> STS looks for a <code>roles/iam.workloadIdentityUser</code> binding that maps exactly this KSA to a target GCP Service Account (<code>project.svc.id.goog[namespace/k8s-sa-name]</code>). No binding, no token — this is the only place trust is actually established.
    </div>
    <div class="stepper-panel">
      <strong>5. Pod calls GCP APIs as the GSA.</strong> STS returns a short-lived OAuth2 access token impersonating the GSA. Every API call the pod makes from here on is authorized (or denied) using whatever IAM roles are granted to that GSA — never the KSA directly.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```bash
# Bind K8s SA to GCP SA
gcloud iam service-accounts add-iam-policy-binding my-app-sa@project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:project.svc.id.goog[namespace/k8s-sa-name]"
```

**AWS parallel:** AWS IRSA (IAM Roles for Service Accounts) via OIDC token exchange. GCP Workload Identity is GCP's equivalent — both eliminate the need for credential files in pods.

### IAM: GCP vs AWS

| | GCP IAM | AWS IAM |
|--|---------|---------|
| **Model** | member + role → resource | principal + policy (identity or resource-based) |
| **Deny rules** | No explicit deny (additive only) | Yes — explicit Deny overrides Allow |
| **Resource hierarchy** | Org → Folder → Project → Resource | Account → Resource (no Folder concept) |
| **Cross-account** | Workload Identity Federation | AssumeRole via STS |
| **Machine identity** | Service Account (vm/pod runs as SA) | IAM Role (EC2 instance profile, IRSA) |
| **Policy attachment** | Binding on resource | Policy attached to identity or resource |

<div class="quiz-card">
  <p class="quiz-q">A team lead argues: "let's add a DENY policy at the prod-backend project level to block the intern's overly broad Editor role, which was granted at the Org level." Does this work the way it would in AWS?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. GCP IAM bindings are purely additive — there's no explicit-deny mechanism at a lower level (Folder, Project, Resource) that can revoke or override a broader grant made higher up the resource hierarchy. The only way to fix this is to remove or narrow the binding at the level where it was actually granted (the Org), not to counter it with a deny below. AWS IAM is different: it supports explicit Deny statements that do override any Allow, regardless of where each is attached.</div>
</div>

---

## Cloud Load Balancing

GCP load balancers are **globally distributed** using Google's anycast network — a single IP serves traffic from the nearest PoP worldwide. This is fundamentally different from AWS where ALBs are regional.

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef gcp fill:#4285f4,stroke:#2a56c6,color:#fff,rx:8
    classDef security fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    CLIENT["Client, anywhere in the world"]:::blue -->|"1. HTTPS to the single anycast IP"| ANYCAST

    subgraph Global["Global External Application Load Balancer (Layer 7)"]
        ANYCAST["Global Anycast IP: 34.x.x.x<br/>advertised from every Google PoP"]:::gcp
        ARMOR["Cloud Armor<br/>WAF + DDoS rules evaluated first"]:::security
        FWD["Forwarding Rule (Frontend)"]:::orange
        PROXY["Target HTTPS Proxy<br/>terminates TLS with Google-managed cert"]:::blue
        URLMAP["URL Map<br/>routes on host + path"]:::teal
        BS1["Backend Service: api-backend<br/>health checks + Cloud CDN cache"]:::green
        BS2["Backend Service: web-backend<br/>health checks + Cloud CDN cache"]:::green
        NEG1["NEG / Instance Group (us-central1)"]:::orange
        NEG2["NEG / Instance Group (europe-west1)"]:::orange

        ANYCAST --> ARMOR -->|"2. allow/deny decision"| FWD --> PROXY -->|"3. decrypted request"| URLMAP
        URLMAP -->|"4a. host: api.example.com"| BS1
        URLMAP -->|"4b. host: app.example.com"| BS2
        BS1 -->|"5. route to nearest healthy backend"| NEG1
        BS1 -.->|"failover if us-central1 unhealthy"| NEG2
    end
```

### Load Balancer Types

| Type | Layer | Scope | SSL | Use case |
|------|-------|-------|-----|----------|
| **Global Ext App LB** | L7 HTTP/HTTPS | Global | Terminates | Web apps, APIs, CDN offload |
| **Regional Ext App LB** | L7 HTTP/HTTPS | Regional | Terminates | Regional isolation, VPC Service Controls |
| **Internal App LB** | L7 HTTP/HTTPS | Regional | Terminates | Service mesh, internal microservices |
| **Ext Proxy NLB** | L4 TCP/SSL | Global | Pass-through/terminate | TCP apps, gaming, global static IPs |
| **Internal Passthrough NLB** | L4 TCP/UDP | Regional | None | Internal TCP/UDP services |
| **Ext Passthrough NLB** | L4 TCP/UDP | Regional | None | Legacy regional TCP/UDP |

### Backend Types

GCP load balancers support multiple backend types:

| Backend | Description | AWS analog |
|---------|-------------|-----------|
| **Instance Group** (Managed/Unmanaged) | GCE VMs in a group | Auto Scaling Group |
| **NEG — Zonal** | Specific GCE VM IPs/ports | IP target type |
| **NEG — Serverless** | Cloud Run / App Engine | Lambda target |
| **NEG — Internet** | External endpoint (outside GCP) | Weighted target group |
| **NEG — Private Service Connect** | PSC endpoint | PrivateLink endpoint |

### GCP ALB vs AWS ALB

| | GCP Global App LB | AWS ALB |
|--|---|---|
| **Scope** | Global anycast, single IP | Regional (multi-AZ within one region) |
| **Routing** | Host/path/header | Host/path/header |
| **SSL termination** | Yes | Yes |
| **Backend** | Instance Groups, NEGs, Cloud Run | EC2, ECS/EKS (IP target), Lambda |
| **WAF** | Google Cloud Armor | AWS WAF |
| **CDN** | Cloud CDN integrated | CloudFront (separate) |
| **Cost** | Per forwarding rule + data | Per LCU + data |

### Cloud Armor (WAF)

```bash
# Create a security policy
gcloud compute security-policies create my-waf-policy

# Block a CIDR range
gcloud compute security-policies rules create 1000 \
  --security-policy=my-waf-policy \
  --src-ip-ranges="1.2.3.0/24" \
  --action=deny-403

# Attach to backend service
gcloud compute backend-services update my-backend \
  --security-policy=my-waf-policy \
  --global
```

<div class="quiz-card">
  <p class="quiz-q">A GCP Global External Application LB and an AWS ALB both need to serve HTTPS traffic to users worldwide with low latency. Why does the GCP setup need only one static IP address, while the AWS setup typically needs a separate ALB (and IP) per region?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>GCP's Global LB rides Google's anycast network — the exact same IP address is advertised from every Google PoP worldwide, and each client's traffic naturally routes to whichever PoP is physically closest to it, with no DNS trickery involved. AWS ALBs are regional resources with a dynamic IP scoped to a single region, so covering multiple regions means standing up one ALB (and effectively one IP) per region and routing between them yourself, typically with Route 53 latency-based or geolocation routing.</div>
</div>

---

## Cloud DNS

Cloud DNS is a **managed authoritative DNS** service — equivalent to AWS Route 53 (private and public zones).

### Zone Types

| Zone | Purpose |
|------|---------|
| **Public zone** | Serves DNS queries from the internet |
| **Private zone** | Serves DNS only from specified VPCs |
| **Forwarding zone** | Forwards queries for a domain to external nameservers (on-prem DNS) |
| **Peering zone** | Delegates a zone from one VPC to another VPC's DNS |

```bash
# Create a public zone
gcloud dns managed-zones create my-zone \
  --dns-name="example.com." \
  --visibility=public \
  --description="Production zone"

# Add an A record
gcloud dns record-sets create api.example.com. \
  --zone=my-zone \
  --type=A \
  --ttl=300 \
  --rrdatas="34.1.2.3"
```

### DNS Record Types

| Type | Purpose |
|------|---------|
| `A` | Domain → IPv4 |
| `AAAA` | Domain → IPv6 |
| `CNAME` | Alias to another domain (not at apex) |
| `MX` | Mail server |
| `TXT` | SPF, DKIM, verification |
| `SRV` | Service location |

**Note:** GCP Cloud DNS does NOT have an ALIAS record type like AWS Route 53. For apex domains pointing to a GCP load balancer, use an `A` record with the load balancer's static IP. (GCP's Global LB gives you a static anycast IP — so you can use a plain `A` record at the apex, unlike AWS where the ALB has a dynamic IP requiring ALIAS.)

### Private DNS for GKE

```bash
# Private zone scoped to your VPC
gcloud dns managed-zones create internal-zone \
  --dns-name="internal.example.com." \
  --visibility=private \
  --networks=my-vpc
```

### GCP Cloud DNS vs AWS Route 53

| | GCP Cloud DNS | AWS Route 53 |
|--|---|---|
| **Routing policies** | Weighted, Geo, Failover (via routing policies) | Weighted, Latency, Geolocation, Failover, Multi-value |
| **Health checks** | Via uptime checks integrated separately | Native, tightly coupled to routing |
| **Apex domain** | A record (LB has static IP) | ALIAS record (LB has dynamic DNS) |
| **Private DNS** | Private zones per VPC | Private hosted zones per VPC |
| **DNS forwarding** | Forwarding zones (to on-prem) | Resolver endpoints (Route 53 Resolver) |
| **Cost** | $0.20/zone/month + queries | $0.50/zone/month + queries |

<div class="quiz-card">
  <p class="quiz-q">Why can an apex domain (example.com, no subdomain) point straight at a GCP load balancer with a plain A record, when the equivalent AWS setup needs Route 53's special ALIAS record type instead of a plain A record?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because a GCP Global Load Balancer sits behind a single, static anycast IP address, so an ordinary A record — which just needs a fixed IP, and by DNS spec can't be a CNAME at the zone apex — works and never needs updating. An AWS ALB has a dynamic IP that can change over time, so pointing the apex at it needs Route 53's ALIAS record, which resolves to the ALB's current IP behind the scenes at query time — something a literal A record has no way to do.</div>
</div>

---

## Cloud Run vs GKE

GCP's serverless container service and managed Kubernetes — the GCP parallel to AWS ECS Fargate vs EKS.

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="cloudrun" class="active">Cloud Run</button>
    <button data-toggle-opt="gke">GKE</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="cloudrun">
    Fully serverless containers. You hand Cloud Run an image; it decides how many instances to run, scales to exactly zero when there's no traffic, and bills per request/CPU-second actually used. No Kubernetes API, no node pools, no cluster to patch. Reach for it when the workload is stateless HTTP/gRPC/event-driven and you don't need pod-level control, DaemonSets, or a service mesh.
  </div>
  <div class="toggle-panel" data-toggle-panel="gke">
    A real Kubernetes control plane. You get Deployments, StatefulSets, DaemonSets, custom schedulers, and the whole CNCF ecosystem (Istio, ArgoCD, Anthos Service Mesh) — at the cost of running (Standard) or at least reasoning about (Autopilot) the underlying node infrastructure. Nothing here scales to zero the way Cloud Run does. Reach for it when you need the Kubernetes API surface itself, not just "a container that runs."
  </div>
</div>

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef gcp fill:#4285f4,stroke:#2a56c6,color:#fff,rx:8

    REQ["Incoming HTTPS request / event"]:::gcp

    subgraph CloudRun["Cloud Run — Serverless Containers"]
        CR_REQ["Handles HTTPS, gRPC,<br/>Pub/Sub push, WebSockets"]:::orange
        CR_SCALE["Auto-scales 0 → N → 0<br/>per-request billing"]:::teal
        CR_DEPLOY["Deploy container image<br/>no Dockerfile changes needed"]:::gcp
        CR_INFRA["No VM or node management<br/>Google owns the control plane"]:::blue

        CR_REQ --> CR_SCALE --> CR_DEPLOY --> CR_INFRA
    end

    subgraph GKE["GKE — Google Kubernetes Engine"]
        GKE_CP["Autopilot or Standard mode"]:::gcp
        GKE_NODE["Node pools (GCE VMs)<br/>Autopilot: Google-managed<br/>Standard: you manage"]:::orange
        GKE_POD["Pods, Deployments, StatefulSets,<br/>DaemonSets (Standard only)"]:::green
        GKE_MESH["Anthos/Cloud Service Mesh,<br/>ArgoCD, Istio"]:::blue

        GKE_CP --> GKE_NODE --> GKE_POD --> GKE_MESH
    end

    REQ -->|"stateless HTTP/event workload"| CR_REQ
    REQ -.->|"needs Kubernetes API surface"| GKE_CP
```

### Cloud Run Deep Dive

- Deploy a container image, Cloud Run handles infrastructure entirely
- **Scales to zero** — no requests = no cost (unlike ECS which keeps tasks running)
- **Concurrency model:** each container instance handles multiple concurrent requests (configurable, default 80)
- Supports HTTP, gRPC, WebSockets, Pub/Sub push subscriptions
- **Cloud Run Jobs** — for batch/one-shot workloads (parallel to ECS Tasks with `--launch-type=FARGATE`)

```bash
gcloud run deploy my-service \
  --image=gcr.io/my-project/my-app:latest \
  --region=us-central1 \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=100
```

### GKE Modes

| Mode | Description |
|------|-------------|
| **Autopilot** | Google manages nodes, node pools, scaling. You only define Pods. Billed per pod resource request. Recommended default. |
| **Standard** | You manage node pools. Full control over machine types, taints, GPUs, custom OS images. |

```bash
# GKE Autopilot cluster (no node management)
gcloud container clusters create-auto my-cluster \
  --region=us-central1

# GKE Standard with a node pool
gcloud container clusters create my-cluster \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --num-nodes=3
```

### GKE Autopilot vs Standard

| | Autopilot | Standard |
|--|-----------|----------|
| **Node management** | Google-managed | You manage |
| **Billing** | Per pod (CPU/memory requested) | Per node (VM cost regardless of usage) |
| **DaemonSets** | No (Autopilot runs Google-managed DS only) | Yes |
| **Node access (SSH)** | No | Yes |
| **GPU nodes** | Limited | Yes |
| **Best for** | Most workloads, lower ops overhead | Custom hardware, DaemonSets, tuning |

### Cloud Run vs GKE vs AWS

| | Cloud Run | GKE Autopilot | GKE Standard | AWS ECS Fargate | AWS EKS |
|--|-----------|---------------|--------------|-----------------|---------|
| **Scale to zero** | Yes | No | No | No | No |
| **Kubernetes API** | No | Yes | Yes | No | Yes |
| **Node management** | None | None | Full control | None | Partial (managed node groups) |
| **DaemonSets** | No | No | Yes | No | Yes |
| **Concurrency/request model** | Per request, concurrent | Per pod | Per pod | Per task | Per pod |
| **Cold start** | Yes (~100ms-2s) | No | No | No | No |
| **Best for** | Stateless HTTP/event workloads | K8s without node ops | Full platform engineering | Simple containers, AWS-native | Microservices, platform eng |

<div class="quiz-card">
  <p class="quiz-q">A team runs GKE Standard with 10 n2-standard-4 nodes, but their pods only use about 20% of that capacity most of the day. Does switching to GKE Autopilot fix the waste the same way switching to Cloud Run would?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Not the same way. Cloud Run can drop cost to near zero because it scales the whole workload to zero instances when there's no traffic, billing per request/CPU-second actually consumed. GKE Autopilot doesn't scale to zero — it still bills for whatever the pods request — but it does fix this specific waste, because Autopilot bills per pod resource request instead of per whole node, so the overprovisioned node capacity simply stops being billed. GKE Standard is the one option here where idle node capacity is pure sunk cost: you pay for the VM whether or not pods are using it.</div>
</div>

---

## TLS and mTLS on GCP

### TLS Termination at Cloud Load Balancer

The Global External Application LB terminates TLS at Google's edge PoPs worldwide — closer to users than a regional ALB.

```mermaid
sequenceDiagram
    participant Client as External client, London
    participant GFE as Google Edge PoP, Frankfurt
    participant Backend as Backend, GCE/GKE/Cloud Run, us-central1

    Client->>GFE: TLS 1.3 handshake to the anycast IP
    GFE-->>Client: Google-managed certificate, TLS terminated here
    Client->>GFE: HTTPS request over the now-decrypted connection
    GFE->>Backend: Forward over HTTP/2, encrypted on Google's private backbone
    Backend-->>GFE: Response
    GFE-->>Client: HTTPS response, re-encrypted for the last hop
```

Google-managed certificates auto-renew with no manual action:

```bash
gcloud compute ssl-certificates create my-cert \
  --domains=api.example.com \
  --global
# GCP auto-provisions and renews via Let's Encrypt/Google CA
```

### Anthos Service Mesh / Cloud Service Mesh (mTLS)

GCP's managed Istio service mesh. Provides mTLS between services inside GKE with automatic certificate rotation — equivalent to AWS App Mesh or self-managed Istio on EKS.

```mermaid
graph LR
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef gcp fill:#4285f4,stroke:#2a56c6,color:#fff,rx:8
    classDef purple fill:#8e44ad,stroke:#6c3483,color:#fff,rx:8

    CLIENT["External client"]:::blue -->|"HTTPS — terminated at edge"| GLB["Global LB (GFE)"]:::gcp

    subgraph CP["Cloud Service Mesh control plane — Google-managed, no Istiod to run"]
        CAS["Certificate Authority Service<br/>issues + auto-rotates SPIFFE certs"]:::purple
    end

    subgraph CLUSTER["GKE cluster"]
        subgraph PODA["payments pod"]
            APPA["payments container"]:::orange
            SIDECAR_A["Envoy sidecar"]:::orange
        end
        subgraph PODB["db-proxy pod"]
            APPB["db-proxy container"]:::teal
            SIDECAR_B["Envoy sidecar"]:::teal
        end
    end

    GLB -->|"HTTP/2 on Google backbone"| SIDECAR_A
    SIDECAR_A -->|"local, in-pod"| APPA
    SIDECAR_A -->|"mTLS — mutual SPIFFE identity check"| SIDECAR_B
    SIDECAR_B -->|"local, in-pod"| APPB
    CAS -.->|"issues cert"| SIDECAR_A
    CAS -.->|"issues cert"| SIDECAR_B
```

**Key GCP advantage:** Cloud Service Mesh manages the Istio control plane — no Istiod to operate. SPIFFE certs are rotated automatically via Google Certificate Authority Service.

<div class="quiz-card">
  <p class="quiz-q">Cloud Service Mesh gives you mTLS between GKE services with automatic certificate rotation. What's the concrete operational difference from running self-managed Istio on GKE (or Istio on EKS) to get that same mTLS behavior?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The mTLS guarantee itself is equivalent either way — SPIFFE-identified, automatically rotated certs between services. The difference is who runs the control plane: Cloud Service Mesh's Istio control plane is managed by Google, so there's no Istiod for your team to deploy, upgrade, or keep highly available. Self-managed Istio, including Istio on EKS, leaves that control-plane operational burden on you, even though the mTLS it delivers to your services looks the same.</div>
</div>
