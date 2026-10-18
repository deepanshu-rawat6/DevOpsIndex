# Docker Daemon Configuration

`dockerd` reads `/etc/docker/daemon.json` at startup. Most settings require a daemon restart (`systemctl restart docker`) to take effect — with one key exception (`live-restore`). Use `docker info` to verify the running configuration, and `dockerd --validate` to syntax-check before restarting.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. daemon.json Reference

A fully-annotated example covering the settings you'll actually configure in production:

```json
{
  "storage-driver": "overlay2",

  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  },

  "default-runtime": "runc",
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  },
  "exec-opts": ["native.cgroupdriver=systemd"],

  "insecure-registries": [],
  "registry-mirrors": [],
  "max-concurrent-downloads": 10,
  "max-concurrent-uploads": 5,

  "live-restore": true,

  "metrics-addr": "127.0.0.1:9323",
  "experimental": false,
  "debug": false,

  "userns-remap": "",
  "no-new-privileges": false,

  "data-root": "/var/lib/docker"
}
```

After editing:

```bash
# Validate syntax before restarting
dockerd --validate --config-file /etc/docker/daemon.json

# Restart the daemon
sudo systemctl restart docker

# Confirm settings applied
docker info
```

---

## 2. Storage Driver

The storage driver controls how image layers are stored and the container writable layer is managed.

```bash
# Check the current storage driver
docker info | grep "Storage Driver"
```

**overlay2** (default since Docker 18.09) is the right choice for all modern Linux kernels (≥ 4.0). It uses the kernel's native OverlayFS — no extra daemons, no kernel modules, and better performance than the alternatives.

| Driver | Status | Notes |
|--------|--------|-------|
| `overlay2` | ✅ Default | Use this. Requires kernel 4.0+ and an xfs/ext4 data root |
| `devicemapper` | ⚠️ Legacy | Required Docker CE 17.x era. Needs loop-lvm (bad for prod) or direct-lvm config. Avoid. |
| `btrfs` | Niche | Use if your data-root is on a btrfs filesystem and you want snapshotting at the FS level |
| `zfs` | Niche | Use if data-root is on ZFS. Requires `zfs-dkms` package |

**Changing the storage driver wipes existing images and containers** — all layers are driver-specific. Migrate to overlay2 on a fresh host or after backing up container data.

<div class="quiz-card"><p class="quiz-q">You change <code>storage-driver</code> from <code>overlay2</code> to <code>btrfs</code> and restart Docker. What happens to your existing images?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>They become inaccessible. Image layers are stored in a driver-specific format under <code>/var/lib/docker/</code>. Switching drivers means Docker starts with an empty image cache — you need to pull all images again. Your named volumes are unaffected because they live outside the storage driver's tree.</div></div>

---

## 3. Log Drivers

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="jsonfile" class="active">json-file</button>
    <button data-tab="journald">journald</button>
    <button data-tab="fluentd">fluentd</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="jsonfile">
      <p><strong>Default driver.</strong> Container stdout/stderr are written to JSON files at <code>/var/lib/docker/containers/&lt;id&gt;/&lt;id&gt;-json.log</code>.</p>
      <pre><code>{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}</code></pre>
      <p><strong>max-size</strong> — rotate when a log file reaches this size. <strong>max-file</strong> — keep this many rotated files. With the above settings, max disk usage per container is 300 MB.</p>
      <p><strong>Pros:</strong> <code>docker logs</code> works. Logs survive container restarts. Simple to debug.</p>
      <p><strong>Cons:</strong> Without rotation options, logs grow without bound. Rotation is not compressed — raw JSON. No central aggregation without a log shipper (Filebeat, Promtail) reading from the host paths.</p>
    </div>
    <div class="tab-panel" data-tab-panel="journald">
      <p><strong>Forwards container logs to systemd's journal.</strong> No files written in Docker's directory.</p>
      <pre><code>{
  "log-driver": "journald"
}</code></pre>
      <p>Read logs via:</p>
      <pre><code># By container name
journalctl CONTAINER_NAME=myapp

# By container ID
journalctl CONTAINER_ID=abc123

# Follow live
journalctl -f CONTAINER_NAME=myapp</code></pre>
      <p><strong>Pros:</strong> Inherits journald's built-in rotation, compression, and rate-limiting. Good for systemd-managed hosts where you're already reading other service logs via journald.</p>
      <p><strong>Cons:</strong> <code>docker logs</code> still works, but only retrieves logs from the journal — if the journal is rotated, older entries are gone from <code>docker logs</code> too. Not portable to non-systemd hosts.</p>
    </div>
    <div class="tab-panel" data-tab-panel="fluentd">
      <p><strong>Ships logs directly to Fluentd or Fluent Bit.</strong> Docker does not buffer to disk — log delivery is synchronous.</p>
      <pre><code>{
  "log-driver": "fluentd",
  "log-opts": {
    "fluentd-address": "localhost:24224",
    "fluentd-async": "true",
    "tag": "docker.{{.Name}}"
  }
}</code></pre>
      <p><strong>fluentd-async: true</strong> — buffer locally if Fluentd is unreachable instead of blocking container I/O. Use this in production.</p>
      <p><strong>Trade-off: <code>docker logs</code> stops working.</strong> Once you switch to fluentd, container logs are sent directly to the Fluentd endpoint and not stored locally. You can only read them from whatever Fluentd forwards to (Elasticsearch, Loki, S3).</p>
      <p><strong>Use case:</strong> Production environments with a centralized logging pipeline where you don't want local log files consuming disk.</p>
    </div>
  </div>
</div>

---

## 4. Runtime Configuration

```json
{
  "default-runtime": "runc",
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    },
    "kata": {
      "path": "/usr/bin/kata-runtime",
      "runtimeArgs": []
    }
  },
  "exec-opts": ["native.cgroupdriver=systemd"]
}
```

**`default-runtime`** — the OCI runtime used when no `--runtime` flag is specified. `runc` is the standard. `crun` (written in C, faster startup) is a drop-in replacement.

**`runtimes`** — register additional runtimes. Use them per-container:
```bash
# Use NVIDIA runtime for GPU workloads
docker run --runtime=nvidia --gpus all cuda-app

# Use Kata containers for hardware isolation
docker run --runtime=kata secure-workload
```

**`exec-opts: native.cgroupdriver=systemd`** — this is critical if you're running Kubernetes on this host. Kubernetes (kubelet) defaults to the `systemd` cgroup driver. If Docker uses `cgroupfs` while kubelet uses `systemd`, you get split cgroup hierarchies which break pod resource accounting and eviction. Always set `systemd` on K8s hosts.

```bash
# Verify after restart
docker info | grep -i cgroup
# Should show: Cgroup Driver: systemd
```

---

## 5. Registry Configuration

```json
{
  "insecure-registries": ["registry.internal:5000", "10.0.0.10:5000"],
  "registry-mirrors": ["https://mirror.gcr.io", "https://registry-1.docker.io"],
  "max-concurrent-downloads": 10,
  "max-concurrent-uploads": 5
}
```

**`insecure-registries`** — allow Docker to pull from registries using HTTP or self-signed TLS without certificate validation. Needed for private registries on internal networks. Never list public registries here.

**`registry-mirrors`** — pull-through cache for Docker Hub. When you `docker pull nginx`, Docker tries the mirror first. If the mirror has it cached, you get the image faster and don't count against Docker Hub's rate limits (100 pulls/6h for unauthenticated, 200 for free accounts).

**`max-concurrent-downloads`** — number of image layers pulled in parallel. Default is 3. Increase to 10 on nodes with high bandwidth to speed up initial image pulls during cluster provisioning.

<div class="quiz-card"><p class="quiz-q">Your CI runners are hitting Docker Hub rate limits (429 Too Many Requests). What's the fastest fix that doesn't require changing the registry?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>Add a pull-through mirror to <code>registry-mirrors</code> in daemon.json. GCR's public mirror (<code>https://mirror.gcr.io</code>) caches Docker Hub images and is not subject to Docker Hub's rate limits. Alternatively, configure Docker Hub authentication in the daemon — authenticated pulls get a 200/6h limit instead of 100/6h.</div></div>

---

## 6. Live Restore

```json
{
  "live-restore": true
}
```

With `live-restore: true`, running containers continue running when the Docker daemon is restarted or upgraded. Without it, `systemctl restart docker` stops all containers.

```bash
# Upgrade Docker without downtime
sudo apt-get install docker-ce docker-ce-cli  # install new version
sudo systemctl restart docker                  # containers stay running
```

**Limitations:**
- Containers that need to apply kernel-level settings (new seccomp profile, added capabilities) must be restarted manually — live-restore can't retrofit those.
- Networking changes (new bridge options, `--dns` changes) apply only to new containers.
- Not compatible with `userns-remap` changes — those require a full container restart.

**Verify it worked:**
```bash
docker inspect <container_id> | jq '.[0].State.Running'
# Should return true after daemon restart
```

---

## 7. Metrics and Debug

```json
{
  "metrics-addr": "127.0.0.1:9323",
  "experimental": false,
  "debug": false
}
```

**`metrics-addr`** — exposes a Prometheus-compatible `/metrics` endpoint on the specified address. Includes:
- `engine_daemon_container_actions_seconds` — time spent on container operations
- `engine_daemon_image_actions_seconds` — image pull/push timing
- `go_goroutines` — number of goroutines in the daemon

Scrape it from Prometheus:
```yaml
- job_name: docker
  static_configs:
    - targets: ['localhost:9323']
```

**`debug: true`** — enables verbose logging in journald (`journalctl -u docker -f`). Logs every API call and internal state transition. Only enable when diagnosing a specific issue — it's extremely noisy.

**`experimental: true`** — enables features under active development. Some features start experimental and graduate to stable (e.g., BuildKit, rootless Docker improvements). Check the Docker release notes before enabling in production.

---

## 8. Security Defaults

```json
{
  "userns-remap": "default",
  "no-new-privileges": false,
  "seccomp-profile": "/etc/docker/seccomp.json"
}
```

**`userns-remap: "default"`** — enables user namespace remapping. Container UID 0 maps to an unprivileged host UID (e.g., 165536). A container breakout lands as an unprivileged user on the host instead of root. `"default"` creates a `dockremap` user and subuid/subgid ranges automatically.

**Conflict:** `userns-remap` breaks containers that use `--privileged`, volume mounts of `/proc` or `/sys`, and some Docker-in-Docker setups. Test before enabling on existing hosts.

**`no-new-privileges: true`** — applies `PR_SET_NO_NEW_PRIVS` to all containers via the daemon, equivalent to `--security-opt=no-new-privileges` on every `docker run`. Prevents privilege escalation via setuid binaries inside containers (e.g., `sudo`).

**`seccomp-profile`** — apply a custom seccomp profile to all containers. Docker ships a default profile that blocks ~40 dangerous syscalls. A stricter custom profile can block additional syscalls your workloads don't need.

```bash
# See what the default profile blocks
docker run --rm alpine strace ls 2>&1 | head -5
# Or inspect the built-in profile
docker info | grep Seccomp
```

<div class="quiz-card"><p class="quiz-q">You enable <code>userns-remap: "default"</code> and find that your Postgres container's volume data is now inaccessible (permission denied). Why?</p><button class="quiz-reveal">Reveal answer</button><div class="quiz-a" hidden>User namespace remapping shifts the UID range. The existing volume data was written by UID 0 (or UID 999 for the postgres user), but with userns-remap enabled, the container's UIDs are remapped to a high-numbered host UID range (e.g., 165536+). The container process now runs as host UID 165536, which doesn't own the existing files. Fix: <code>chown -R 165536:165536 /var/lib/docker/volumes/pg-data</code>, or re-initialize the database.</div></div>
