# Jenkins Master-Agent on AWS ECS

A deep-dive into how Jenkins ECS agents work internally — the inbound agent protocol, ECS task provisioning, scaling mechanics, and the optimizations that reduced costs 60% and build times from 35 to 18 minutes.

---

## The Problem: Monolithic Jenkins

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
    subgraph Monolithic["Traditional: Single Jenkins Server"]
        SERVER["t2.2xlarge EC2 $300/month Running 24/7"]:::green
        SERVER --> BUILD1["Build 1"]:::orange
        SERVER --> BUILD2["Build 2"]:::orange
        SERVER --> IDLE["Idle 70% of time still paying full price"]:::blue
    end

    subgraph MasterAgent["Master-Agent on ECS"]
        CTRL["t2.small EC2 Jenkins Controller only ~$15/month"]:::orange --> PLUGIN["ECS Plugin"]:::orange
        PLUGIN -->|"job queued"| FARGATE["Fargate Task pay per second spins up on demand"]:::orange
        PLUGIN -->|"heavy job"| EC2_AGENT["EC2 ECS Task spot instance DinD capable"]:::orange
        FARGATE -->|"job done"| TERMINATE["Task terminated billing stops"]:::red
    end
```

**The shift:** Controller is now just a scheduler — lightweight, small instance. All build work happens on ephemeral ECS tasks that exist only for the duration of the job.

---

## How the Inbound Agent Works Internally

This is the most important thing to understand. The connection is **agent-initiated**, not controller-initiated.

```mermaid
sequenceDiagram
    participant CTRL as Jenkins Controller
    participant PLUGIN as ECS Plugin (on controller)
    participant ECS as AWS ECS API
    participant TASK as ECS Task (jenkins-agent process)

    Note over CTRL: Job queued, no available agent
    CTRL->>PLUGIN: NodeProvisioner requests new agent
    PLUGIN->>ECS: ecs:RunTask (task definition + overrides)
    ECS-->>PLUGIN: taskArn returned, task PENDING

    Note over TASK: Container starts, pulls image from ECR
    TASK->>TASK: entrypoint: /usr/local/bin/jenkins-agent
    TASK->>CTRL: JNLP connect: agent.jar -url http://CTRL:8080 -secret TOKEN -name AGENT_NAME

    Note over CTRL: Controller is LISTENING on JNLP port (50000)
    CTRL-->>TASK: Connection accepted, agent marked ONLINE
    CTRL->>TASK: Send build steps to execute
    TASK->>TASK: Execute pipeline stages
    TASK-->>CTRL: Stream logs + return results

    Note over TASK: Job complete
    CTRL->>PLUGIN: Agent idle, remove
    PLUGIN->>ECS: ecs:StopTask
    ECS->>TASK: Container killed
```

**Key internal details:**

- `agent.jar` (inside the container) connects **outbound** to the controller on the JNLP port (default 50000, configurable). The controller never SSH-es into the agent.
- The controller creates a **secret token** per agent. The agent presents this token on connection — authentication.
- Agent name format: `{label}-{job-name}-{build-number}-{5-random-chars}` e.g. `fargate-my-app-build-17-a3f2b`
- The "agent is offline" message in console is **normal** — it appears while the ECS task is still starting. Jenkins suspends the build executor and resumes when the agent connects.

**Why outbound connection matters for ECS:**
The controller doesn't need to reach the agent's IP. The agent reaches out to the controller. This means agents can be in private subnets with no inbound rules from the controller — only the controller needs an inbound rule on port 50000 from the agent's security group.

---

## ECS Fargate: Full Provisioning Flow

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
    subgraph Controller["Jenkins Controller (EC2 t2.small)"]
        QUEUE["Build Queue: job-a waiting"]:::orange
        PROVISIONER["NodeProvisioner checks every ~10s: are queued jobs > idle executors?"]:::orange
        PLUGIN_FARGATE["ECS Plugin Cloud: fargate-cloud has ECS task definition template"]:::orange
    end

    subgraph AWS["AWS"]
        ECS_API["ECS Service API"]:::orange
        ECR["ECR custom agent image"]:::yellow
        subgraph FARGATE_TASK["ECS Fargate Task (awsvpc network mode)"]
            ENI["Dedicated ENI gets VPC IP from subnet"]:::teal
            CONTAINER["jenkins-agent container CPU: 1024 (1 vCPU) Memory: 2048 MB Ephemeral storage: 20GB"]:::yellow
            AGENT_PROC["java -jar agent.jar connects to controller:50000"]:::purple
        end
        CW["CloudWatch Logs awslogs driver"]:::yellow
    end

    QUEUE --> PROVISIONER
    PROVISIONER --> PLUGIN_FARGATE
    PLUGIN_FARGATE -->|"RunTask API call"| ECS_API
    ECS_API --> FARGATE_TASK
    ECR -->|"image pull via S3 Gateway Endpoint (free)"| CONTAINER
    CONTAINER --> AGENT_PROC
    AGENT_PROC -->|"JNLP connect to controller:50000"| PROVISIONER
    CONTAINER --> CW
```

**Fargate specifics:**
- Network mode **must be `awsvpc`** — each task gets its own ENI and VPC IP
- No privileged mode — cannot mount `/var/run/docker.sock`. No DinD.
- AWS manages the underlying EC2 host — you never see it, patch it, or worry about it
- Billing: per-second from when task enters RUNNING state to when it stops
- Cold start: image pull (mitigated by SOCI) + JVM startup = typically 30-90 seconds

---

## ECS EC2 Launch Type: How It Differs

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
    subgraph Controller["Jenkins Controller"]
        PLUGIN_EC2["ECS Plugin Cloud: ec2-cloud launch type: EC2"]:::orange
    end

    subgraph ASG["Auto Scaling Group (Spot instances: m5.xlarge, m5.2xlarge)"]
        EC2_A["EC2 instance: i-abc123 ECS Agent running Capacity: 4 vCPU, 16GB"]:::green
        EC2_B["EC2 instance: i-def456 ECS Agent running"]:::green
    end

    subgraph Task["ECS Task on EC2 (bridge network mode)"]
        CONTAINER_EC2["jenkins-agent container"]:::blue
        DOCKER_SOCK["/var/run/docker.sock mounted from host enables DinD"]:::dark
        CONTAINER_EC2 --- DOCKER_SOCK
    end

    PLUGIN_EC2 -->|"RunTask — ECS schedules on EC2"| ASG
    ASG --> Task

    subgraph ScaleOut["When no EC2 capacity available"]
        CAPACITY_PROV["ECS Capacity Provider (linked to ASG)"]:::orange
        ASG_SCALE["ASG scales out: launches new EC2 Spot"]:::orange
        CAPACITY_PROV --> ASG_SCALE
    end
```

**EC2 launch type specifics:**
- Network mode is **`bridge`** (or `host`) — NOT `awsvpc`. Container shares the host's network namespace.
- **DinD works** because you mount `/var/run/docker.sock` from the EC2 host into the container via Container Mount Points in the ECS task definition.
- When no EC2 capacity is available, the ECS Capacity Provider triggers the ASG to launch a new instance. This is a **two-stage cold start**: EC2 boot time (~2 min) + image pull + JVM startup. This is why the Golden AMI matters — pre-baked tools eliminate the install time.
- Underlying EC2 instances are **yours to manage**: patching, AMI updates, instance type selection.

**DinD mount in task definition:**
```json
{
  "mountPoints": [{
    "sourceVolume": "docker-sock",
    "containerPath": "/var/run/docker.sock"
  }],
  "volumes": [{
    "name": "docker-sock",
    "host": { "sourcePath": "/var/run/docker.sock" }
  }]
}
```

---

## Scaling: How 1 Job = 1 Agent Works

Each queued job that needs a new agent results in one `ecs:RunTask` API call. There is no shared pool — agents are created on demand, one per job.

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
    subgraph T0["t=0: 10 jobs queued simultaneously"]
        J1["job-1 waits"]:::orange & J2["job-2 waits"]:::orange & J3["...job-10 waits"]:::orange
    end

    subgraph T30["t=30s: NodeProvisioner fires"]
        PROV["NodeProvisioner detects 10 queued jobs, 0 idle agents calls ECS plugin 10 times"]:::orange
        PROV --> RT1["RunTask: fargate-cloud"]:::orange
        PROV --> RT2["RunTask: fargate-cloud"]:::orange
        PROV --> RT3["RunTask: x10"]:::blue
    end

    subgraph T90["t=90s: All 10 Fargate tasks RUNNING"]
        A1["Agent 1 online"]:::blue --> J1_RUN["job-1 executing"]:::blue
        A2["Agent 2 online"]:::blue --> J2_RUN["job-2 executing"]:::blue
        A10["Agent 10 online"]:::blue --> J10_RUN["job-10 executing"]:::blue
    end

    subgraph T_END["jobs finish: tasks terminated immediately"]
        STOP["ECS Plugin calls StopTask billing stops per-second"]:::red
    end
```

**Fargate scaling:** Effectively unlimited concurrency. AWS allocates the underlying compute — you never provision or manage hosts. 10 jobs or 100 jobs: each gets its own Fargate task.

**EC2 scaling (two-stage):**
1. ECS tries to place the task on existing EC2 instances in the cluster
2. If no capacity → Capacity Provider signals the ASG → ASG launches new EC2 Spot instance → EC2 boots (~2 min) → ECS agent on EC2 registers → task placed → container starts

**Max concurrent agents:** Controlled in the ECS plugin by "Restrict max number of agents". Setting 0 = unlimited. Setting 20 = queue builds beyond 20 until an agent frees up.

**NodeProvisioner tuning** (reduces queue wait time):
```
-Dhudson.slaves.NodeProvisioner.initialDelay=0
-Dhudson.slaves.NodeProvisioner.MARGIN=50
-Dhudson.slaves.NodeProvisioner.MARGIN0=0.85
```
These JVM flags make the provisioner react faster to queued jobs instead of waiting for the standard smoothing interval.

---

## Custom Images Per Job Type

The ECS plugin's task definition template acts as a base. Any Jenkinsfile can override the image at runtime.

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
    BASE["jenkins/inbound-agent:alpine3.22-jdk21 Base image: agent.jar + java only"]:::blue

    subgraph CustomImages["Custom images in ECR"]
        JAVA_IMG["agent-java:latest + JDK 21 + Maven 3.9 For Java app builds"]:::orange
        TF_IMG["agent-terraform:latest + Terraform 1.11 + kubectl For infra deploys"]:::green
        NODE_IMG["agent-node:latest + Node 20 + npm For frontend builds"]:::orange
        DIND_IMG["agent-dind:latest + docker-cli For docker image builds (EC2 only)"]:::orange
    end

    BASE --> JAVA_IMG
    BASE --> TF_IMG
    BASE --> NODE_IMG
    BASE --> DIND_IMG
```

**Jenkinsfile image override:**
```groovy
// Use base template but override the image for this specific job
pipeline {
    agent {
        ecs {
            inheritFrom 'fargate-cloud'       // inherits CPU, memory, network config
            image '123456789.dkr.ecr.us-east-1.amazonaws.com/agent-java:latest'
        }
    }
    stages {
        stage('Build') {
            steps {
                sh 'mvn clean package -DskipTests'
            }
        }
    }
}
```

**Dockerfile pattern — multi-stage to minimize image size:**
```dockerfile
ARG ALPINE_VERSION=3.22
ARG JDK_VERSION=jdk21

# Stage 1: builder — install tools, compile, download deps
FROM jenkins/inbound-agent:alpine${ALPINE_VERSION}-${JDK_VERSION} AS builder
USER root
RUN apk add --no-cache curl unzip git

# Install terraform
RUN curl -fsSL -o /tmp/tf.zip https://releases.hashicorp.com/terraform/1.11.0/terraform_1.11.0_linux_amd64.zip \
    && unzip /tmp/tf.zip -d /usr/bin && rm /tmp/tf.zip

# Stage 2: runtime — copy only the final binaries, not build tools
FROM jenkins/inbound-agent:alpine${ALPINE_VERSION}-${JDK_VERSION}
USER root
COPY --from=builder /usr/bin/terraform /usr/bin/terraform
COPY --from=builder /usr/local/bin/kubectl /usr/local/bin/kubectl
USER jenkins
ENTRYPOINT ["/usr/local/bin/jenkins-agent"]
```

**If using a non-Jenkins base image**, you must copy the agent binaries from `inbound-agent`:
```dockerfile
FROM jenkins/inbound-agent:alpine3.22-jdk21 AS jnlp
FROM ubuntu:22.04

COPY --from=jnlp /usr/local/bin/jenkins-agent /usr/local/bin/jenkins-agent
COPY --from=jnlp /usr/share/jenkins/agent.jar  /usr/share/jenkins/agent.jar
COPY --from=jnlp /usr/share/jenkins/slave.jar  /usr/share/jenkins/slave.jar

ENTRYPOINT ["/usr/local/bin/jenkins-agent"]
```

---

## Agent Reuse (Avoid Cold Start on Every Build)

By default, the ECS plugin creates a new task per build and terminates it when done. You can reuse a running agent within a time window.

```groovy
// Forces new ECS task every build (default)
agent {
    ecs {
        inheritFrom 'fargate-cloud'
        image '...ecr.../agent-java:latest'
    }
}

// Reuses existing agent by label if still alive (idle timeout window)
agent {
    label 'fargate-cloud'
}
```

With `label`, if an agent from a previous build is still alive (within the task idle timeout), Jenkins assigns the next build to it directly — no ECS RunTask call, no cold start. The task idle timeout in the ECS plugin config controls how long an idle agent stays alive waiting for the next job.

---

## Networking: Security Group Requirements

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
    CTRL_SG["Controller Security Group"]:::purple
    AGENT_SG["Agent Security Group (Fargate tasks in private subnet)"]:::orange

    CTRL_SG -->|"Inbound: TCP 50000 from AGENT_SG (JNLP port — agent connects to controller)"| CTRL["Jenkins Controller"]:::purple
    CTRL_SG -->|"Inbound: TCP 8080 from AGENT_SG (agent fetches job config from controller API)"| CTRL

    AGENT_SG -->|"Outbound: TCP 50000 to CTRL_SG"| CTRL
    AGENT_SG -->|"Outbound: TCP 443 to ECR (via VPC endpoint)"| ECR["ECR VPC Endpoint"]:::teal
    AGENT_SG -->|"Outbound: TCP 443 to S3 (via Gateway endpoint, free)"| S3["S3 Gateway Endpoint"]:::orange
```

**Common misconfiguration (90% of issues):** The JNLP port on the controller's security group is not open to the agent's security group. The agent starts, tries to connect, fails silently — you see "agent is offline" forever.

**Controller tunnel config:** In the ECS plugin cloud settings:
- `Tunnel connection through`: private IP of controller (e.g. `10.0.1.50:50000`)
- `Alternative Jenkins URL`: `http://10.0.1.50:8080` (private, not public URL)

---

## Optimizations That Achieved 60% Cost Reduction

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
    subgraph CostReduction["Cost Levers"]
        SPOT["Fargate Spot + EC2 Spot Up to 50-90% cheaper than On-Demand For fault-tolerant CI builds"]:::orange
        GRAVITON["Graviton ARM processors 20-30% lower cost 10-25% faster builds"]:::orange
        RIGHT_SIZE["Right-sized task definitions Fargate: 0.25-1 vCPU per job Instead of a fixed large EC2"]:::green
        VPC_EP["VPC Endpoints for ECR and S3 Eliminate NAT Gateway costs ECR layers stored in S3 = free pulls"]:::orange
        EPHEMERAL["Ephemeral agents No idle compute Pay only when building"]:::orange
    end

    subgraph SpeedReduction["Build Time Levers"]
        SOCI["SOCI (Seekable OCI) Lazy-loads container images 50%+ faster Fargate startup"]:::orange
        GOLDEN_AMI["Golden AMI for EC2 Pre-baked tools via Packer No install time at boot"]:::orange
        S3_CACHE["Job Cacher plugin + S3 Persists node_modules and .m2 between ephemeral builds"]:::orange
        LAYER_CACHE["Optimized Dockerfiles Dependency layers before source layers Cache hits on dep-unchanged commits"]:::blue
    end
```

**VPC Endpoint impact (biggest networking saving):**
```
Without VPC endpoints (ECR image pulls via NAT):
  100 builds/day × 500MB image = 50GB/day × $0.045/GB = $2.25/day = $821/year

With VPC endpoints:
  ECR Interface Endpoint: ~$7/month
  S3 Gateway Endpoint: free (ECR layers are in S3)
  Net saving: ~$750/year just from image pulls
```

---

## Groovy-as-Glue: Controller Load Anti-Pattern

Every Groovy function in a Jenkinsfile that isn't inside a `sh` step runs on the **controller**. For heavy processing, this degrades the controller for everyone.

```groovy
// ANTI-PATTERN: runs on controller, consumes controller heap + CPU
stage('Get Version') {
    steps {
        script {
            def content = readFile 'package.json'                          // controller reads file
            def pkg = new groovy.json.JsonSlurper().parseText(content)    // controller parses JSON
            env.APP_VERSION = pkg.version
        }
    }
}

// BEST PRACTICE: runs entirely on agent, only the final string sent to controller
stage('Get Version') {
    steps {
        script {
            env.APP_VERSION = sh(
                script: "jq -r '.version' package.json",   // agent runs jq
                returnStdout: true
            ).trim()
        }
    }
}
```

**Rule:** Use Groovy only as "glue" — control flow, variable assignment, calling `sh`. All actual data processing, file reading, API calls should be shell commands running on the agent.

---

## Fargate vs EC2 Agents: Decision Matrix

| Concern | Fargate | EC2 Launch Type |
|---------|---------|-----------------|
| Docker daemon access (DinD) | No (no privileged mode) | Yes (mount docker.sock) |
| Cold start time | 30-90s (SOCI reduces to 15-30s) | 2-5min (Golden AMI: 60-90s) |
| Scaling | Instant, unlimited | Bounded by ASG scale-out speed |
| Infrastructure management | None (AWS manages hosts) | You manage EC2 fleet, patching, AMI |
| Spot savings | ~50% via FARGATE_SPOT | ~70-90% via EC2 Spot |
| Privileged containers | Not supported | Supported |
| Network mode | awsvpc only | bridge or host |
| Best for | Standard CI: compile, test, lint, deploy | Docker builds, resource-intensive compilations |

**Hybrid approach (what was implemented):**
- Fargate: default for all standard jobs — testing, linting, terraform deploys, kubectl applies
- EC2: only for jobs that need DinD (building Docker images) or require very high CPU/memory
- Fargate Spot: dev environment builds, non-critical jobs, any job with retry on failure

---

## IAM Requirements

Two distinct IAM roles are needed. Getting these wrong is the second most common failure point after security groups.

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
    subgraph ControllerRole["EC2 Instance Role (attached to controller EC2)"]
        ECS_PERMS["ecs:RunTask, ecs:StopTask, ecs:DescribeTasks, ecs:ListClusters, ecs:DescribeTaskDefinition, ecs:RegisterTaskDefinition"]:::red
        IAM_PASS["iam:PassRole: allows passing the task execution role to ECS when running tasks"]:::green
        EC2_DESC["ec2:Describe* — ECS plugin queries VPC/subnet info"]:::orange
    end

    subgraph TaskExecRole["ECS Task Execution Role (used by ECS to start the task)"]
        ECR_PULL["ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer — pull custom agent image from ECR"]:::yellow
        CW_LOGS["logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents — write to CloudWatch"]:::yellow
        SSM_READ["ssm:GetParameters — if using SSM secrets in task definition"]:::yellow
    end

    subgraph TaskRole["ECS Task Role (the IAM identity the agent container runs as)"]
        S3_CACHE["s3:GetObject, s3:PutObject on cache bucket — Job Cacher plugin"]:::purple
        ECR_BUILD["ecr:* on build target repos — if agent builds and pushes images"]:::orange
        ASSUME["sts:AssumeRole — if agent needs to deploy to different accounts"]:::green
        LEAST_PRIV["Per-template: create one task role per job type, each with minimum needed perms"]:::blue
    end

    CTRL["Jenkins Controller"]:::purple --> ControllerRole
    ECS_SVC["ECS Service"]:::orange --> TaskExecRole
    AGENT_CONTAINER["Agent container process"]:::blue --> TaskRole
```

**Task execution role vs task role:**
- **Task execution role** — used by ECS infrastructure to bootstrap the container (pull image, write logs). Your code never touches this.
- **Task role** — the identity your `jenkins-agent` process assumes. This is what `aws s3 cp`, `terraform apply`, `kubectl apply` etc. use inside the build.

**Per-job least privilege:** Create multiple ECS agent templates in the plugin, each with a different task role ARN:

```groovy
// Deploy job — needs S3 and ECS perms
agent {
    ecs {
        inheritFrom 'fargate-cloud'
        taskrole 'arn:aws:iam::123456789:role/jenkins-agent-deploy'
    }
}

// Test job — needs only S3 for cache, nothing else
agent {
    ecs {
        inheritFrom 'fargate-cloud'
        taskrole 'arn:aws:iam::123456789:role/jenkins-agent-test'
    }
}
```

Minimum controller instance role policy:
```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks",
        "ecs:ListClusters", "ecs:DescribeContainerInstances",
        "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition",
        "ecs:ListTaskDefinitions"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::123456789:role/jenkins-agent-task-exec-role",
        "arn:aws:iam::123456789:role/jenkins-agent-*"
      ]
    }
  ]
}
```

---

## Workspace Caching: EFS vs S3

Your original setup used EFS for caching. There are two valid patterns — choose based on access pattern.

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
    subgraph EFSCache["EFS Shared Cache Mount"]
        EFS["Amazon EFS
shared NFS filesystem"]:::blue
        AGENT_A["Fargate Task A builds project-x
writes .m2 to /cache/project-x/"]:::orange --> EFS
        AGENT_B["Fargate Task B builds project-x (next run)
mounts same EFS, cache hit on .m2"]:::orange --> EFS
        EFS_NOTE["Pros: instant cache access, no upload/download step
Cons: EFS throughput costs, potential cache corruption if concurrent writes"]:::blue
    end

    subgraph S3Cache["S3 Job Cacher Plugin"]
        S3["S3 Bucket
build-cache/"]:::orange
        AGENT_C["Agent starts: download cache tarball from S3
~10-30s for 500MB .m2 cache"]:::yellow --> S3
        S3 --> AGENT_D["Agent ends: upload updated cache to S3
only if changed (hash comparison)"]:::yellow
        S3_NOTE["Pros: durable, versioned, cheap storage
Cons: upload/download latency per build"]:::orange
    end
```

**EFS mount in Fargate task definition:**
```json
{
  "volumes": [{
    "name": "build-cache",
    "efsVolumeConfiguration": {
      "fileSystemId": "fs-abc12345",
      "rootDirectory": "/jenkins-cache",
      "transitEncryption": "ENABLED"
    }
  }],
  "mountPoints": [{
    "sourceVolume": "build-cache",
    "containerPath": "/home/jenkins/.m2"
  }]
}
```

**S3 Job Cacher (Jenkinsfile):**
```groovy
// Requires: Job Cacher plugin + s3-jobcacher-storage-plugin
stage('Build') {
    steps {
        cache(maxCacheSize: 500, caches: [
            [$class: 'ArbitraryFileCache',
             path: '/home/jenkins/.m2/repository',
             cacheValidityDecidingFile: 'pom.xml',
             compressionMethod: 'TARGZ']
        ]) {
            sh 'mvn clean package'
        }
    }
}
```

**When to use which:**
| | EFS | S3 Job Cacher |
|--|-----|--------------|
| Cache size | Any (NFS mount) | Up to ~2GB practical |
| Latency | Instant (network mount) | 10-60s download per build |
| Cost | ~$0.30/GB/month + throughput | ~$0.023/GB/month + tiny transfer |
| Concurrent builds | Risk of corruption without locking | Safe (separate per-job cache key) |
| Best for | Large caches (>1GB), many daily builds | Standard Maven/npm caches |

**Important:** EFS is fine for the agent cache mount. It is **not** suitable for `$JENKINS_HOME` on a busy controller (write-heavy random I/O). Use EBS for the controller home directory.

---

## Observability: Debugging Failed ECS Agents

When an agent fails to come online or a build mysteriously dies, this is the investigation path.

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
    OFFLINE["Agent stuck OFFLINE or build fails silently"]:::red --> CHECK_TASK

    CHECK_TASK["1. Find the ECS task
aws ecs list-tasks --cluster jenkins-cluster
aws ecs describe-tasks --cluster jenkins-cluster --tasks TASK_ARN"]:::orange
    CHECK_TASK --> STOPPED{Task stopped?}

    STOPPED -->|"Yes — check StoppedReason"| STOP_REASON["Common StoppedReasons:
CannotPullContainerError: image not found in ECR
ResourceInitializationError: ENI attachment failed
EssentialContainerExited: agent process crashed"]:::red
    STOPPED -->|"No — still running"| CW_LOGS

    CW_LOGS["2. Check CloudWatch Logs
Log group: /jenkins/agents/ or as configured in awslogs
Log stream: jenkins-agent/jenkins-agent/TASK_ID"]:::yellow
    CW_LOGS --> LOG_CHECK{Errors in logs?}

    LOG_CHECK -->|"Connection refused to controller:50000"| SG_FIX["SG misconfiguration
Controller SG missing inbound TCP 50000 from agent SG"]:::purple
    LOG_CHECK -->|"Authentication failed"| AUTH_FIX["Wrong tunnel/URL config in ECS plugin
Check Alternative Jenkins URL and Tunnel fields"]:::red
    LOG_CHECK -->|"OutOfMemoryError"| MEM_FIX["Task memory too low
Increase memory reservation in task definition"]:::blue
    LOG_CHECK -->|"Clean log, agent never logged"| IMAGE_FIX["Image pull failed silently
Check ECR permissions in task execution role"]:::red
```

**CLI debugging commands:**
```bash
# 1. List running tasks in your cluster
aws ecs list-tasks --cluster jenkins-cluster --region us-east-1

# 2. Get details including StoppedReason
aws ecs describe-tasks   --cluster jenkins-cluster   --tasks arn:aws:ecs:us-east-1:123456789:task/jenkins-cluster/abc123   --region us-east-1   --query 'tasks[0].{status:lastStatus,stopped:stoppedReason,containers:containers[*].{name:name,reason:reason,exit:exitCode}}'

# 3. Fetch logs for a specific task
aws logs get-log-events   --log-group-name /jenkins/agents   --log-stream-name "jenkins-agent/jenkins-agent/abc123def456"   --region us-east-1

# 4. Correlate Jenkins build to ECS task
# Agent name in Jenkins console: fargate-my-app-17-a3f2b
# ECS task tags set by plugin include the agent name — search by tag:
aws ecs list-tasks --cluster jenkins-cluster   --filter "tag:JenkinsAgentName=fargate-my-app-17-a3f2b"
```

**CloudWatch Logs Insights query for failed agents:**
```
fields @timestamp, @message
| filter @logStream like /jenkins-agent/
| filter @message like /ERROR|Exception|refused|failed/
| sort @timestamp desc
| limit 50
```

**Enable Execute Command (ECS Exec) for live debugging:**
```bash
# SSH-equivalent into a running Fargate task
aws ecs execute-command   --cluster jenkins-cluster   --task TASK_ARN   --container jenkins-agent   --interactive   --command "/bin/sh"
# Requires: EnableExecuteCommand=true in task definition (already set in plugin config)
```

---

## Fargate Spot Interruption Handling

AWS can reclaim Fargate Spot capacity with a 2-minute warning. If this happens mid-build, the job fails and needs to retry.

```mermaid
sequenceDiagram
    participant AWS as AWS (Spot capacity reclaimed)
    participant TASK as Fargate Spot Task (mid-build)
    participant CTRL as Jenkins Controller

    AWS->>TASK: SIGTERM (2-minute warning)
    Note over TASK: Build is mid-stage, e.g. running mvn package
    TASK->>TASK: Jenkins agent receives SIGTERM
    TASK->>CTRL: Agent disconnects (connection lost)
    CTRL->>CTRL: Build marked FAILED (agent went offline)
    AWS->>TASK: SIGKILL (2 minutes later, task forcibly stopped)

    Note over CTRL: If retry configured: build re-queued
    CTRL->>CTRL: ECS plugin provisions new agent (may land on On-Demand if Spot unavailable)
    CTRL->>CTRL: Build retries from beginning
```

**Capacity provider fallback strategy (recommended):**
```json
{
  "capacityProviderStrategy": [
    {
      "capacityProvider": "FARGATE_SPOT",
      "weight": 3,
      "base": 0
    },
    {
      "capacityProvider": "FARGATE",
      "weight": 1,
      "base": 0
    }
  ]
}
```
This runs 75% of tasks on Spot, falls back to On-Demand when Spot capacity is unavailable. ECS makes this decision automatically per `RunTask` call.

**Making pipelines tolerant of Spot interruption:**
```groovy
pipeline {
    options {
        // Retry the entire pipeline up to 2 times on agent failure
        retry(2)
        // Timeout the whole build — prevents runaway retries
        timeout(time: 1, unit: 'HOURS')
    }
    agent {
        ecs {
            inheritFrom 'fargate-spot-cloud'
        }
    }
    stages {
        stage('Build') {
            steps {
                // Make stages idempotent — safe to re-run
                sh 'mvn clean package -DskipTests'
            }
        }
        stage('Test') {
            steps {
                // Use S3 cache so re-run doesn't re-download deps
                sh 'mvn test'
            }
        }
    }
    post {
        always {
            // Clean workspace — next retry starts clean
            deleteDir()
        }
    }
}
```

**Jobs NOT suitable for Fargate Spot:**
- Builds that take >45 min (higher interruption risk)
- Jobs with side effects that aren't idempotent (e.g., deploy to production — use On-Demand or EC2)
- Jobs that upload large artifacts mid-build and can't resume

**Jobs ideal for Fargate Spot:**
- Unit tests, integration tests
- Linting, security scans
- Development branch builds
- Any job where "just retry it" is acceptable
