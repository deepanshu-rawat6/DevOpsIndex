# CI/CD: Concepts & Patterns

---

## CI vs CD vs GitOps

```mermaid
graph LR
    classDef ci fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef cd fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef gitops fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef artifact fill:#e67e22,stroke:#d35400,color:#fff,rx:8

    subgraph CI["CI: Continuous Integration"]
        COMMIT["Code pushed"]:::ci --> BUILD["Build + compile"]:::ci
        BUILD --> TEST["Unit + integration tests"]:::ci
        TEST --> LINT["Lint + security scan"]:::ci
        LINT --> ART["Artifact: Docker image, binary"]:::artifact
    end

    subgraph CD["CD: Continuous Delivery"]
        ART2["Artifact"]:::artifact --> STAGING["Deploy to staging"]:::cd
        STAGING --> SMOKE["Smoke tests"]:::cd
        SMOKE --> PROD["Deploy to prod"]:::cd
    end

    subgraph GitOps["GitOps: Declarative CD"]
        GIT["Git = source of truth"]:::gitops --> AGENT["ArgoCD/Flux watches repo"]:::gitops
        AGENT --> SYNC["Syncs cluster to match git"]:::gitops
        SYNC --> HEAL["Detects and corrects drift"]:::gitops
    end
```

| | CI | CD push | GitOps pull |
|--|----|---------|----|
| Trigger | Code push/PR | Pipeline pushes to env | Agent pulls from git |
| Audit | Pipeline logs | Pipeline logs | Git commits |
| Rollback | Re-run pipeline | Re-run pipeline | `git revert` + auto-sync |

---

## Pipeline Triggers

```mermaid
graph TD
    classDef pr fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef push fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef gate fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8

    subgraph PRTrigger["PR trigger: gates before merge"]
        PR_OPEN["Developer opens PR"]:::pr --> RUN_TESTS["Run: lint, tests, security scan, build"]:::pr
        RUN_TESTS --> GATE["Gate: must pass before merge allowed"]:::gate
    end

    subgraph PushTrigger["Push trigger: deploy after merge"]
        MERGE["Merge to main"]:::push --> DEPLOY_STG["Deploy to staging"]:::push
        DEPLOY_STG --> TAG["Git tag: v1.2.3"]:::push
        TAG --> DEPLOY_PROD["Deploy to prod"]:::push
    end
```

**Best practice flow:**
```
PR opened       → CI: lint + test + security scan + build
PR merged to main → CD: deploy to staging + smoke tests
Git tag v*.*.*  → CD: deploy to production (with approval gate)
```

---

## Deployment Strategies

```mermaid
graph TD
    classDef v1 fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef v2 fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef switch fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef info fill:#95a5a6,stroke:#7f8c8d,color:#fff,rx:6

    subgraph Rolling["Rolling Update: gradual replacement"]
        R1["v1: 3 pods"]:::v1 --> R2["Replace 1 pod with v2"]:::v2
        R2 --> R3["Replace next"]:::v2
        R3 --> R4["All on v2"]:::v2
        RN["Low cost. Both versions run briefly. Slower rollback."]:::info
    end

    subgraph BlueGreen["Blue-Green: instant switch"]
        BG1["Blue: v1 100% traffic"]:::v1 --> BG2["Green: v2 idle"]:::v2
        BG2 --> BG3["Switch LB to Green"]:::switch
        BG3 --> BG4["Blue kept for instant rollback"]:::v1
        BGN["Instant rollback. Doubles cost during transition."]:::info
    end

    subgraph Canary["Canary: gradual traffic shift"]
        C1["v1: 95%"]:::v1 --> C2["v2: 5% canary"]:::v2
        C2 --> C3["Monitor error rate + p99 latency"]:::switch
        C3 --> C4["Shift: 10% to 25% to 50% to 100%"]:::v2
        CN["Real user validation. Low blast radius."]:::info
    end
```

| Strategy | Rollback | Cost | Risk |
|----------|---------|------|------|
| Rolling | Slow (re-deploy) | Low | Mixed versions briefly |
| Blue-Green | Instant (flip switch) | High (double) | None |
| Canary | Fast (shift back) | Medium | Low (small blast radius) |

---

## Secrets in CI/CD

```mermaid
graph TD
    classDef bad fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef t1 fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef t2 fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef t3 fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef t4 fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    BAD["Secrets in code or CI config as plaintext"]:::bad -->|"never"| GOOD

    subgraph GOOD["Secure patterns by tier"]
        T1["CI-native stores
GitHub Actions secrets, GitLab CI variables
Simple, good for non-production"]:::t1
        T2["AWS Secrets Manager with IAM role
Rotatable, audited, AWS-native"]:::t2
        T3["HashiCorp Vault: dynamic secrets
Short-lived per pipeline run
Production-grade"]:::t3
        T4["SOPS + KMS: encrypted files in git
Decrypted at pipeline runtime"]:::t4
    end
```

---

## Docker Layer Caching in CI

```mermaid
graph TD
    classDef cached fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef rebuild fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef base fill:#3498db,stroke:#2980b9,color:#fff,rx:8

    subgraph Good["Optimised: deps before source"]
        G1["FROM golang:1.23-alpine"]:::base --> G2["COPY go.mod go.sum + RUN go mod download"]:::cached
        G2 --> G3["COPY source code"]:::rebuild
        G3 --> G4["RUN go build"]:::rebuild
        GN["go.mod unchanged = layer 2 cached. Only layers 3-4 rebuild."]:::cached
    end

    subgraph Bad["Wrong order: source before deps"]
        B1["FROM golang:1.23-alpine"]:::base --> B2["COPY . ."]:::rebuild
        B2 --> B3["RUN go mod download"]:::rebuild
        B3 --> B4["RUN go build"]:::rebuild
        BN["Every commit invalidates the dep download layer."]:::rebuild
    end
```

---

## Debugging Flaky Pipelines

```mermaid
graph TD
    classDef check fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef cause fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef fix fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8

    FLAKY["Pipeline fails intermittently"]:::cause --> P1["1. Pattern? Time of day, branch, specific stage?"]:::check
    P1 --> P2["2. Env secrets correctly configured per environment?"]:::check
    P2 --> P3["3. Race conditions? Parallel jobs competing for same resource?"]:::check
    P3 --> P4["4. Artifact transfer between stages? Flaky storage?"]:::check
    P4 --> P5["5. Deployment target K8s/ECS throwing transient errors?"]:::check
    P5 --> P6["6. Add explicit retry logic and better logging"]:::fix
```
