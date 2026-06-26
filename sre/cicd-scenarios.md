# CI/CD Debugging Scenarios

Practical debugging playbooks for GitHub Actions, ArgoCD, and Jenkins.

---

## 1. GitHub Actions: OIDC Auth to AWS Fails

**Symptom:** `Error assuming role` or `Token is not valid` when using `aws-actions/configure-aws-credentials`.

```mermaid
flowchart TD
    A[OIDC auth fails] --> B{Audience claim<br/>matches?}
    B -- No --> B1[Set audience to<br/>sts.amazonaws.com]
    B -- Yes --> C{Subject condition<br/>in trust policy?}
    C -- Mismatch --> C1[Fix repo/branch<br/>in Condition block]
    C -- OK --> D{OIDC provider<br/>thumbprint valid?}
    D -- Stale --> D1[Update thumbprint<br/>in IAM provider]
    D -- OK --> E{Region in<br/>role ARN correct?}
    E -- Wrong --> E1[Fix ARN region]
    E -- OK --> F[Auth succeeds]
```

**Checklist & commands:**

```yaml
# workflow snippet — audience must match
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/MyRole
    aws-region: us-east-1
    audience: sts.amazonaws.com   # must match trust policy
```

```json
// IAM trust policy — subject must match branch/repo
{
  "Condition": {
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:org/repo:ref:refs/heads/main",
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    }
  }
}
```

```bash
# verify OIDC provider thumbprint
aws iam list-open-id-connect-providers
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com

# test assume-role manually with a debug token
aws sts get-caller-identity
```

**Prevention:** Pin the `aws-actions/configure-aws-credentials` version (`@v4` not `@main`). Store the role ARN in a repository variable not hardcoded in the workflow. Add a CI test workflow that fires on every trust-policy change PR and asserts `aws sts get-caller-identity` succeeds.

---

## 2. GitHub Actions: Job Hangs Indefinitely

**Symptom:** A step runs forever with no output; job never completes.

```mermaid
flowchart TD
    A[Job hangs] --> B{Interactive<br/>prompt?}
    B -- Yes --> B1[Add -y / --no-input<br/>flag to command]
    B -- No --> C{sudo without<br/>NOPASSWD?}
    C -- Yes --> C1[Add NOPASSWD in<br/>sudoers or avoid sudo]
    C -- No --> D{Test waiting<br/>for port?}
    D -- Yes --> D1[Add timeout or<br/>wait-on utility]
    D -- No --> E{Unreachable<br/>network host?}
    E -- Yes --> E1[Mock or skip<br/>network call]
    E -- No --> F{job timeout<br/>not set?}
    F -- Missing --> F1[Add timeout-minutes<br/>to job]
    F -- Set --> G[Cancel job,<br/>check last log line]
```

**Commands:**

```yaml
jobs:
  build:
    timeout-minutes: 15      # always set a ceiling
    steps:
      - run: apt-get install -y curl   # -y prevents prompt
```

```bash
# cancel a stuck run via CLI
gh run list --limit 5
gh run cancel <run-id>

# stream logs to find the last line before hang
gh run view <run-id> --log | tail -40
```

**Prevention:** Set `timeout-minutes` on every job and every step. Use `continue-on-error: false` (default) and add `cancel-in-progress: true` to concurrency groups so a new push cancels stuck old runs. Add a `job_timeout` metric via GitHub API to alert if any job exceeds 30 minutes.

---

## 3. ArgoCD: App Out of Sync But Won't Sync

**Symptom:** App shows `OutOfSync` in the UI but sync does nothing or errors immediately.

```mermaid
flowchart TD
    A[OutOfSync status] --> B[Check diff<br/>in ArgoCD UI]
    B --> C{Managed by<br/>another tool?}
    C -- Yes --> C1[Remove Helm/kubectl<br/>annotations or adopt]
    C -- No --> D{Sync<br/>disabled?}
    D -- Yes --> D1[Enable auto-sync<br/>or trigger manually]
    D -- No --> E{Sync error<br/>in Events?}
    E -- Yes --> E1[Fix validation<br/>webhook error]
    E -- No --> F[Force sync<br/>with --force]
```

**Commands:**

```bash
# inspect what ArgoCD thinks is different
argocd app diff my-app

# check sync status and last error
argocd app get my-app

# enable sync if disabled
argocd app set my-app --sync-policy automated

# force sync (overwrites live state)
argocd app sync my-app --force

# check for webhook rejections in k8s events
kubectl get events -n my-namespace --sort-by='.lastTimestamp' | tail -20
```

**Prevention:** Enable ArgoCD auto-sync with `selfHeal: true` and `prune: true` in non-prod environments so drift is corrected automatically. Use `syncPolicy.syncOptions: [CreateNamespace=true]` to avoid manual namespace creation. Add `argocd app wait` in the CD pipeline — fails the deploy pipeline if ArgoCD doesn't reach `Synced+Healthy` within the timeout.

---

## 4. ArgoCD: ImagePullBackOff After Deploy

**Symptom:** ArgoCD reports `Synced/Healthy` but pods stay in `ImagePullBackOff`.

```mermaid
flowchart TD
    A[ImagePullBackOff] --> B{Tag exists<br/>in registry?}
    B -- No --> B1[Push correct tag<br/>or fix image ref]
    B -- Yes --> C{imagePullSecret<br/>in namespace?}
    C -- Missing --> C1[Create secret &<br/>add to serviceAccount]
    C -- Present --> D{ECR token<br/>expired?}
    D -- Yes --> D1[Switch to IRSA,<br/>remove static creds]
    D -- No --> E{Image updater<br/>in use?}
    E -- Yes --> E1[Check updater logs<br/>& annotation config]
    E -- No --> F[Check kubelet<br/>pull error details]
```

**Commands:**

```bash
# check pod events for pull error details
kubectl describe pod <pod-name> -n <ns> | grep -A 10 Events

# verify image tag exists in ECR
aws ecr describe-images --repository-name my-repo \
  --image-ids imageTag=v1.2.3

# create ECR pull secret (short-term fix)
kubectl create secret docker-registry ecr-creds \
  --docker-server=<account>.dkr.ecr.<region>.amazonaws.com \
  --docker-username=AWS \
  --docker-password=$(aws ecr get-login-password)

# check argocd-image-updater logs
kubectl logs -n argocd deploy/argocd-image-updater | tail -50
```

**Prevention:** Use image digest pinning in ArgoCD (`image: myapp@sha256:...`) — eliminates tag races. Store `imagePullSecrets` as a sealed secret or External Secrets Operator resource, not a manually-created secret. Add a registry reachability check to the CD pipeline before deploying.

---

## 5. Jenkins Pipeline: Docker Build Fails in Agent

**Symptom:** `docker: command not found` or `permission denied /var/run/docker.sock`.

```mermaid
flowchart TD
    A[Docker build fails] --> B{docker binary<br/>present?}
    B -- No --> B1[Install Docker<br/>on agent or use DinD]
    B -- Yes --> C{jenkins user in<br/>docker group?}
    C -- No --> C1[usermod -aG docker jenkins<br/>+ restart agent]
    C -- Yes --> D{Socket mounted<br/>in agent pod?}
    D -- No --> D1[Mount /var/run/docker.sock<br/>in podTemplate]
    D -- Yes --> E{DinD or<br/>socket mount?}
    E -- DinD --> E1[Use privileged DinD<br/>sidecar container]
    E -- Socket --> E2[Check socket perms<br/>chmod 666 or group]
```

**Pipeline snippet & commands:**

```groovy
// Jenkinsfile — socket mount approach
pipeline {
  agent {
    kubernetes {
      yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: docker
    image: docker:24-cli
    command: [sleep, infinity]
    volumeMounts:
    - name: docker-sock
      mountPath: /var/run/docker.sock
  volumes:
  - name: docker-sock
    hostPath:
      path: /var/run/docker.sock
"""
    }
  }
  stages {
    stage('Build') {
      steps {
        container('docker') {
          sh 'docker build -t my-image .'
        }
      }
    }
  }
}
```

```bash
# on the agent node — add jenkins to docker group
sudo usermod -aG docker jenkins
sudo systemctl restart jenkins

# verify socket permissions
ls -la /var/run/docker.sock   # should be srw-rw---- docker group
```

**Prevention:** Use rootless Docker or Kaniko/Buildah in CI agents — eliminates the `docker.sock` privilege escalation risk entirely. If Docker-in-Docker is required, use `--privileged` only in isolated ephemeral agents, never on long-lived shared agents.

---

## 6. Pipeline Deploys to Wrong Environment

**Symptom:** A staging branch push triggers a production deployment.

```mermaid
flowchart TD
    A[Wrong env deployed] --> B{Branch protection<br/>configured?}
    B -- No --> B1[Add branch rules<br/>in GitHub/GitLab]
    B -- Yes --> C{Env var set<br/>correctly?}
    C -- Wrong --> C1[Fix ENV var in<br/>workflow/Jenkinsfile]
    C -- OK --> D{Env name matches<br/>in workflow?}
    D -- Mismatch --> D1[Align environment:<br/>name in workflow]
    D -- OK --> E{ArgoCD app targets<br/>correct cluster/ns?}
    E -- Wrong --> E1[Fix destination in<br/>ArgoCD Application CR]
    E -- OK --> F{Correct Helm<br/>values file used?}
    F -- Wrong --> F1[Fix -f values path<br/>in sync config]
    F -- OK --> G[Add manual approval<br/>gate for prod]
```

**Concrete fixes:**

```yaml
# GitHub Actions — gate production on branch + approval
jobs:
  deploy-prod:
    if: github.ref == 'refs/heads/main'
    environment: production          # requires manual approval in repo settings
    steps:
      - run: helm upgrade --install my-app ./chart -f values/prod.yaml
```

```bash
# verify ArgoCD app destination
argocd app get my-app -o json | jq '.spec.destination'

# check which values file ArgoCD is using
argocd app get my-app -o json | jq '.spec.source.helm'
```

**Prevention:** Use ArgoCD ApplicationSets with environment-specific values files and `project` RBAC — engineers can't promote to prod without approval. Add a `diff` step to the CD pipeline that shows what will change in each environment before applying. Use Helm `--atomic` flag so failed upgrades auto-rollback.

---

## 7. Container Image Build Passes but App Crashes in Staging

**Symptom:** `docker build` succeeds in CI, but container exits immediately in staging.

```mermaid
flowchart TD
    A[App crashes<br/>in staging] --> B{Env vars<br/>missing?}
    B -- Yes --> B1[Add vars to CI<br/>environment secrets]
    B -- No --> C{Secrets<br/>injected?}
    C -- No --> C1[Mount secret or<br/>use secrets manager]
    C -- Yes --> D{Wrong base<br/>image arch?}
    D -- arm/amd mismatch --> D1[Use multi-arch build<br/>docker buildx]
    D -- OK --> E{Health check<br/>path wrong?}
    E -- Yes --> E1[Fix HEALTHCHECK or<br/>readinessProbe path]
    E -- No --> F{DB migration<br/>not run?}
    F -- Yes --> F1[Add init container<br/>or pre-deploy hook]
    F -- No --> G[Check container<br/>logs in staging]
```

**Commands:**

```bash
# pull and inspect the exact CI-built image locally
docker pull <registry>/my-app:<ci-tag>
docker run --rm -e ENV=staging <registry>/my-app:<ci-tag>

# check arch of built image
docker inspect <image> | jq '.[].Architecture'

# multi-arch build
docker buildx build --platform linux/amd64,linux/arm64 -t my-app:latest --push .

# check staging pod logs
kubectl logs -n staging deploy/my-app --previous
kubectl logs -n staging deploy/my-app -f

# describe pod for crash reason
kubectl describe pod -n staging -l app=my-app | grep -A 5 "Last State"
```

**Prevention:** Add a post-deploy smoke test step in the CD pipeline: `kubectl rollout status deployment/my-app -n staging --timeout=120s && curl -f https://staging.example.com/health`. If it fails, auto-rollback with `kubectl rollout undo`. Use `progressDeadlineSeconds: 120` on Deployments so rollouts auto-fail fast.

---

## 8. Flaky Tests Blocking Pipeline

**Symptom:** Tests pass locally and sometimes in CI, but fail intermittently and block merges.

```mermaid
flowchart TD
    A[Flaky test<br/>in CI] --> B{Race<br/>condition?}
    B -- Yes --> B1[Run go test -race,<br/>fix data races]
    B -- No --> C{Timing<br/>dependent?}
    C -- Yes --> C1[Add retry or fix<br/>deterministic wait]
    C -- No --> D{External service<br/>dependency?}
    D -- Yes --> D1[Mock the service<br/>in tests]
    D -- No --> E{Parallel job<br/>resource contention?}
    E -- Yes --> E1[Limit concurrency<br/>or isolate resources]
    E -- No --> F[Increase test<br/>timeout / -timeout flag]
```

**Commands:**

```bash
# detect races
go test -race ./...

# run with explicit timeout
go test -timeout 120s ./...

# re-run flaky test N times locally
for i in $(seq 1 10); do go test -run TestMyFlaky ./pkg/...; done

# run only failed tests from last run (requires gotestsum)
gotestsum --rerun-fails=3 --packages ./...
```

```yaml
# GitHub Actions — retry flaky step
- name: Test
  uses: nick-fields/retry@v3
  with:
    timeout_minutes: 10
    max_attempts: 3
    command: go test -race -timeout 90s ./...
```

**Prevention:** Track flakiness rate per test in CI metrics — quarantine any test with >5% flakiness until fixed (don't just retry). Use `go test -count=1` to disable test caching and always run fresh. For integration tests: use `testcontainers-go` to spin up real dependencies instead of mocks — eliminates a whole class of flakiness from mock state pollution.
```

---

## Quick Reference

| Symptom | First command |
|---------|--------------|
| OIDC auth fails | `aws sts get-caller-identity` |
| Job hangs | `gh run cancel <id>` + check last log |
| ArgoCD won't sync | `argocd app diff my-app` |
| ImagePullBackOff | `kubectl describe pod` → check Events |
| Docker not found in Jenkins | `ls -la /var/run/docker.sock` |
| Wrong env deployed | `argocd app get my-app -o json \| jq .spec.destination` |
| App crashes in staging | `kubectl logs deploy/my-app --previous` |
| Flaky tests | `go test -race ./...` |
