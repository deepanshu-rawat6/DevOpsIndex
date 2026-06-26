# AWS Networking

---

## VPC Architecture

A **VPC (Virtual Private Cloud)** is your private, logically isolated network inside AWS. Everything lives inside a VPC — EC2 instances, RDS databases, EKS worker nodes, Lambda functions (in VPC mode).

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
    subgraph REGION["AWS Region (e.g. us-east-1)"]
        IGW["Internet Gateway (IGW): bidirectional, attached to VPC"]:::orange

        subgraph VPC["VPC: 10.0.0.0/16"]
            subgraph AZ_A["Availability Zone us-east-1a"]
                subgraph PUB_A["Public Subnet: 10.0.1.0/24"]
                    NACL_PUB_A["NACL: subnet boundary, stateless rules"]:::teal
                    ALB_A["ALB node 10.0.1.10"]:::dark
                    BASTION["Bastion host 10.0.1.20"]:::dark
                    NAT_A["NAT Gateway 10.0.1.30 with Elastic IP"]:::orange
                end
                subgraph PRIV_A["Private Subnet: 10.0.10.0/24"]
                    NACL_PRIV_A["NACL: subnet boundary"]:::teal
                    EC2_A["EC2/EKS node 10.0.10.15"]:::orange
                    RDS_A["RDS Primary 10.0.10.50"]:::blue
                end
            end

            subgraph AZ_B["Availability Zone us-east-1b"]
                subgraph PUB_B["Public Subnet: 10.0.2.0/24"]
                    NACL_PUB_B["NACL"]:::blue
                    ALB_B["ALB node 10.0.2.10"]:::dark
                    NAT_B["NAT Gateway 10.0.2.30"]:::orange
                end
                subgraph PRIV_B["Private Subnet: 10.0.11.0/24"]
                    NACL_PRIV_B["NACL"]:::blue
                    EC2_B["EC2/EKS node 10.0.11.15"]:::orange
                    RDS_B["RDS Standby 10.0.11.50"]:::yellow
                end
            end

            RT_PUB["Public Route Table: 0.0.0.0/0 to IGW, 10.0.0.0/16 local"]:::blue
            RT_PRIV_A["Private Route Table AZ-a: 0.0.0.0/0 to NAT-A"]:::orange
            RT_PRIV_B["Private Route Table AZ-b: 0.0.0.0/0 to NAT-B"]:::orange
        end
    end

    INTERNET["Internet"]:::blue <-->|public IPs| IGW
    IGW <--> RT_PUB
    RT_PUB --> PUB_A
    RT_PUB --> PUB_B
    RT_PRIV_A --> PRIV_A
    RT_PRIV_B --> PRIV_B
    NAT_A -->|outbound only| IGW
    NAT_B -->|outbound only| IGW
```

---

## Public vs Private Subnets

The distinction between public and private is **entirely determined by the route table** associated with the subnet — specifically whether a route for `0.0.0.0/0` points to an **Internet Gateway** or a **NAT Gateway**.

### What Makes a Subnet Public

A subnet is public when:
1. Its route table has a route `0.0.0.0/0 → <internet-gateway-id>`
2. Resources in it have a **public IPv4 address** (or Elastic IP) assigned

Both conditions are required. A route to IGW without a public IP won't give internet access; a public IP without the route also won't.

```
Public Route Table:
  Destination     Target
  10.0.0.0/16     local        ← VPC-internal traffic stays local
  0.0.0.0/0       igw-abc123   ← everything else → internet
```

**What lives in public subnets:** Load balancers (ALB/NLB), NAT Gateways, Bastion/jump hosts.

### What Makes a Subnet Private

A subnet is private when its route table routes `0.0.0.0/0` to a **NAT Gateway** instead of the IGW. Private resources can initiate outbound connections via NAT, but nothing on the internet can initiate a connection TO them.

```
Private Route Table (AZ-a):
  Destination     Target
  10.0.0.0/16     local
  0.0.0.0/0       nat-xyz789   ← outbound only, via NAT in public subnet
```

**What lives in private subnets:** EC2/EKS worker nodes, RDS databases, ElastiCache, internal services.

### Traffic Flow Comparison

```mermaid
sequenceDiagram
    participant I as Internet
    participant IGW as Internet Gateway
    participant ALB as ALB (Public Subnet 10.0.1.10)
    participant NAT as NAT GW (Public Subnet 10.0.1.30)
    participant APP as App Server (Private Subnet 10.0.10.15)
    participant EXT as External API

    Note over I,APP: Inbound request (user to app)
    I->>IGW: Request to ALB Elastic IP
    IGW->>ALB: Forward (ALB has public IP + IGW route)
    ALB->>APP: Forward to private IP via local VPC route
    APP-->>ALB: Response
    ALB-->>I: Response to user

    Note over APP,EXT: Outbound request (app to external API)
    APP->>NAT: routed via 0.0.0.0/0 in private route table
    NAT->>IGW: NAT replaces src IP with its Elastic IP
    IGW->>EXT: Request from NAT's public IP
    EXT-->>NAT: Response to NAT's Elastic IP
    NAT-->>APP: Translated back to private IP
```

Key insight: **The app server is never directly reachable from the internet**. Inbound goes through the ALB. Outbound is NAT'd — the external service sees the NAT Gateway's Elastic IP, not the app's private IP.

---

## Security Groups vs NACLs

These are the two firewall layers in AWS. They operate at different levels and have fundamentally different behavior.

### Security Groups (SGs)

Attached to an **ENI (Elastic Network Interface)** — operates at the **resource level inside the VPC**.

**Security Groups are STATEFUL.**

Stateful means: if you allow inbound traffic on port 443, the **return traffic (response) is automatically allowed** without an explicit outbound rule. The SG tracks the TCP connection in a state table. Reply packets for an established connection are always permitted, regardless of outbound rules.

**SG Rule Characteristics:**
- **Allow-only** — there is no explicit deny. Anything not matched is implicitly denied.
- Rules reference other SGs by ID: `allow inbound TCP 5432 from sg-app-servers` — means any ENI with that SG in the same VPC.
- Evaluated as a **union** — if any rule allows, it's allowed.

```
Security Group: sg-app-server
  Inbound:
    TCP 8080   from  sg-alb         (only ALB can reach app)
    TCP 5432   from  sg-app-server  (inter-pod communication)
  Outbound:
    TCP 5432   to    sg-rds         (app → RDS)
    TCP 443    to    0.0.0.0/0      (app → external HTTPS)
    (return traffic: automatically allowed — stateful)
```

### NACLs (Network Access Control Lists)

Attached to a **subnet** — filters all traffic crossing the **subnet boundary**.

**NACLs are STATELESS.**

Stateless means: **every packet is evaluated independently** in both directions. No connection tracking. If you allow inbound TCP 443, you must ALSO explicitly allow the outbound ephemeral ports (1024-65535) for the return traffic. If you forget, the SYN-ACK can't leave your subnet and TCP connections fail silently.

**NACL Rule Characteristics:**
- Rule number (1–32766) — lower = evaluated first, first match wins.
- Rules can **allow or deny** — you can block specific IPs before a broader allow.
- Final implicit `* DENY ALL` that cannot be removed.

```
NACL: nacl-private-subnet
  Inbound:
    100  ALLOW  TCP  10.0.1.0/24   port 8080       (from ALB public subnet)
    110  ALLOW  TCP  10.0.0.0/16   port 5432       (DB connections)
    *    DENY   ALL  0.0.0.0/0

  Outbound:
    100  ALLOW  TCP  10.0.1.0/24   ports 1024-65535  (ephemeral return to ALB — MUST have this)
    110  ALLOW  TCP  10.0.1.30/32  port 443           (to NAT GW)
    *    DENY   ALL  0.0.0.0/0
```

### Head-to-Head Comparison

| Property | Security Group | NACL |
|----------|---------------|------|
| **Operates at** | ENI / instance level | Subnet boundary |
| **Stateful / Stateless** | **Stateful** — return traffic auto-allowed | **Stateless** — must allow both directions explicitly |
| **Allow / Deny rules** | Allow only (implicit deny) | Allow AND explicit deny |
| **Rule evaluation** | All rules, union of allows | Ordered by rule number, first match wins |
| **Scope** | Specific ENIs | ALL traffic crossing the subnet |
| **Default (new VPC)** | No inbound, all outbound | All traffic allowed |
| **Rule limits** | 60 inbound + 60 outbound | 20 inbound + 20 outbound |
| **Reference other SGs** | Yes | No — CIDR only |
| **Typical use** | Fine-grained service-to-service | Broad subnet defense, block IP ranges |

### Where They Sit in the Network Path

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
    INTERNET["Internet"]:::blue -->|"1. hits IGW"| IGW["Internet Gateway"]:::orange
    IGW -->|"2. routes to public subnet"| NACL_PUB["NACL at public subnet boundary: Stateless, check inbound rule"]:::teal
    NACL_PUB -->|"3. reaches ALB ENI"| SG_ALB["SG on ALB ENI: Stateful, check inbound rule"]:::blue
    SG_ALB -->|"4. ALB forwards to private subnet"| NACL_PRIV["NACL at private subnet boundary: Stateless, check inbound rule"]:::blue
    NACL_PRIV -->|"5. reaches app ENI"| SG_APP["SG on App ENI: Stateful, check inbound rule"]:::blue
    SG_APP -->|"6. app processes"| APP["App Server"]:::dark
```

Response travels the same path in reverse. SGs auto-allow the return; NACLs require explicit outbound rules for ephemeral ports.

**In practice:** NACLs are last-line-of-defense for blocking entire IP ranges at subnet level (useful in PCI-DSS/HIPAA). Security Groups are the primary day-to-day firewall for service-to-service rules. Most teams leave NACLs as "allow all" and do real access control in SGs.

---

## NAT Gateway vs Internet Gateway

| | Internet Gateway (IGW) | NAT Gateway |
|---|---|---|
| **Direction** | Bidirectional (inbound + outbound) | Outbound only |
| **Attached to** | VPC | Subnet (must be public) |
| **Who uses it** | Public subnet resources | Private subnet resources |
| **IP translation** | None — passes through | Translates private IP to NAT's Elastic IP |
| **HA** | Fully managed, no SPOF | Single AZ — deploy one per AZ |
| **Cost** | Free | ~$0.045/hr + data processing |

**NAT Gateway AZ-locality:** Always deploy one NAT Gateway per AZ and route each AZ's private subnet to its local NAT GW. Cross-AZ traffic incurs ~$0.01/GB data transfer charges.

**Cost gotcha — NAT Gateway for AWS service traffic:**
NAT Gateway charges ~$0.045/hr + ~$0.045/GB processed. For heavy traffic to S3, ECR, or DynamoDB routed through NAT, costs compound fast.

**Fix: VPC Endpoints** bypass NAT entirely — traffic stays on the AWS backbone:

| Endpoint Type | Services | Cost | Route table change? |
|--------------|----------|------|---------------------|
| **Gateway Endpoint** | S3, DynamoDB | **Free** | Yes — adds prefix list route |
| **Interface Endpoint** | ECR, Secrets Manager, SSM, SQS, etc. | ~$0.01/hr per AZ + data | No — uses private DNS |

```
# Route table with S3 Gateway Endpoint (replaces NAT for S3 traffic):
10.0.0.0/16    local
pl-68a54001    vpce-s3-xxxx   ← S3 prefix list → stays on AWS backbone (free)
0.0.0.0/0      nat-xyz789     ← everything else still goes through NAT
```

For EKS clusters pulling images from ECR or writing to S3 — add VPC endpoints first before diagnosing high NAT costs.

---

## Route Tables

Every subnet is associated with one route table. Routes are evaluated **most specific first** (longest prefix match).

```
Packet to 10.0.5.20:
  10.0.0.0/16  → local          (/16 matches)
  10.0.5.0/24  → vpc-endpoint   (/24 MORE specific → wins)
  0.0.0.0/0    → igw-abc123

Result: routed to vpc-endpoint
```

**VPC Endpoints** in route tables keep traffic to S3/DynamoDB inside AWS's network (free, faster, no NAT GW needed):
```
10.0.0.0/16    local
pl-68a54001    vpce-s3-xxxx   ← S3 prefix list to VPC endpoint
0.0.0.0/0      nat-xyz789
```

---

## VPC Peering vs Transit Gateway

### VPC Peering

Direct 1:1 network connection between two VPCs over AWS backbone.

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
    VPC_A["VPC A: 10.0.0.0/16 Production"]:::blue <-->|"Peering pcx-abc123"| VPC_B["VPC B: 10.1.0.0/16 Data Platform"]:::teal
    VPC_A <-->|"Peering pcx-def456"| VPC_C["VPC C: 10.2.0.0/16 Shared Services"]:::teal
    VPC_B -.->|"NO transitive routing: B cannot reach C via A"| VPC_C
```

**Key limitation: No transitive routing.** B cannot reach C through A — each pair needs its own peering. N VPCs need N*(N-1)/2 connections.

### Transit Gateway (TGW)

Managed regional hub-and-spoke router. All VPCs attach to TGW; TGW routes between them with full transitive routing support.

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
    TGW["Transit Gateway: central hub, supports transitive routing"]:::orange
    VPC_A["VPC A Production 10.0.0.0/16"]:::blue <-->|Attachment| TGW
    VPC_B["VPC B Data Platform 10.1.0.0/16"]:::teal <-->|Attachment| TGW
    VPC_C["VPC C Shared Services 10.2.0.0/16"]:::teal <-->|Attachment| TGW
    VPC_D["VPC D Dev 10.3.0.0/16"]:::teal <-->|Attachment| TGW
    VPN["On-Premises via VPN/Direct Connect"]:::blue <-->|VPN Attachment| TGW
```

Each VPC's route table only needs: `0.0.0.0/0 → tgw-abc123`. TGW route tables isolate environments (prod from dev).

| | VPC Peering | Transit Gateway |
|--|------------|----------------|
| Topology | Point-to-point | Hub-and-spoke |
| Transitive routing | No | Yes |
| Scalability | ~125 peers per VPC | Thousands of attachments |
| Cross-region | Yes (inter-region peering) | Yes (TGW peering) |
| Cost | No hourly fee, data transfer only | $0.05/hr per attachment + $0.02/GB |
| Best for | Simple, few VPCs | Enterprise, many VPCs, on-prem hybrid |

**Rule of thumb:** 2 VPCs → use peering (free, lower latency). 3+ VPCs, cross-region, or on-prem hybrid → use Transit Gateway (centralized, transitive, worth the cost).
