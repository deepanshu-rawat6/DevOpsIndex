# PostgreSQL Primary/Standby Replication & Backup on VMs

Two VMs: one **primary** (all writes) and one **warm standby** (streaming replication + backup source). This guide walks every step from bare OS to a production-ready cluster with pgBackRest PITR backups — firewall rules, `postgresql.conf`, `pg_hba.conf`, standby bootstrap, backup schedule, restore runbook, manual failover, and Prometheus monitoring. No Kubernetes, no Patroni operator.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Cluster Architecture

```mermaid
graph TD
    classDef primary fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef standby fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef backup fill:#f39c12,stroke:#d68910,color:#fff,rx:8
    classDef s3 fill:#27ae60,stroke:#1e8449,color:#fff,rx:8

    subgraph "VM 1 — Primary (10.0.0.1)"
        P["postgres :5432
PRIMARY
all writes
wal_level=replica
archive_mode=on"]:::primary
    end

    subgraph "VM 2 — Standby (10.0.0.2)"
        S["postgres :5432
hot_standby=on
read-only queries OK
pg_is_in_recovery() = t"]:::standby
        PBK["pgBackRest (postgres user)
daily cron 01:00
reads PGDATA via pg_basebackup
full + diff schedule"]:::backup
    end

    S3["S3 Bucket
pg-backups/
WAL archive + base backups
retention-full=2"]:::s3

    P -->|"WAL stream (streaming replication)"| S
    P -->|"archive_command: pgbackrest archive-push"| S3
    PBK -->|"pgbackrest backup"| S3
```

**Why warm standby without Patroni:** Patroni adds automatic failover and a DCS lock (etcd/Consul) to the stack. For smaller deployments or environments where automatic failover is too risky (split-brain), manual promotion via `pg_ctl promote` is simpler, auditable, and has no external dependencies. The on-prem-k8s/postgres.md guide covers Patroni if you need automatic failover.

---

## 1. Prerequisites

On both VMs (Ubuntu 22.04 / RHEL 9):

```bash
# Ubuntu 22.04
sudo apt install -y curl ca-certificates
curl https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update
sudo apt install -y postgresql-16 pgbackrest awscli
```

```bash
# RHEL 9 / Rocky Linux 9
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql16-server pgbackrest awscli2
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
```

| Component | Version | Notes |
|-----------|---------|-------|
| PostgreSQL | 16 | Pin with `apt-mark hold postgresql-16` |
| pgBackRest | 2.48+ | Ships in PGDG repo; supports PG 16 |
| awscli | v2 | For S3 WAL archive upload (or use wal-g) |

**Version pinning:** always pin PostgreSQL major version. pgBackRest minor version must support your PostgreSQL major version — check the [pgBackRest compatibility matrix](https://pgbackrest.org/user-guide.html).

```bash
# Ubuntu — prevent accidental upgrades
sudo apt-mark hold postgresql-16 pgbackrest
```

---

## 2. Firewall Rules

Open port 5432 between primary and standby. No external exposure needed.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="fw-ufw" class="active">ufw</button>
    <button data-tab="fw-firewalld">firewalld</button>
    <button data-tab="fw-iptables">iptables</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="fw-ufw">

```bash
# On Primary — allow standby to connect for streaming replication and pg_basebackup
ufw allow from 10.0.0.2 to any port 5432 proto tcp comment "PG standby"
ufw reload

# On Standby — allow primary to initiate connections (pgBackRest needs this too)
ufw allow from 10.0.0.1 to any port 5432 proto tcp comment "PG primary"
ufw reload
```

    </div>
    <div class="tab-panel" data-tab-panel="fw-firewalld">

```bash
# On Primary
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.2/32" port protocol="tcp" port="5432" accept'
firewall-cmd --reload

# On Standby
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.1/32" port protocol="tcp" port="5432" accept'
firewall-cmd --reload
```

    </div>
    <div class="tab-panel" data-tab-panel="fw-iptables">

```bash
# On Primary
iptables -A INPUT -s 10.0.0.2/32 -p tcp --dport 5432 -j ACCEPT
iptables-save > /etc/iptables/rules.v4

# On Standby
iptables -A INPUT -s 10.0.0.1/32 -p tcp --dport 5432 -j ACCEPT
iptables-save > /etc/iptables/rules.v4
```

    </div>
  </div>
</div>

**Connection check — before you continue:**

```bash
# From standby: must succeed before touching any config
nc -zv 10.0.0.1 5432
# → Connection to 10.0.0.1 5432 port [tcp/postgresql] succeeded!
```

---

## 3. Directory Layout

```
/var/lib/postgresql/16/main/       ← PGDATA (Ubuntu path; RHEL: /var/lib/pgsql/16/data/)
  ├── postgresql.conf               ← main config
  ├── postgresql.auto.conf          ← overrides written by ALTER SYSTEM and pg_basebackup -R
  ├── pg_hba.conf                   ← client + replication authentication
  ├── standby.signal                ← presence of this file = standby mode (PG 12+)
  ├── pg_wal/                       ← on-disk WAL segments (not archived ones)
  └── global/, base/, pg_tblspc/   ← data directories

/etc/pgbackrest.conf               ← pgBackRest stanza config (both VMs)
/var/log/pgbackrest/               ← pgBackRest logs (auto-created)
/var/log/postgresql/               ← PostgreSQL server logs
```

**PGDATA ownership:** everything under PGDATA must be owned by `postgres:postgres` with mode 700. pgBackRest runs as the `postgres` OS user — no root needed (unlike XtraBackup on MySQL). This is the key operational difference: pgBackRest uses PostgreSQL's own backup API (`pg_backup_start` / `pg_backup_stop`), not raw disk reads.

```bash
# Verify PGDATA ownership
ls -la /var/lib/postgresql/16/
# drwx------ 19 postgres postgres ... main/
```

---

## 4. Primary Setup — postgresql.conf

Edit `/etc/postgresql/16/main/postgresql.conf` (Ubuntu) or `/var/lib/pgsql/16/data/postgresql.conf` (RHEL):

```conf
# --- Replication ---
listen_addresses = '*'
wal_level = replica              # minimum for streaming replication
archive_mode = on                # enable WAL archiving (pgBackRest will archive-push)
archive_command = 'pgbackrest --stanza=mydb archive-push %p'
max_wal_senders = 5              # slots for standby connections (+ pgBackRest)
wal_keep_size = 512MB            # keep WAL on disk so standby can catch up after brief lag
hot_standby = on                 # allow read queries on standby (no effect on primary)

# --- Durability ---
synchronous_commit = on          # fsync WAL before COMMIT returns (safe default)

# --- Performance ---
shared_buffers = 4GB             # ~25% of RAM
effective_cache_size = 12GB      # ~75% of RAM (planner hint)
maintenance_work_mem = 512MB     # for VACUUM, CREATE INDEX
```

**`pg_hba.conf` — add replication entry** (append to `/etc/postgresql/16/main/pg_hba.conf`):

```
# TYPE  DATABASE        USER            ADDRESS                 METHOD
host    replication     replicator      10.0.0.2/32             scram-sha-256
```

Create the replication user (run as `postgres` on the primary):

```sql
-- psql -U postgres
CREATE USER replicator WITH REPLICATION LOGIN PASSWORD 'strong-password-here';
```

Reload to apply `pg_hba.conf` changes (no restart needed):

```bash
systemctl reload postgresql
```

---

## 5. Standby Bootstrap with pg_basebackup

Run on the **standby VM**. This seeds the standby's PGDATA from the primary and writes the recovery config automatically.

```bash
# Stop any running postgres on standby
sudo systemctl stop postgresql

# Clear existing PGDATA (Ubuntu path)
sudo rm -rf /var/lib/postgresql/16/main/*

# Bootstrap from primary as the postgres OS user
# -R: write standby.signal + primary_conninfo to postgresql.auto.conf automatically
sudo -u postgres pg_basebackup \
  -h 10.0.0.1 \
  -U replicator \
  -D /var/lib/postgresql/16/main \
  -P \
  --wal-method=stream \
  -R
# Progress: 4782/4782 kB 100%

# Start standby — it will immediately begin streaming from primary
sudo systemctl start postgresql
```

What `-R` writes to `postgresql.auto.conf`:

```conf
# Written automatically by pg_basebackup -R
primary_conninfo = 'user=replicator password=strong-password-here host=10.0.0.1 port=5432 sslmode=prefer'
```

And it creates an empty `standby.signal` file in PGDATA — PostgreSQL's signal that this instance should start in recovery/standby mode.

---

## 6. Verify Streaming Replication

On **primary** — confirm standby is connected:

```sql
-- psql -U postgres
SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- Expected output:
--  client_addr | state     | sent_lsn  | replay_lsn | replay_lag
--  10.0.0.2    | streaming | 0/5000060 | 0/5000060  | 00:00:00
```

On **standby** — confirm recovery mode:

```sql
-- psql -U postgres
SELECT pg_is_in_recovery();
-- t  ← must be true

SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();
-- Both LSNs should be equal (standby fully caught up)
```

<div class="quiz-card">
  <p class="quiz-q"><code>pg_stat_replication</code> shows <code>replay_lag = 5 minutes</code> on your standby. The <code>state</code> column shows <code>streaming</code>, so WAL is being received. What are the two most likely causes?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    <strong>1. I/O pressure on the standby VM.</strong> WAL arrives from the primary fast, but the standby's disk is slow to write and replay it. The WAL receiver buffer fills; replay falls behind. Check <code>iostat -x 1</code> on the standby — if <code>%util</code> is near 100% during replication, the disk is the bottleneck.<br><br>
    <strong>2. Recovery conflict from a long-running query on the standby.</strong> When <code>hot_standby = on</code>, a long SELECT on the standby can hold a snapshot that conflicts with WAL replay (e.g., a vacuum removing rows the query still needs). PostgreSQL will pause replay until the query finishes or <code>max_standby_streaming_delay</code> expires and it cancels the query. Check <code>pg_stat_activity</code> on the standby for queries with long <code>query_start</code> ages.
  </div>
</div>

---

## 7. pgBackRest — Stanza Configuration

Install the same `/etc/pgbackrest.conf` on **both VMs** (primary and standby). pgBackRest runs as the `postgres` OS user on both.

```ini
# /etc/pgbackrest.conf

[global]
repo1-type=s3
repo1-s3-bucket=my-pg-backups
repo1-s3-region=us-east-1
repo1-s3-key=AKIAIOSFODNN7EXAMPLE
repo1-s3-key-secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
repo1-path=/pgbackrest
repo1-retention-full=2       # keep 2 full backups (+ their WAL); older purged automatically
log-level-console=info
log-level-file=detail

[mydb]
pg1-path=/var/lib/postgresql/16/main
pg1-port=5432
```

**One-time stanza init** (run once from primary after setting `archive_command`):

```bash
sudo -u postgres pgbackrest --stanza=mydb stanza-create
# Expect: INFO: stanza-create command end: completed successfully

# Verify WAL archiving works end-to-end
sudo -u postgres pgbackrest --stanza=mydb check
# Expect: INFO: check command end: completed successfully
```

**First full backup** (takes a base snapshot — required before any diff/incr):

```bash
sudo -u postgres pgbackrest --stanza=mydb --type=full backup

# Inspect what was stored
sudo -u postgres pgbackrest --stanza=mydb info
# stanza: mydb
#     status: ok
#     full backup: 20261014-010000F
#         timestamp start/stop: 2026-10-14 01:00:00+00 / 2026-10-14 01:03:15+00
#         wal start/stop: 000000010000000000000001 / 000000010000000000000002
```

---

## 8. Backup Schedule (Cron)

`/etc/cron.d/pgbackrest`:

```
# Full backup every Sunday at 01:00
0 1 * * 0  postgres pgbackrest --stanza=mydb --type=full backup

# Differential backup Mon-Sat at 01:00 (only changed pages since last full)
0 1 * * 1-6  postgres pgbackrest --stanza=mydb --type=diff backup
```

pgBackRest logs automatically to `/var/log/pgbackrest/`. Add logrotate:

```
/var/log/pgbackrest/*.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
}
```

---

## 9. PITR Restore Runbook

Scenario: primary VM is unrecoverable. Restore to a point in time 2 minutes before the incident on a fresh or recovered VM.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Stop PostgreSQL (if running).</strong>
      <pre><code>sudo systemctl stop postgresql</code></pre>
      If the OS is gone, provision a new VM with the same PostgreSQL and pgBackRest versions first.
    </div>
    <div class="stepper-panel">
      <strong>2. Clear PGDATA.</strong>
      <pre><code>sudo rm -rf /var/lib/postgresql/16/main/*
sudo mkdir -p /var/lib/postgresql/16/main
sudo chown postgres:postgres /var/lib/postgresql/16/main
sudo chmod 700 /var/lib/postgresql/16/main</code></pre>
    </div>
    <div class="stepper-panel">
      <strong>3. Copy <code>/etc/pgbackrest.conf</code> to the new VM</strong> (same content as before — S3 credentials, stanza path, PGDATA path). Then restore:
      <pre><code># --target: point in time to restore to (UTC)
# --target-action=promote: bring DB online as primary after recovery
sudo -u postgres pgbackrest --stanza=mydb \
  --target="2026-10-14 03:45:00+00" \
  --target-action=promote \
  restore</code></pre>
      pgBackRest downloads the most recent full backup from S3, then fetches and replays all WAL segments up to the target timestamp. Progress is logged to <code>/var/log/pgbackrest/mydb-restore.log</code>.
    </div>
    <div class="stepper-panel">
      <strong>4. Start PostgreSQL.</strong>
      <pre><code>sudo systemctl start postgresql</code></pre>
      PostgreSQL enters recovery mode and applies the remaining WAL. It will not accept write connections until recovery completes and the instance promotes itself (because of <code>--target-action=promote</code>).
    </div>
    <div class="stepper-panel">
      <strong>5. Monitor recovery progress.</strong>
      <pre><code>sudo tail -f /var/log/postgresql/postgresql-16-main.log | \
  grep -E 'recovery|redo|consistent|database system is ready'</code></pre>
      Watch for: <code>database system is ready to accept connections</code> — that confirms recovery completed and promotion happened.
    </div>
    <div class="stepper-panel">
      <strong>6. Confirm primary mode.</strong>
      <pre><code>sudo -u postgres psql -c "SELECT pg_is_in_recovery();"
# f  ← false means it's now a primary, not in recovery</code></pre>
    </div>
    <div class="stepper-panel">
      <strong>7. Verify data integrity.</strong>
      <pre><code>sudo -u postgres psql -c "SELECT COUNT(*) FROM your_critical_table;"
# Compare row count with expected pre-incident value</code></pre>
      Also check <code>pg_stat_archiver</code> and application error logs to confirm data looks correct.
    </div>
    <div class="stepper-panel">
      <strong>8. Reseed the standby.</strong>
      <pre><code># On the standby VM — reseed from the new primary
sudo systemctl stop postgresql
sudo rm -rf /var/lib/postgresql/16/main/*
sudo -u postgres pg_basebackup \
  -h &lt;new-primary-ip&gt; -U replicator \
  -D /var/lib/postgresql/16/main \
  -P --wal-method=stream -R
sudo systemctl start postgresql</code></pre>
      Also update <code>pgbackrest.conf</code> on both VMs if the primary IP changed.
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
  <p class="quiz-q"><code>pgbackrest restore</code> completes successfully, but PostgreSQL won't start — the log shows <code>requested WAL segment has already been removed</code>. What happened and how do you diagnose it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The WAL segment needed to bridge the base backup to the restore target is missing from the S3 archive. Two common causes:<br><br>
    <strong>1. archive_command failed silently before the incident.</strong> Check <code>SELECT last_failed_msg, last_failed_time FROM pg_stat_archiver;</code> on the original primary (if accessible) or look for archiving errors in pgBackRest logs. Even one missed WAL segment breaks the replay chain.<br><br>
    <strong>2. Retention config deleted WAL that was still needed.</strong> If <code>repo1-retention-full=2</code> and you had more than 2 full backup cycles, pgBackRest may have purged old WAL that a specific restore target still required. Prevention: always verify archiving is working daily (<code>pgbackrest --stanza=mydb check</code>) and test a full restore to a shadow host after every schema migration.
  </div>
</div>

---

## 10. Manual Failover (No Patroni)

When the primary is unreachable and you decide to promote the standby:

```bash
# --- On the standby VM ---

# Confirm standby is in recovery mode (should be 't')
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"

# Promote the standby to primary
# Option A: pg_ctl (works even if PostgreSQL is unresponsive to SQL)
sudo -u postgres pg_ctl promote -D /var/lib/postgresql/16/main

# Option B: SQL function (PG 12+)
sudo -u postgres psql -c "SELECT pg_promote();"

# Confirm promotion succeeded
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"
# f  ← now a primary

# Take a new full backup from the promoted primary
sudo -u postgres pgbackrest --stanza=mydb --type=full backup
```

**After failover — update application config:**

```bash
# Update any connection strings, load balancer targets, or DNS records
# pointing to 10.0.0.1 → now point to 10.0.0.2
```

**Re-adding the old primary as a standby** (after recovery): once the old primary VM is back and its data is suspect, treat it as a new standby — wipe its PGDATA and run `pg_basebackup -R` against the new primary. Do not let it rejoin with its own copy of the data without reseeding; it may have diverged.

---

## 11. Monitoring

Using `prometheus-postgres-exporter` (Prometheus community postgres_exporter):

```bash
# Ubuntu
sudo apt install -y prometheus-postgres-exporter
```

```bash
# /etc/default/prometheus-postgres-exporter
DATA_SOURCE_NAME="postgresql://postgres@localhost:5432/postgres?sslmode=disable"
```

```bash
sudo systemctl enable --now prometheus-postgres-exporter
```

Key Prometheus alert rules:

```yaml
groups:
  - name: postgres-replication
    rules:
      - alert: PostgresReplicationLagHigh
        expr: pg_replication_lag{job="postgres"} > 30
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Postgres replication lag {{ $value }}s on {{ $labels.instance }}"

      - alert: PostgresNoStandbyConnected
        expr: pg_stat_replication_count{job="postgres"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "No standby connected to primary {{ $labels.instance }}"

      - alert: PostgresArchivingFailing
        expr: pg_stat_archiver_failed_count{job="postgres"} > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "WAL archiving failures on {{ $labels.instance }} — PITR is broken"

  - name: postgres-backup
    rules:
      - alert: PostgresBackupStale
        # Requires pgbackrest_exporter or a custom metric push from cron
        expr: time() - pgbackrest_backup_timestamp_stop_epoch{stanza="mydb",type="full"} > 90000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "pgBackRest full backup is stale ({{ $value | humanizeDuration }} old)"
```

Manual diagnostic queries:

```sql
-- WAL archiving status — last_failed_msg is the first thing to check on a PITR concern
SELECT archived_count, failed_count, last_archived_wal, last_archived_time,
       last_failed_wal, last_failed_msg, last_failed_time
FROM pg_stat_archiver;

-- Replication lag in seconds (run on primary)
SELECT client_addr,
       EXTRACT(EPOCH FROM replay_lag)::int AS replay_lag_seconds
FROM pg_stat_replication;

-- Confirm recovery on standby
SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();
```

<div class="quiz-card">
  <p class="quiz-q"><code>pg_stat_archiver</code> shows <code>last_failed_msg: archive command failed with exit code 1</code>. pgBackRest is the archive tool. What is the fastest way to get the actual error?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Run the archive command manually as the <code>postgres</code> OS user against a known WAL segment:<br>
    <code>sudo -u postgres pgbackrest --stanza=mydb --log-level-console=detail archive-push /var/lib/postgresql/16/main/pg_wal/000000010000000000000001</code><br><br>
    This shows the real error instead of the generic exit-code-1 message. Common causes: S3 credentials expired or the IAM role was changed; stanza was never initialized (<code>stanza-create</code> skipped); the S3 bucket name or region in <code>/etc/pgbackrest.conf</code> does not match; or the <code>postgres</code> OS user cannot read <code>/etc/pgbackrest.conf</code> (check <code>ls -la /etc/pgbackrest.conf</code>).
  </div>
</div>

---

## 12. Setup Checklist

- [ ] PostgreSQL 16 installed on both VMs from PGDG repo
- [ ] Package versions pinned with `apt-mark hold postgresql-16 pgbackrest`
- [ ] Firewall: port 5432 open between primary ↔ standby; verified with `nc -zv`
- [ ] `wal_level = replica` set in `postgresql.conf` on primary
- [ ] `archive_mode = on` and `archive_command` (pgbackrest archive-push) configured on primary
- [ ] `max_wal_senders = 5` and `wal_keep_size = 512MB` set on primary
- [ ] `hot_standby = on` set (takes effect on standby; safe on primary too)
- [ ] `replicator` user created with `REPLICATION LOGIN` on primary
- [ ] `pg_hba.conf` has replication entry for standby IP with `scram-sha-256`
- [ ] `systemctl reload postgresql` run after `pg_hba.conf` changes
- [ ] Standby bootstrapped with `pg_basebackup -R` (standby.signal present in PGDATA)
- [ ] `pg_stat_replication` on primary shows standby in `streaming` state
- [ ] `pg_is_in_recovery()` on standby returns `t`
- [ ] `replay_lag` near zero (< 5s) under normal write load
- [ ] `/etc/pgbackrest.conf` configured on both VMs (same S3 bucket, stanza, PGDATA path)
- [ ] `pgbackrest --stanza=mydb stanza-create` completed without error
- [ ] `pgbackrest --stanza=mydb check` passes (WAL archiving verified end-to-end)
- [ ] First full backup taken and verified with `pgbackrest --stanza=mydb info`
- [ ] Cron jobs installed: full Sunday 01:00, diff Mon-Sat 01:00
- [ ] `pg_stat_archiver.failed_count = 0` (WAL archiving working continuously)
- [ ] PITR restore tested on a shadow VM (not just "backup ran successfully")
- [ ] Prometheus postgres_exporter running on both VMs
- [ ] Replication lag alert: threshold 30s
- [ ] WAL archiving failure alert: threshold 0 failures
- [ ] Backup staleness alert: threshold 25h
- [ ] Failover procedure documented and tested (`pg_ctl promote` drill)
