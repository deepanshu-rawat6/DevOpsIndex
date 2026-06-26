# GCP vs AWS — Service Comparison

## Core Philosophy Difference

```mermaid
graph LR
    subgraph AWS["AWS — breadth first"]
        A1["150+ services<br>every use case covered<br>built over 20 years<br>most mature ecosystem<br>most enterprise adoption"]
    end
    subgraph GCP["GCP — engineering first"]
        G1["70+ services<br>built on Google's own infra<br>BigQuery, Bigtable, Spanner<br>best Kubernetes (invented it)<br>best data/ML platform"]
    end
```

| Dimension | AWS | GCP |
|-----------|-----|-----|
| Market share | ~32% | ~11% |
| Enterprise adoption | Dominant | Growing |
| Kubernetes | EKS (solid) | GKE (best-in-class, invented K8s) |
| Data/Analytics | Redshift, Athena, EMR | BigQuery (simpler, often cheaper) |
| ML/AI | SageMaker, Bedrock | Vertex AI, TPUs, best for training |
| Networking | Complex but powerful | Global VPC, simpler model |
| Pricing | Pay-per-resource | Sustained use discounts automatic |

---

## Service-by-Service Mapping

### Compute

| Use case | AWS | GCP |
|---------|-----|-----|
| VMs | EC2 | Compute Engine |
| Managed K8s | EKS | GKE |
| Serverless containers | Fargate, App Runner | Cloud Run |
| Serverless functions | Lambda | Cloud Functions |
| Batch compute | Batch | Cloud Batch |
| Spot/preemptible VMs | Spot Instances | Preemptible VMs (Spot VMs) |

### Storage and Databases

| Use case | AWS | GCP |
|---------|-----|-----|
| Object storage | S3 | Cloud Storage |
| Block storage | EBS | Persistent Disk |
| File storage | EFS | Filestore |
| Relational DB | RDS | Cloud SQL |
| Managed Postgres | Aurora Postgres | Cloud Spanner, AlloyDB |
| Global ACID DB | Aurora Global | Spanner (better: true global) |
| NoSQL key-value | DynamoDB | Firestore, Bigtable |
| Wide-column | DynamoDB single-table | Bigtable (better for time-series) |
| Data warehouse | Redshift | BigQuery |
| In-memory cache | ElastiCache | Memorystore (Redis/Memcached) |
| Time-series | Timestream | Bigtable |

### Networking

| Use case | AWS | GCP |
|---------|-----|-----|
| VPC | VPC (region-scoped) | VPC (global — one VPC, all regions) |
| Load balancer | ALB/NLB/CLB | Cloud Load Balancing |
| CDN | CloudFront | Cloud CDN |
| DNS | Route 53 | Cloud DNS |
| Private connectivity | PrivateLink, VPN | Private Service Connect, Cloud VPN |
| Cross-region connectivity | Transit Gateway | Cloud Router + HA VPN |

### Key networking difference:

```mermaid
graph LR
    subgraph AWS["AWS VPC — regional"]
        AVPC1["VPC us-east-1<br>10.0.0.0/16"] 
        AVPC2["VPC eu-west-1<br>10.1.0.0/16"]
        AVPC1 -->|"VPC Peering or\nTransit Gateway"| AVPC2
        NOTE_A["Separate VPCs per region<br>explicit peering required"]
    end
    subgraph GCP["GCP VPC — global"]
        GVPC["Single VPC<br>spans ALL regions"]
        US["Subnet: us-central1<br>10.0.1.0/24"]
        EU["Subnet: europe-west1<br>10.0.2.0/24"]
        GVPC --> US & EU
        NOTE_G["One VPC, subnets in each region<br>automatic routing between regions"]
    end
```

### Observability

| Use case | AWS | GCP |
|---------|-----|-----|
| Metrics | CloudWatch | Cloud Monitoring |
| Logs | CloudWatch Logs | Cloud Logging |
| Traces | X-Ray | Cloud Trace |
| Dashboards | CloudWatch | Cloud Monitoring, Grafana |
| Audit logs | CloudTrail | Cloud Audit Logs |

### AI/ML

| Use case | AWS | GCP |
|---------|-----|-----|
| ML platform | SageMaker | Vertex AI |
| LLM APIs | Bedrock (Claude, Llama, etc.) | Vertex AI (Gemini, etc.) |
| Custom training | SageMaker Training | Vertex AI Training, TPUs |
| TPU access | No | Yes (Google's custom AI chips) |
| Managed notebooks | SageMaker Studio | Vertex AI Workbench |

**GCP TPUs:** Google's Tensor Processing Units give 10-100× better price/performance for LLM training vs GPUs on any cloud. If you're training large models, GCP is often cheaper.

---

## GCP Unique Advantages

### 1. Global VPC
Single VPC spanning all regions — no peering needed. Add a subnet in Tokyo, your London VM can reach it without configuration.

### 2. BigQuery Pricing
BigQuery: $5/TB scanned, $0.02/GB storage. AWS Redshift: $0.25/hour for smallest cluster (even when idle). For sporadic analytics, BigQuery is often 10× cheaper.

### 3. Sustained Use Discounts
GCP automatically gives discounts for VMs running >25% of the month — no upfront commitment required. AWS requires Reserved Instances (1-3 year commitment) for equivalent discounts.

### 4. GKE Quality
GKE gets Kubernetes features first (it's the reference implementation). Autopilot mode — true serverless Kubernetes — doesn't exist on AWS/Azure.

### 5. Spanner — True Global ACID
AWS Aurora Global has replication lag (seconds). Spanner provides globally consistent transactions with ~10ms latency using TrueTime (atomic clocks).

---

## AWS Unique Advantages

### 1. Service breadth
AWS has services GCP doesn't: AppSync (GraphQL), Kinesis Data Firehose simplicity, CodePipeline, many enterprise integrations.

### 2. Enterprise ecosystem
AWS has the most ISV integrations, compliance certifications, and enterprise support.

### 3. Mature marketplace
AWS Marketplace has thousands of third-party products pre-configured.

### 4. On-premises hybrid
AWS Outposts, AWS Local Zones — better on-prem story than GCP Distributed Cloud.

---

## When to Choose Which

```
Choose AWS when:
  - Your team already knows AWS
  - You need maximum service breadth
  - Enterprise compliance requirements (AWS has most certifications)
  - Strong on-prem hybrid requirements

Choose GCP when:
  - Analytics-heavy workload (BigQuery is hard to beat)
  - K8s-native platform (GKE Autopilot, Workload Identity)
  - Training large ML models (TPUs)
  - Multi-region global application (global VPC simplicity)
  - Cost optimization for data warehousing
```
