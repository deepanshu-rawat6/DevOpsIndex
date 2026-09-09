# Docker Compose — Advanced Patterns

Production-grade Compose patterns beyond `docker-compose up`: correct startup
ordering with health checks, profile-based service sets, override file chaining,
resource limits that actually apply, `docker compose watch` for inner-loop
development, and CI caching strategies.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. `depends_on` with Health Checks — Correct Startup Ordering

The most common Compose mistake: `depends_on` alone does not wait for a service
to be *ready* — it waits only for the container to *start*. A database container
starting does not mean Postgres is accepting connections.

```yaml
# WRONG — app starts as soon as db container starts, not when Postgres is ready
services:
  app:
    depends_on:
      - db
  db:
    image: postgres:16
```

```yaml
# CORRECT — app waits for db's healthcheck to report healthy
services:
  app:
    image: myapp:latest
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrations:
        condition: service_completed_successfully   # one-shot init container

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_PASSWORD: secret
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s    # grace period before first check

  redis:
    image: redis:7
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 3

  migrations:
    image: myapp:latest
    command: ["python", "manage.py", "migrate"]
    depends_on:
      db:
        condition: service_healthy
    restart: "no"          # run once and exit; condition: service_completed_successfully checks exit code 0
```

**`condition` values:**

| Condition | Waits for |
|---|---|
| `service_started` | Container started (default — the wrong one for stateful services) |
| `service_healthy` | Healthcheck reports healthy |
| `service_completed_successfully` | Container exited with code 0 (for init/migration jobs) |

<div class="quiz-card">
  <p class="quiz-q">Your API service starts before Postgres finishes initialization despite `depends_on: db`. What change fixes it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Add a healthcheck to the db service and change depends_on to use `condition: service_healthy`. Without a healthcheck, `service_healthy` cannot be used and Compose falls back to `service_started`. The healthcheck must actually test connectivity (pg_isready or psql -c "select 1"), not just that the process is running. Also set start_period to give Postgres time to initialize before the first check runs, otherwise the service may fail health checks during normal initialization and Compose will restart it.</div>
</div>

---

## 2. Profiles — Environment-Specific Service Sets

Profiles let you define services that only start under specific conditions.
Without `--profile`, services with a `profiles:` key are skipped.

```yaml
services:
  # Core services (no profile = always started)
  api:
    image: myapp:latest
    ports:
      - "8080:8080"

  db:
    image: postgres:16

  # Dev-only services
  adminer:
    image: adminer
    profiles: [dev]
    ports:
      - "8081:8080"

  mailpit:
    image: axllent/mailpit
    profiles: [dev]
    ports:
      - "8025:8025"   # web UI
      - "1025:1025"   # SMTP

  # Load testing (separate profile)
  k6:
    image: grafana/k6
    profiles: [loadtest]
    command: run /scripts/load.js
    volumes:
      - ./k6:/scripts

  # Production observability
  prometheus:
    image: prom/prometheus
    profiles: [monitoring]
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
```

```bash
# Start core only
docker compose up -d

# Start core + dev tools
docker compose --profile dev up -d

# Start core + monitoring
docker compose --profile monitoring up -d

# Start core + dev + monitoring
docker compose --profile dev --profile monitoring up -d
```

---

## 3. Compose Overrides and `-f` Chaining

Compose merges multiple files, with later files overriding earlier ones. Lists
(ports, volumes, environment) append; maps (environment keys, labels) merge with
later values winning.

**Project structure:**

```
docker-compose.yml          # base definitions (always loaded)
docker-compose.override.yml # auto-loaded if present (local dev customizations)
docker-compose.prod.yml     # production overrides (explicit -f)
docker-compose.ci.yml       # CI-specific (explicit -f)
```

```yaml
# docker-compose.yml (base)
services:
  api:
    image: myapp:${TAG:-latest}
    environment:
      LOG_LEVEL: info
    restart: unless-stopped
```

```yaml
# docker-compose.override.yml (auto-loaded locally — git-ignored)
services:
  api:
    build: .                    # build locally instead of pulling image
    volumes:
      - .:/app                  # mount source for live reload
    environment:
      LOG_LEVEL: debug          # overrides base
      DEBUG: "true"             # adds new key
    ports:
      - "8080:8080"
```

```yaml
# docker-compose.prod.yml (explicit)
services:
  api:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 512M
      replicas: 3
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
```

```bash
# Production: base + prod overrides (override.yml not loaded because -f is explicit)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# CI: base + ci overrides
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d
```

**Merge semantics quick reference:**

| Field type | Merge behavior |
|---|---|
| `environment` (map) | Keys merged; later file's value wins on conflict |
| `ports` (list) | Appended; duplicates cause errors |
| `volumes` (list) | Appended |
| `command` | Later file replaces entirely |
| `image` | Later file replaces entirely |
| `build` | Later file replaces entirely |

---

## 4. `extends` — Service Inheritance

`extends` pulls a service definition from another file, giving you a base to
build on. Unlike `-f` merging (which merges all services), `extends` targets
a single service.

```yaml
# services/base.yml — shared base definitions
services:
  base-api:
    image: myapp:${TAG:-latest}
    environment:
      DATABASE_URL: postgresql://postgres:secret@db:5432/myapp
      REDIS_URL: redis://redis:6379
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```yaml
# docker-compose.yml
services:
  api:
    extends:
      file: services/base.yml
      service: base-api
    ports:
      - "8080:8080"
    environment:
      WORKER_TYPE: web

  worker:
    extends:
      file: services/base.yml
      service: base-api
    command: ["python", "-m", "celery", "worker"]
    environment:
      WORKER_TYPE: background
```

**`extends` limitations:** Cannot inherit `depends_on`, `links`, or `networks`
that reference services defined in the parent file. These are service-graph
relationships that only make sense in the context of a complete Compose project.

---

## 5. Secrets and Configs

**Secrets** (sensitive data — mounted as files in `/run/secrets/<name>`):

```yaml
services:
  api:
    image: myapp:latest
    secrets:
      - db_password
      - api_key

secrets:
  db_password:
    file: ./secrets/db_password.txt   # local dev: read from file
  api_key:
    environment: API_KEY              # from env var (Compose v2.24+)
```

Inside the container: `cat /run/secrets/db_password` reads the secret value.
The file is tmpfs-backed — it never touches disk on the container host.

**Configs** (non-sensitive configuration files — mounted read-only):

```yaml
services:
  nginx:
    image: nginx:alpine
    configs:
      - source: nginx_conf
        target: /etc/nginx/nginx.conf
        mode: 0444

configs:
  nginx_conf:
    file: ./nginx/nginx.conf
```

---

## 6. Resource Limits

Resource limits syntax changed between Compose v2 and v3, and whether they
apply depends on the deploy target:

```yaml
services:
  api:
    image: myapp:latest

    # Compose v3 with `docker compose up` (NOT docker stack deploy)
    # deploy.resources IS honored by `docker compose up` since Compose v2.x
    deploy:
      resources:
        limits:
          cpus: '1.0'        # fractional CPUs
          memory: 256M
        reservations:
          cpus: '0.25'
          memory: 64M
```

```bash
# Verify limits are applied
docker compose up -d
docker stats api_1
# CPU limit shows in cgroup:
docker inspect api_container | jq '.HostConfig | {CpuQuota, CpuPeriod, Memory}'
# CpuQuota: 100000, CpuPeriod: 100000 → 1 CPU
# Memory: 268435456 → 256 MiB
```

<div class="quiz-card">
  <p class="quiz-q">You set `deploy.resources.limits.memory: 256M` in docker-compose.yml. The container is killed with exit code 137 (OOM). What happened and how do you diagnose it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Exit code 137 = 128 + 9 (SIGKILL from OOM killer). The container exceeded the 256M cgroup memory limit; the kernel OOM killer terminated it. Diagnose with: `docker inspect <container> | jq '.State.OOMKilled'` (should show true), and check `dmesg | grep -i oom` or `journalctl -k | grep oom-kill` on the host for the kernel's OOM kill record. To fix: either increase the limit, profile memory usage with `docker stats` to find the actual peak, or instrument the app to understand what's growing (heap dump, memory profiler). If the spike is temporary (startup), add a `start_period` to the healthcheck so the container isn't killed before it finishes initializing.</div>
</div>

---

## 7. `docker compose watch` — Inner-Loop Development

`watch` syncs files or rebuilds the image in response to source changes,
without a full `docker compose up` cycle.

```yaml
services:
  api:
    build: .
    ports:
      - "8080:8080"
    develop:
      watch:
        # Sync Python source files without rebuild (app hot-reloads)
        - action: sync
          path: ./src
          target: /app/src
          ignore:
            - __pycache__/
            - "*.pyc"

        # Rebuild image and recreate container when deps change
        - action: rebuild
          path: ./requirements.txt

        # Sync + restart (for config files that need process restart)
        - action: sync+restart
          path: ./config
          target: /app/config
```

```bash
docker compose watch
# Watching: src/, requirements.txt, config/
# Modified src/api.py — syncing to container
# Modified requirements.txt — rebuilding api service
```

**`action` types:**

| Action | What happens |
|---|---|
| `sync` | File copied into container (requires app to hot-reload, e.g. uvicorn --reload) |
| `rebuild` | Full image rebuild + container recreate |
| `sync+restart` | Sync file then `docker compose restart` the service |

---

## 8. Compose in CI

**Socket mount (simpler, host-dependent):**

```yaml
# ci/docker-compose.yml
services:
  tests:
    build:
      context: .
      dockerfile: Dockerfile.test
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # DinD alternative; uses host Docker
    environment:
      - DOCKER_HOST=unix:///var/run/docker.sock
```

**DinD (Docker in Docker — isolated but slow due to storage driver nesting):**

```yaml
services:
  dind:
    image: docker:24-dind
    privileged: true
    environment:
      DOCKER_TLS_CERTDIR: ""

  ci:
    image: docker:24-cli
    depends_on:
      - dind
    environment:
      DOCKER_HOST: tcp://dind:2375
    command: docker compose -f /workspace/docker-compose.yml up --exit-code-from tests
```

**BuildKit remote cache in CI** (avoids rebuilding unchanged layers):

```bash
# GitHub Actions — push/pull cache to registry
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/myorg/myapp:cache \
  --cache-to   type=registry,ref=ghcr.io/myorg/myapp:cache,mode=max \
  --tag myapp:${SHA} \
  --push .

# Or with S3 (GitLab, self-hosted)
docker buildx build \
  --cache-from type=s3,bucket=my-build-cache,region=us-east-1,name=myapp \
  --cache-to   type=s3,bucket=my-build-cache,region=us-east-1,name=myapp,mode=max \
  .
```

---

## 9. Network Isolation

Named networks create explicit subnet separation; services on different networks
cannot reach each other without an explicit bridge.

```yaml
services:
  nginx:
    image: nginx:alpine
    networks:
      - frontend      # internet-facing
    ports:
      - "80:80"

  api:
    image: myapp:latest
    networks:
      - frontend      # nginx can reach api
      - backend       # api can reach db and redis

  db:
    image: postgres:16
    networks:
      - backend       # only api can reach db; not nginx

  redis:
    image: redis:7
    networks:
      - backend

networks:
  frontend:
  backend:
```

**`external: true`** — connect to a network created outside this Compose project
(shared infrastructure, another Compose stack):

```yaml
networks:
  shared-db-network:
    external: true   # must be created before docker compose up
```

---

## Quick Reference

```
Wait for healthy before start     condition: service_healthy (requires healthcheck on dep)
Wait for init container exit 0    condition: service_completed_successfully
Start with profiles               docker compose --profile dev up -d
Merge multiple files              docker compose -f base.yml -f prod.yml up -d
Auto-merged override file         docker-compose.override.yml (git-ignore this)
Secrets mount path                /run/secrets/<name> (tmpfs-backed)
Apply resource limits             deploy.resources.limits (honored by compose up in v2.x)
Watch for changes                 docker compose watch
Rebuild on file change            action: rebuild in develop.watch
Verify OOM kill                   docker inspect <c> | jq '.State.OOMKilled'
Cache layer in CI                 --cache-from/--cache-to type=registry or type=s3
Named network isolation           separate frontend/backend networks; api on both
External shared network           external: true (must pre-exist)
```
