# Docker Debugging Scenarios

Ten failure patterns you'll actually hit running Docker in production — the symptom, a live diagnostic flowchart, the commands to confirm the cause, and how to stop it recurring. Track how many knowledge checks you clear as you go:

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Container Exits Immediately

**Symptom:** `docker run` exits instantly, `docker ps` shows no running container.

```mermaid
flowchart TD
    A[docker run exits] --> B[docker inspect ExitCode]
    B --> C{Exit code?}
    C -->|0| D[CMD completed normally]
    C -->|1| E[App error]
    C -->|137| F[OOM / SIGKILL]
    C -->|139| G[Segfault]
    E --> H[docker logs]
    F --> H
    G --> H
    H --> I{Logs helpful?}
    I -->|No| J[Override entrypoint:<br/>docker run -it --entrypoint sh]
    I -->|Yes| K[Fix app error]
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="code0" class="active">Exit 0</button>
    <button data-toggle-opt="code1" class="state-warn">Exit 1</button>
    <button data-toggle-opt="code137" class="state-bad">Exit 137</button>
    <button data-toggle-opt="code139" class="state-bad">Exit 139</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="code0">
    <strong>CMD completed normally.</strong> Not necessarily a good sign for a long-running service &mdash; it usually means the foreground process finished and returned on its own (a script that ran to completion, a missing daemon flag), not that the app came up and stayed up serving traffic.
  </div>
  <div class="toggle-panel" data-toggle-panel="code1">
    <strong>App error.</strong> The process ran and exited on its own with a non-zero status. <code>docker logs</code> is where the actual error shows up &mdash; fix the app-level problem it reveals.
  </div>
  <div class="toggle-panel" data-toggle-panel="code137">
    <strong>OOM / SIGKILL.</strong> 128 + signal 9. The kernel or Docker killed the process outright &mdash; confirm with the container's <code>OOMKilled</code> flag before assuming memory; see Scenario 2.
  </div>
  <div class="toggle-panel" data-toggle-panel="code139">
    <strong>Segfault.</strong> 128 + signal 11. The process crashed at a low level &mdash; usually a bug in the binary or a native dependency, not a Docker problem. <code>docker logs</code> and a core dump (if enabled) are the next stop.
  </div>
</div>

```bash
# Check exit code and error
docker inspect <container> --format='{{.State.ExitCode}} | {{.State.Error}}'

# View logs of exited container
docker logs <container>

# Override entrypoint to debug interactively
docker run -it --entrypoint sh <image>
```

**Prevention:** Use `HEALTHCHECK` in every production Dockerfile so Docker surfaces unhealthy status before traffic reaches the container. Set `restart: unless-stopped` in Compose so transient crashes auto-recover. Log to stderr from process start — before any initialization — so logs are always available even on crash.

---

## 2. Container OOM Killed

**Symptom:** Container exits with code 137. App was consuming too much memory.

```mermaid
flowchart TD
    A[Exit code 137] --> B[docker inspect OOMKilled]
    B --> C{OOMKilled=true?}
    C -->|Yes| D[docker stats — live memory]
    C -->|No| E[Killed by external signal]
    D --> F{Over limit?}
    F -->|Yes| G[Raise --memory limit]
    F -->|No| H[Check memory leak in app]
    G --> I[docker run --memory 512m<br/>--memory-swap 512m]
```

```bash
# Check OOMKilled flag
docker inspect <container> --format='{{.State.OOMKilled}}'

# Live memory stats
docker stats <container>

# Set memory limit
docker run --memory 512m --memory-swap 512m <image>
```

**Prevention:** Always set `--memory` limits in production. For Go: set `GOMEMLIMIT` slightly below the Docker limit so GC kicks in before the OOM killer does. Monitor `docker stats` — alert when container memory exceeds 80% of limit. Use `--memory-swap` equal to `--memory` to prevent swapping.

---

## 3. Can't Connect to Container Port

**Symptom:** `curl localhost:8080` fails even though container runs with `-p 8080:80`.

```mermaid
flowchart TD
    A[curl localhost:8080 fails] --> B{Container running?}
    B -->|No| C[docker start / docker run]
    B -->|Yes| D{Port published?}
    D -->|No| E[Add -p 8080:80 flag]
    D -->|Yes| F{App listening inside?}
    F -->|No| G[Fix app bind address]
    F -->|Yes| H{App on 0.0.0.0?}
    H -->|No: 127.0.0.1| I[Bind app to 0.0.0.0]
    H -->|Yes| J{iptables rule exists?}
    J -->|No| K[Restart Docker daemon]
    J -->|Yes| L{Host firewall blocking?}
    L -->|Yes| M[Open host port]
    L -->|No| N[Check docker inspect Ports]
```

```bash
# Check published ports
docker ps --format 'table {{.Names}}\t{{.Ports}}'

# Check what the app is listening on inside the container
docker exec <container> ss -tlnp

# Inspect NAT rules
iptables -t nat -L DOCKER -n

# Inspect port bindings
docker inspect <container> --format='{{json .NetworkSettings.Ports}}'
```

**Prevention:** Always bind your app to `0.0.0.0` (not `127.0.0.1`) in containerized environments. Validate port bindings in CI with a smoke test: `docker run -d -p 8080:8080 image && sleep 2 && curl -f localhost:8080/health`.

---

## 4. Container Can't Reach the Internet

**Symptom:** `curl` inside container times out. DNS resolves fine.

```mermaid
flowchart TD
    A[No internet inside container] --> B[ping 8.8.8.8]
    B --> C{Ping works?}
    C -->|Yes| D[DNS issue only — check resolv.conf]
    C -->|No| E{ip_forward enabled?}
    E -->|No| F[sysctl -w net.ipv4.ip_forward=1]
    E -->|Yes| G{MASQUERADE rule exists?}
    G -->|No| H[iptables -t nat -A POSTROUTING<br/>-j MASQUERADE]
    G -->|Yes| I{docker0 bridge OK?}
    I -->|No| J[docker network inspect bridge]
    I -->|Yes| K[Custom network routing issue]
```

```bash
# Ping from inside container
docker exec <container> ping -c3 8.8.8.8

# Check IP forwarding
sysctl net.ipv4.ip_forward

# Check MASQUERADE rule
iptables -t nat -L POSTROUTING -n -v

# Inspect docker network
docker network inspect bridge
```

**Prevention:** After Docker daemon upgrades or kernel updates, run `docker run --rm alpine ping -c1 8.8.8.8` as a post-install smoke test. Persist `net.ipv4.ip_forward=1` in `/etc/sysctl.d/` — it can revert after reboots if not persisted.

---

## 5. Containers on Same Host Can't Reach Each Other

**Symptom:** Container A can't ping/connect container B on the same host.

```mermaid
flowchart TD
    A[A can't reach B] --> B{Same network?}
    B -->|No| C[Connect both to same<br/>custom network]
    B -->|Yes| D{Default or custom bridge?}
    D -->|Default bridge| E[No DNS — use IP address]
    D -->|Custom bridge| F[DNS works — use container name]
    E --> G[docker inspect for IP]
    F --> H[ping container-name]
    H --> I{Still fails?}
    I -->|Yes| J[Check DOCKER-ISOLATION<br/>iptables chain]
    J --> K[docker network inspect]
```

```bash
# Inspect network and connected containers
docker network inspect <network>

# Ping by container name (custom network only)
docker exec <containerA> ping <containerB>

# DNS lookup inside container
docker exec <containerA> nslookup <containerB>

# Check container's network config
docker inspect <container> --format='{{json .NetworkSettings.Networks}}'
```

**Prevention:** Always use named custom networks in Compose — never rely on the default bridge. Custom networks provide automatic DNS by container name. Define the network explicitly in `docker-compose.yml` so all services join it and can resolve each other by service name.

---

## 6. docker build Is Slow / Cache Not Working

**Symptom:** Every build takes full time even with no changes.

```mermaid
flowchart TD
    A[Cache always misses] --> B{COPY . . before RUN?}
    B -->|Yes| C[Move COPY after RUN deps —<br/>cache invalidated on any file change]
    B -->|No| D{.dockerignore missing?}
    D -->|Yes| E[Add .dockerignore —<br/>exclude node_modules / .git]
    D -->|No| F{Build args changing?}
    F -->|Yes| G[ARG invalidates all layers below it]
    F -->|No| H{--no-cache flag?}
    H -->|Yes| I[Remove --no-cache from CI]
    H -->|No| J[Correct layer order:<br/>deps --> code --> COPY .]
```

**Correct Dockerfile layer order:**
```dockerfile
# Good: stable layers first
COPY go.mod go.sum ./
RUN go mod download          # cached unless go.mod changes
COPY . .                     # only invalidates layers below
RUN go build -o app .
```

**Prevention:** Enforce layer order in code review: `COPY go.mod go.sum` → `RUN go mod download` → `COPY . .` → `RUN build`. Add a `.dockerignore` to every repo. Run `docker build --no-cache` only in weekly full-rebuild CI, never in the per-PR pipeline.

---

## 7. Image Too Large

**Symptom:** `docker images` shows 1.5 GB image. CI pulls take minutes.

```mermaid
flowchart TD
    A[Image too large] --> B[docker history — find fat layer]
    B --> C{Base image bloated?}
    C -->|Yes| D[Switch to alpine / distroless]
    C -->|No| E{apt cache not cleaned?}
    E -->|Yes| F[Add rm -rf /var/lib/apt/lists/*<br/>in same RUN]
    E -->|No| G{Single stage build?}
    G -->|Yes| H[Use multi-stage build]
    G -->|No| I{Source files copied?}
    I -->|Yes| J[Add .dockerignore]
```

```bash
# Show layer sizes
docker history --no-trunc <image>

# Interactive layer explorer (install separately)
dive <image>

# List image sizes
docker images --format 'table {{.Repository}}\t{{.Size}}'
```

**Multi-stage example:**
```dockerfile
FROM golang:1.22 AS builder
WORKDIR /app
COPY . .
RUN go build -o app .

FROM gcr.io/distroless/static
COPY --from=builder /app/app /app
ENTRYPOINT ["/app"]
```

**Prevention:** Set a CI size gate: `docker images --format '{{.Size}}' myapp:latest` — fail the build if it exceeds 100 MB. Use `distroless/static` or `scratch` as the final stage for Go binaries. Run `dive --ci` in CI to catch any layer regressions automatically.

---

## 8. Volume Mount Not Working

**Symptom:** App gets permission denied or file not found on mounted path.

```mermaid
flowchart TD
    A[Volume mount fails] --> B{Bind or named volume?}
    B -->|Bind mount| C{Host path exists?}
    C -->|No| D[mkdir on host path]
    C -->|Yes| E{UID mismatch?}
    E -->|Yes| F[chown on host OR<br/>--user flag in docker run]
    E -->|No| G{SELinux / AppArmor?}
    G -->|Yes| H[Add :z or :Z to mount]
    B -->|Named volume| I[docker volume inspect]
    I --> J{Volume has data?}
    J -->|No| K[Check Dockerfile VOLUME directive]
```

```bash
# Inspect mounts on running container
docker inspect <container> --format='{{json .Mounts}}'

# Check host path permissions
ls -la /host/path

# Mount with read-only
docker run -v /host/path:/container/path:ro <image>

# List and inspect named volumes
docker volume ls
docker volume inspect <volume>
```

**Prevention:** Never run containers as root when bind-mounting host paths. Set `USER` in Dockerfile and match UID with the host path owner. Add `:ro` to read-only mounts to prevent accidental writes. Document expected UID in the repo README.

---

## 9. docker-compose Service Won't Start

**Symptom:** `docker compose up` — dependency shows healthy but dependent fails immediately.

```mermaid
flowchart TD
    A[Service fails on start] --> B{depends_on condition met?}
    B -->|No| C[Check healthcheck command —<br/>test / interval / retries]
    B -->|Yes| D{Env vars correct?}
    D -->|No| E[docker compose config —<br/>validate resolved values]
    D -->|Yes| F{Port conflict on host?}
    F -->|Yes| G[Change host port in compose]
    F -->|No| H[docker compose logs service]
    H --> I[Fix app startup error]
```

```bash
# View service logs
docker compose logs <service>

# Show all service states
docker compose ps

# Validate and print resolved compose config
docker compose config

# Recreate containers (pick up config changes)
docker compose up --force-recreate
```

**Prevention:** Always define `healthcheck` on dependency services (postgres, redis) in Compose and use `depends_on: condition: service_healthy` — not just `depends_on: db`. Add `docker compose config` as a CI lint step to catch YAML/variable errors before they reach a developer's machine.

---

## 10. Disk Space Exhausted by Docker

**Symptom:** `/var/lib/docker` consuming 50 GB+. Host disk full.

```mermaid
flowchart TD
    A[Disk full] --> B[docker system df]
    B --> C{Stopped containers?}
    C -->|Yes| D[docker container prune]
    C -->|No| E{Dangling images?}
    E -->|Yes| F[docker image prune]
    E -->|No| G{Unused volumes?}
    G -->|Yes| H[docker volume prune]
    G -->|No| I{Build cache large?}
    I -->|Yes| J[docker builder prune]
    I -->|No| K[docker system prune -af --volumes]
```

```bash
# Show disk usage breakdown
docker system df

# Prune everything unused (containers, images, networks, cache)
docker system prune -af --volumes

# Targeted pruning
docker image prune -f          # dangling images only
docker image prune -af         # all unused images
docker container prune -f      # stopped containers
docker volume prune -f         # unused volumes
docker builder prune -af       # build cache
```

**Prevention:** Add a weekly cron job on every CI host: `docker system prune -af --volumes --filter "until=168h"`. Set `"log-opts": {"max-size": "50m", "max-file": "3"}` in `/etc/docker/daemon.json` to cap container log sizes. Alert on host disk usage > 70% before Docker fills the drive.

---

## 11. Multi-Stage Build Pitfalls

Multi-stage builds reduce image size but have subtle failure modes.

**Stage output not copied — silent size bloat:**
```dockerfile
# WRONG: final stage copies from wrong alias
FROM golang:1.22 AS builder
RUN go build -o /app .

FROM gcr.io/distroless/static
COPY --from=build /app /app   # "build" doesn't exist — Docker silently skips this
                               # or errors depending on version; image has no binary
# FIX:
COPY --from=builder /app /app  # alias must match exactly
```

**Build cache invalidated by COPY order:**
```dockerfile
# BAD — copies all source first, invalidates go mod cache on any code change
COPY . .
RUN go mod download
RUN go build -o /app .

# GOOD — dependencies cached unless go.sum changes
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /app .
```

**Missing CA certificates in distroless/scratch:**
```dockerfile
FROM scratch
COPY --from=builder /app /app
# PROBLEM: app making HTTPS calls fails — no /etc/ssl/certs
# FIX option 1: copy certs from builder
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# FIX option 2: use distroless/base instead of scratch
FROM gcr.io/distroless/base-debian12
COPY --from=builder /app /app
```

**Timezone data missing:**
```dockerfile
# App using time.LoadLocation("America/New_York") panics in scratch/distroless/static
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
# or use distroless/base which includes tzdata
```

---

## 12. Secret Leaks in Image Layers

Every `RUN` command that writes a file and every `ENV` creates a layer. Even if you delete a file in a later layer, it is permanently readable in the earlier layer's blob.

```dockerfile
# CATASTROPHIC — AWS key baked into layer forever
RUN aws s3 cp s3://my-bucket/config.yaml /app/config.yaml  # uses ambient creds or...
ENV AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE  # baked in every image pushed

# WRONG — delete in later layer doesn't help
RUN echo "secretpassword" > /tmp/secret && \
    do-something-with /tmp/secret
RUN rm /tmp/secret   # still in previous layer's filesystem snapshot
```

```dockerfile
# CORRECT — use BuildKit secret mounts (never written to any layer)
# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) \
    npm ci

# Build:
docker build --secret id=npm_token,src=~/.npmrc .
```

```dockerfile
# CORRECT — SSH agent forwarding for private git repos
# syntax=docker/dockerfile:1
FROM golang:1.22 AS builder
RUN --mount=type=ssh \
    go get github.com/myorg/private-module@v1.2.3

# Build:
docker build --ssh default .
```

**Audit an existing image for secrets:**
```bash
# Inspect all layers for secret patterns
docker save myimage:latest | tar -xO | \
  strings | grep -iE 'AKIA|password|secret|token|BEGIN.*KEY'

# Use dive to inspect layer-by-layer
dive myimage:latest

# Use trivy to scan for exposed secrets
trivy image --scanners secret myimage:latest
```

---

## 13. Distroless and Scratch — Production Hardening

Distroless images contain only the application and its runtime dependencies — no shell, no package manager, no debug tools. This is the correct production posture.

```dockerfile
# Go — fully static binary, use scratch
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0: no libc dependency; -ldflags="-w -s": strip debug info
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-w -s" \
    -trimpath \
    -o /app/server .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/server /server
USER 65534:65534   # nobody
EXPOSE 8080
ENTRYPOINT ["/server"]
```

```dockerfile
# Java — use distroless/java
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM gcr.io/distroless/java21-debian12
COPY --from=builder /app/target/app.jar /app.jar
USER nonroot
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

```dockerfile
# Python — use distroless/python
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM gcr.io/distroless/python3-debian12
COPY --from=builder /install /usr/local
COPY --from=builder /app /app
WORKDIR /app
USER nonroot
CMD ["main.py"]
```

**Debugging distroless in production:**
```bash
# No shell inside distroless — use ephemeral debug containers
kubectl debug -it <pod> \
  --image=gcr.io/distroless/base:debug \   # debug variant has busybox shell
  --target=<container>

# OR use a sidecar debug container
kubectl debug <pod> \
  --image=nicolaka/netshoot \
  --copy-to=debug-pod \   # creates a copy of the pod with the debug container
  -it -- bash
```

**Distroless variants:**

| Image | Use case | Shell |
|---|---|---|
| `distroless/static` | Static binaries (Go, Rust) | No |
| `distroless/base` | Dynamic linking (libc) | No |
| `distroless/java21` | JVM apps | No |
| `distroless/python3` | Python apps | No |
| `distroless/static:debug` | Any — debug variant | busybox via `sh` |
| `scratch` | Fully static, minimal attack surface | No |

---

## 14. Image Layer Squashing and Size Optimization

```bash
# Inspect image layers and their sizes
docker history myimage:latest --no-trunc
docker image inspect myimage:latest | jq '.[0].RootFS.Layers | length'

# Analyze with dive
dive myimage:latest
# Shows: layer sizes, what each layer adds, wasted space (files modified/deleted)
```

**Common size culprits and fixes:**

```dockerfile
# BAD: separate RUN commands = separate layers, apt cache stays
RUN apt-get update
RUN apt-get install -y curl wget git
RUN rm -rf /var/lib/apt/lists/*   # only cleans the LAST layer; update+install layers still fat

# GOOD: single RUN = single layer, cache cleaned in same layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl wget && \
    rm -rf /var/lib/apt/lists/*
```

```dockerfile
# BAD: build tools left in final image
FROM ubuntu:22.04
RUN apt-get install -y gcc make libssl-dev
COPY . .
RUN make build
# gcc, make, libssl-dev all in final image — hundreds of MB wasted

# GOOD: builder stage isolates build tools
FROM ubuntu:22.04 AS builder
RUN apt-get install -y gcc make libssl-dev
COPY . .
RUN make build

FROM ubuntu:22.04
COPY --from=builder /app/binary /app/binary
# gcc/make/libssl-dev never in final image
```

**Minimizing node_modules:**
```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production   # no devDependencies

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/main.js"]
```
