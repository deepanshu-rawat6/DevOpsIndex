# Linux Signals

A signal is a software interrupt sent to a process by the kernel or another process. It's the primary mechanism for async process notification.

Track how many knowledge checks you clear as you go:

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Common Signals

| Signal | Number | Default action | Meaning |
|--------|--------|---------------|---------|
| `SIGHUP` | 1 | Terminate | Terminal hangup; used to reload config |
| `SIGINT` | 2 | Terminate | Keyboard interrupt (Ctrl+C) |
| `SIGQUIT` | 3 | Core dump | Quit with core dump (Ctrl+\\) |
| `SIGKILL` | 9 | Terminate | **Uncatchable.** Kernel kills immediately |
| `SIGUSR1` | 10 | Terminate | User-defined signal 1 |
| `SIGUSR2` | 12 | Terminate | User-defined signal 2 |
| `SIGPIPE` | 13 | Terminate | Write to broken pipe |
| `SIGTERM` | 15 | Terminate | Polite termination request (catchable) |
| `SIGCHLD` | 17 | Ignore | Child process stopped or terminated |
| `SIGSTOP` | 19 | Stop | **Uncatchable.** Pause process |
| `SIGCONT` | 18 | Continue | Resume stopped process |
| `SIGSEGV` | 11 | Core dump | Segmentation fault (invalid memory) |
| `SIGBUS` | 7 | Core dump | Bus error (misaligned memory access) |

---

## SIGTERM vs SIGKILL

```mermaid
flowchart LR
    KILL_15["kill -15 (SIGTERM)"] --> HANDLER["process signal handler runs<br/>flush, cleanup, graceful shutdown"]
    HANDLER --> EXIT["process exits cleanly"]

    KILL_9["kill -9 (SIGKILL)"] --> KERNEL["kernel removes process<br/>NO handler runs"]
    KERNEL --> DEAD["process gone immediately<br/>in-flight I/O dropped<br/>files not flushed"]
```

**Rule:** Always try SIGTERM first. Give 30s. Then SIGKILL.

```bash
kill -15 <pid>      # SIGTERM — ask politely
sleep 30
kill -9 <pid>       # SIGKILL — force if still alive

# One-liner grace period
kill -15 <pid> && sleep 30 && kill -9 <pid> 2>/dev/null
```

**Why SIGKILL can't be caught:**
SIGKILL and SIGSTOP are handled entirely by the kernel scheduler — the process never gets CPU time to run a handler. This is intentional: it guarantees a way to always terminate a hung process.

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="sigterm" class="active state-ok">SIGTERM</button>
    <button data-toggle-opt="sigkill" class="state-bad">SIGKILL</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="sigterm">
    Delivered to the process like any other signal. If a handler is installed, it runs in user space &mdash; flush buffers, close connections, save state &mdash; and the process decides when to exit. Catchable, blockable, ignorable.
  </div>
  <div class="toggle-panel" data-toggle-panel="sigkill">
    Never delivered to the process at all. The kernel scheduler removes it directly &mdash; no handler runs, in-flight I/O is dropped, nothing gets flushed. Can't be caught, blocked, or ignored.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A process installs a handler for SIGTERM that catches the signal but never calls exit. You send it SIGTERM again. Does that force it to stop — and if not, what will?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. SIGTERM is catchable, so a process that installs a handler decides for itself whether and when to exit &mdash; sending it again just runs the handler again (or does nothing if it's already mid-handler). Only SIGKILL forces termination, because SIGKILL and SIGSTOP are handled entirely by the kernel scheduler and never reach a user-space handler at all.
  </div>
</div>

---

## Signal Handling Internals

```mermaid
sequenceDiagram
    participant K as Kernel
    participant P as Process

    K->>P: deliver signal (set bit in pending mask)
    Note over P: signal is PENDING
    P->>K: syscall returns (or preemption)
    K->>K: check pending & ~blocked mask
    K->>P: redirect execution to signal handler
    P->>P: handler runs in user space
    P->>K: sigreturn() — restore original context
    P->>P: continues from where it was
```

**When is a signal delivered?**
A signal becomes pending when sent. It's delivered when the process next transitions from kernel space to user space (syscall return or interrupt return). A sleeping process (in `select`, `read`, etc.) is woken up early — the syscall returns `EINTR`.

<div class="quiz-card">
  <p class="quiz-q">A process is blocked inside a <code>read()</code> syscall when SIGTERM arrives. Does the signal handler run the instant the signal is sent?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. The signal only becomes <strong>pending</strong> the instant it's sent &mdash; it isn't <strong>delivered</strong> until the process next crosses from kernel space back to user space. A process sleeping in a syscall like <code>read()</code> is woken up early specifically to make that transition happen: the syscall returns <code>EINTR</code>, the handler runs, then execution resumes.
  </div>
</div>

---

## Signal Masks

A process can **block** signals (add to the signal mask). Blocked signals stay pending until unblocked.

```bash
# View current signal masks for a process
cat /proc/1234/status | grep Sig
# SigBlk: 0000000000000000  ← blocked signals (bitmask, each bit = signal number)
# SigIgn: 0000000000001000  ← ignored (bit 12 = SIGPIPE ignored)
# SigCgt: 0000000180000000  ← caught (has handler installed)
# SigPnd: 0000000000000000  ← pending (sent but not yet delivered)

# Decode bitmask: bit N = signal N+1
# 0x1000 = bit 12 = signal 13 = SIGPIPE
python3 -c "mask=0x1000; [print(i+1) for i in range(64) if mask & (1<<i)]"
```

**In Go:**
```go
// Go runtime installs handlers for SIGSEGV, SIGBUS, SIGFPE
// and blocks SIGPROF for its own GC/scheduler use.
// To handle SIGTERM:
ch := make(chan os.Signal, 1)
signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
<-ch  // block until signal
// do cleanup
```

<div class="quiz-card">
  <p class="quiz-q">A process blocks SIGTERM while it's mid critical-section. Someone sends SIGTERM during that window. Is the signal lost?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. A blocked signal stays <strong>pending</strong> (visible in <code>SigPnd</code>) until the process unblocks it &mdash; the kernel doesn't drop it. As soon as the mask no longer blocks it, it's delivered. The one exception: SIGKILL and SIGSTOP can't be added to the mask at all, so they're never delayed this way.
  </div>
</div>

---

## SIGCHLD and Zombie Processes

When a child process exits, the kernel sends SIGCHLD to the parent. The parent must call `wait()` or `waitpid()` to collect the exit status — only then is the zombie reaped.

```mermaid
stateDiagram-v2
    [*] --> Running: fork()
    Running --> Zombie: process exits (all memory freed except PID entry)
    Zombie --> [*]: parent calls wait() — entry removed from process table
    Running --> Zombie: SIGCHLD sent to parent
```

```bash
# Default: SIGCHLD is ignored → parent never calls wait() → zombies accumulate
# Fix: explicitly handle SIGCHLD
# In shell scripts:
trap 'wait' SIGCHLD

# In C: use SA_NOCLDWAIT flag or signal(SIGCHLD, SIG_DFL) with waitpid
# In Go: os/exec.Cmd.Wait() handles this automatically
```

<div class="quiz-card">
  <p class="quiz-q">You send SIGKILL to a zombie process's PID to try to clean it up. Does that work?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. A zombie has already exited &mdash; all its memory is freed and it isn't scheduled, so there's no running process left to receive or act on a signal. Only its parent calling <code>wait()</code>/<code>waitpid()</code> (or the parent dying, which reparents it so init can reap it) removes its entry from the process table.
  </div>
</div>

---

## Graceful Shutdown Pattern (Go)

```go
func main() {
    srv := &http.Server{Addr: ":8080"}

    go srv.ListenAndServe()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    srv.Shutdown(ctx)  // waits for in-flight requests, then stops
}
```

**Kubernetes graceful shutdown sequence:**
1. Pod gets SIGTERM (from `terminationGracePeriodSeconds` countdown start)
2. App starts draining (stop accepting, finish in-flight)
3. After `terminationGracePeriodSeconds` (default 30s) → SIGKILL
4. Set `preStop` hook if you need extra time before SIGTERM

Step through the same sequence:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. SIGTERM sent.</strong> Kubernetes sends SIGTERM to the pod's PID 1 the moment it starts terminating &mdash; this is also when the <code>terminationGracePeriodSeconds</code> countdown starts.
    </div>
    <div class="stepper-panel">
      <strong>2. App drains.</strong> The SIGTERM handler stops accepting new work and finishes in-flight requests &mdash; <code>srv.Shutdown(ctx)</code> in the Go example above.
    </div>
    <div class="stepper-panel">
      <strong>3. Grace period expires.</strong> If the app hasn't exited by the end of <code>terminationGracePeriodSeconds</code> (default 30s), Kubernetes sends SIGKILL &mdash; unconditionally, whether or not draining finished.
    </div>
    <div class="stepper-panel">
      <strong>4. Optional: preStop hook.</strong> Runs before SIGTERM is sent, if configured &mdash; use it when you need extra lead time, e.g. letting kube-proxy remove the pod from service endpoints before traffic actually stops arriving.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Your app takes 45 seconds to drain in-flight requests, but <code>terminationGracePeriodSeconds</code> is left at its default. What happens?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The default grace period is 30s. Kubernetes sends SIGKILL at the 30s mark regardless of whether draining finished &mdash; your app is killed mid-drain, dropping the remaining 15 seconds of in-flight work. Fix it by raising <code>terminationGracePeriodSeconds</code> to comfortably exceed the actual drain time, not by assuming the platform will wait for you.
  </div>
</div>

---

## Sending Signals

```bash
kill -TERM <pid>         # by PID
kill -9 <pid>            # SIGKILL
killall -TERM nginx       # by name (all matching)
pkill -TERM -u www-data   # by user
pkill -f "python app.py"  # match full command line

# Send to process group (all children too)
kill -TERM -<pgid>

# Check what signals a process handles
kill -0 <pid>            # test if process exists (no signal sent)
```

---

## Signal Tracing with strace

```bash
# Watch signals being received
strace -e signal -p 1234

# Output example:
# --- SIGTERM {si_signo=SIGTERM, si_code=SI_USER, si_pid=5678} ---
# rt_sigreturn()  = 0
```

---

## Signal Forwarding and PID 1 in Containers

This is one of the most common sources of "pod won't terminate gracefully" bugs in production.

### The PID 1 problem

In a container, PID 1 has special responsibilities:
1. It receives all signals sent by the container runtime (Docker, containerd)
2. It must reap zombie child processes (call `waitpid`)
3. If PID 1 exits, the entire container exits

When you write a Dockerfile with shell-form CMD, `/bin/sh` becomes PID 1:

```mermaid
sequenceDiagram
    participant CR as Container runtime
    participant P1 as PID 1 (/bin/sh -c ...)
    participant P2 as PID 2 (java -jar app.jar)

    CR->>P1: SIGTERM
    Note over P1: shell doesn't forward signals to children by default
    Note over P2: never receives SIGTERM
```

The shell receives SIGTERM but doesn't forward it to the child by default. The child (your app) never gets SIGTERM. Kubernetes waits `terminationGracePeriodSeconds`, then sends SIGKILL to PID 1 (the shell), which kills the entire process group. Your app gets SIGKILL with no chance to flush, drain connections, or save state.

### Shell form vs exec form

```dockerfile
# SHELL FORM — do not use for the main process
# /bin/sh -c is PID 1; your app is a child
CMD java -jar app.jar
CMD ["sh", "-c", "java -jar app.jar"]

# EXEC FORM — your app IS PID 1, receives signals directly
CMD ["java", "-jar", "app.jar"]
ENTRYPOINT ["java", "-jar", "app.jar"]

# How to check: inspect the image
docker inspect <image> | jq '.[0].Config.Cmd'
# Exec form: ["java","-jar","app.jar"]
# Shell form: ["/bin/sh","-c","java -jar app.jar"]
```

<div class="quiz-card">
  <p class="quiz-q">Your Dockerfile uses <code>CMD java -jar app.jar</code> (shell form) and <code>kubectl delete pod</code> sends SIGTERM. Does your app get a chance to shut down gracefully?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No, not by default. Shell form makes <code>/bin/sh -c "..."</code> PID 1; your app is just its child. The shell receives SIGTERM but doesn't forward it, so the app never sees it. Kubernetes waits out <code>terminationGracePeriodSeconds</code>, then sends SIGKILL to PID 1 (the shell), which kills the whole process group &mdash; your app dies with SIGKILL, not SIGTERM, with no chance to flush or drain.
  </div>
</div>

### Shell wrapper with exec (when you need a startup script)

Sometimes you need a wrapper script for env var expansion, secret injection, or pre-flight checks. Use `exec` to replace the shell:

```bash
#!/bin/sh
# entrypoint.sh

# Do pre-flight setup
export DB_URL="postgresql://${DB_HOST}:5432/${DB_NAME}"
echo "Starting app, DB_URL=$DB_URL"

# exec REPLACES the shell with the app process
# app becomes PID 1 and receives signals directly
exec java \
  -Xmx${JAVA_MAX_HEAP:-512m} \
  -jar /app/app.jar \
  "$@"          # pass through any CMD arguments
```

```dockerfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["--config", "/etc/app/config.yaml"]
```

Without `exec`, the shell stays as PID 1 and your app is still a child.

### tini — minimal init for containers

tini is a tiny but correct init that:
- Registers signal handlers and forwards all signals to its child
- Reaps zombie processes (`SIGCHLD` + `waitpid`)
- Is transparent to the application

```dockerfile
# Option 1: Install tini directly
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["java", "-jar", "app.jar"]

# Option 2: Copy tini binary from official image
FROM tini:latest AS tini
FROM debian:bookworm-slim
COPY --from=tini /tini /tini
ENTRYPOINT ["/tini", "--"]
CMD ["java", "-jar", "app.jar"]

# Option 3: Docker built-in --init flag (adds tini automatically)
docker run --init myimage
# Or in compose:
# services:
#   app:
#     init: true
```

```mermaid
sequenceDiagram
    participant CR as Container runtime
    participant T as PID 1 (tini)
    participant P as PID 2 (java -jar app.jar)

    CR->>T: SIGTERM
    T->>P: forwards SIGTERM
    Note over P: shutdown hooks run — flush, drain, exit cleanly
    P-->>T: exits
    T-->>CR: tini exits, container terminates
```

Step through the same flow:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Container runtime sends SIGTERM.</strong> Docker/containerd/Kubernetes only ever signals PID 1 inside the container &mdash; it has no idea any other process exists in there.
    </div>
    <div class="stepper-panel">
      <strong>2. tini (PID 1) receives it.</strong> tini's whole job is registering handlers for every signal and forwarding them &mdash; it does nothing else on the way through.
    </div>
    <div class="stepper-panel">
      <strong>3. tini forwards SIGTERM to the app (PID 2).</strong> This is the step a bare shell-form CMD skips &mdash; <code>/bin/sh</code> doesn't forward signals to its child by default.
    </div>
    <div class="stepper-panel">
      <strong>4. App runs its shutdown hooks.</strong> Same as any direct SIGTERM handler: stop accepting requests, drain in-flight work, flush buffers, exit cleanly.
    </div>
    <div class="stepper-panel">
      <strong>5. tini reaps and exits.</strong> Once the app process is gone, tini (still PID 1) exits too, and the container terminates &mdash; no zombies left behind, because tini also handles <code>waitpid()</code> along the way.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

### dumb-init — alternative to tini

```dockerfile
RUN wget -O /usr/bin/dumb-init \
  https://github.com/Yelp/dumb-init/releases/download/v1.2.5/dumb-init_1.2.5_x86_64 \
  && chmod +x /usr/bin/dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["python", "-m", "myapp"]

# dumb-init with setsid (creates new process group):
ENTRYPOINT ["/usr/bin/dumb-init", "--setsid", "--"]
# Useful when your app spawns children that also need to receive signals
```

**tini vs dumb-init:**
Both do the same job. tini is included in Docker Engine and is the more widely recommended option. dumb-init is simpler (single Go binary). Choose based on what's already in your base image.

### Docker STOPSIGNAL

By default, `docker stop` / `kubectl delete pod` sends `SIGTERM` to PID 1. You can override this:

```dockerfile
# Send SIGQUIT instead of SIGTERM for graceful nginx shutdown
# nginx uses SIGQUIT for graceful drain (finish in-flight requests)
# SIGTERM to nginx causes immediate close without draining
STOPSIGNAL SIGQUIT

# Common per-app signals:
# nginx:        SIGQUIT (graceful), SIGTERM (fast stop)
# gunicorn:     SIGTERM (graceful), SIGQUIT (graceful with timeout)
# unicorn:      SIGUSR1 (reopen logs), SIGWINCH (graceful worker stop)
# PostgreSQL:   SIGTERM (smart shutdown), SIGINT (fast shutdown)
```

```yaml
# Override in Kubernetes pod spec (takes precedence over Dockerfile STOPSIGNAL)
spec:
  containers:
    - name: nginx
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "nginx -s quit; while killall -0 nginx; do sleep 1; done"]
      # SIGQUIT will be sent after preStop completes
```

<div class="quiz-card">
  <p class="quiz-q">You run <code>docker stop</code> on a plain nginx container with no <code>STOPSIGNAL</code> override. Does nginx drain in-flight requests before it exits?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. <code>docker stop</code> defaults to sending SIGTERM, but nginx treats SIGTERM as a fast, immediate close &mdash; it's SIGQUIT that tells nginx to finish in-flight requests before shutting down. Without <code>STOPSIGNAL SIGQUIT</code> (or an equivalent preStop hook), the default signal produces the opposite of a graceful drain.
  </div>
</div>

### Verifying graceful shutdown works

```bash
# 1. Check what PID 1 is in your container
kubectl exec <pod> -- ps -p 1
# Should NOT be "sh" or "bash"

# 2. Check signal handlers registered by the process
kubectl exec <pod> -- cat /proc/1/status | grep Sig
# SigCgt (caught signals) should include bit 15 (SIGTERM = bit 14, 0-indexed)
python3 -c "mask=0x...; print([i+1 for i in range(64) if mask&(1<<i)])"

# 3. Test graceful shutdown manually
kubectl exec <pod> -- kill -TERM 1   # send SIGTERM to PID 1
kubectl logs <pod> -f                # watch for graceful shutdown logs
# Should see: "received shutdown signal, draining..." type messages
# Should NOT see: sudden cut-off with no cleanup messages

# 4. Measure actual shutdown time vs terminationGracePeriodSeconds
kubectl get pod <pod> -o json | jq '.spec.terminationGracePeriodSeconds'
# If your app takes 10s to drain, this must be > 10s (recommend 2-3x actual drain time)
```

### Complete graceful shutdown checklist

```
Dockerfile:
  ✓ CMD in exec form (not shell form)
  ✓ ENTRYPOINT is app or tini/dumb-init (not /bin/sh -c)
  ✓ STOPSIGNAL set if app uses non-SIGTERM signal

Kubernetes:
  ✓ terminationGracePeriodSeconds ≥ preStop duration + actual drain time
  ✓ preStop: sleep 5 (gives kube-proxy time to drain the pod from endpoints)
  ✓ readinessProbe fails fast on shutdown start (pod removed from endpoints faster)

Application:
  ✓ SIGTERM handler registered
  ✓ Handler: stop accepting new requests
  ✓ Handler: wait for in-flight requests to complete
  ✓ Handler: flush buffers (logs, metrics, traces)
  ✓ Handler: close DB connections
  ✓ Handler: exit(0)
```
