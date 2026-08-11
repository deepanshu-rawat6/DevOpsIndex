# MongoDB Replica Set — VM Cluster Setup

Three VMs: one **Primary**, one **Secondary**, one **Arbiter**. This guide walks every step from bare OS to a monitored, production-ready replica set — firewall rules, `mongod.conf`, user creation, replica set bootstrap, write-concern tuning, and the Prometheus exporter.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Cluster Architecture

```mermaid
graph TD
    classDef primary fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef secondary fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef arbiter fill:#f39c12,stroke:#d68910,color:#fff,rx:8
    classDef client fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef exporter fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph "VM 1 — Primary (10.0.0.1)"
        P["mongod :27017<br>PRIMARY<br>reads + writes<br>holds full oplog"]:::primary
        EXP["mongodb_exporter :9216<br>Prometheus metrics"]:::exporter
    end

    subgraph "VM 2 — Secondary (10.0.0.2)"
        S["mongod :27017<br>SECONDARY<br>tails oplog from primary<br>read-only (optional)"]:::secondary
    end

    subgraph "VM 3 — Arbiter (10.0.0.3)"
        A["mongod :27017<br>ARBITER<br>vote-only, no data<br>breaks election ties"]:::arbiter
    end

    APP["Application"]:::client
    PROM["Prometheus"]:::client

    P -->|"oplog stream (async)"| S
    P <-->|"heartbeat :27017"| A
    S <-->|"heartbeat :27017"| A

    APP -->|"w:majority writes"| P
    APP -->|"readPreference: secondary"| S
    PROM -->|"scrape :9216"| EXP
    EXP -->|"auth :27017"| P
```

**Minimum viable quorum:** primary + arbiter = 2 votes. That's enough to elect a new primary if the secondary dies, without paying for a third full data copy. An arbiter holds no data and is cheap to run on a small VM.

<div class="quiz-card">
  <p class="quiz-q">The secondary VM is completely down. Can the primary keep accepting writes? Can the arbiter become primary?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Yes, the primary keeps accepting writes — it still has 2 of 3 votes (itself + arbiter), which is a majority. No, the arbiter cannot become primary; it is vote-only and holds no data. If the <em>primary</em> also went down, you'd only have 1 vote (arbiter), which is not a majority, and no election could succeed — the cluster would go read-only until the primary or secondary recovered.
  </div>
</div>

---

## 1. Firewall Rules

MongoDB members communicate on port **27017**. Every node must allow inbound 27017 from the other two nodes. Open this <em>before</em> bootstrapping the replica set — misconfigured firewall rules cause silent heartbeat failures that look like replica set bugs.

### What to open (all three nodes)

| Source | Destination | Port | Why |
|--------|-------------|------|-----|
| Secondary (10.0.0.2) | Primary (10.0.0.1) | 27017/tcp | oplog pull, heartbeat |
| Arbiter (10.0.0.3) | Primary (10.0.0.1) | 27017/tcp | heartbeat, vote |
| Primary (10.0.0.1) | Secondary (10.0.0.2) | 27017/tcp | heartbeat (bidirectional) |
| Primary (10.0.0.1) | Arbiter (10.0.0.3) | 27017/tcp | heartbeat |
| Secondary (10.0.0.2) | Arbiter (10.0.0.3) | 27017/tcp | heartbeat |
| App servers / Prometheus | Primary (10.0.0.1) | 27017/tcp | client connections |
| Prometheus | Primary (10.0.0.1) | 9216/tcp | exporter scrape |

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="firewalld" class="active">firewalld (RHEL/Rocky)</button>
    <button data-tab="ufw">ufw (Ubuntu/Debian)</button>
    <button data-tab="iptables">iptables (raw)</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="firewalld">

```bash
# Run on PRIMARY — allow secondary and arbiter
PRIMARY_IP="10.0.0.1"
SECONDARY_IP="10.0.0.2"
ARBITER_IP="10.0.0.3"

firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${SECONDARY_IP} port port=27017 protocol=tcp accept"
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${ARBITER_IP}  port port=27017 protocol=tcp accept"
# Allow Prometheus scrape of exporter
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 port port=9216 protocol=tcp accept"
firewall-cmd --reload

# Run on SECONDARY — allow primary + arbiter heartbeats
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${PRIMARY_IP} port port=27017 protocol=tcp accept"
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${ARBITER_IP} port port=27017 protocol=tcp accept"
firewall-cmd --reload

# Run on ARBITER — allow primary + secondary heartbeats
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${PRIMARY_IP}   port port=27017 protocol=tcp accept"
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${SECONDARY_IP} port port=27017 protocol=tcp accept"
firewall-cmd --reload

# Verify
firewall-cmd --list-rich-rules
```

    </div>
    <div class="tab-panel" data-tab-panel="ufw">

```bash
# PRIMARY
ufw allow from 10.0.0.2 to any port 27017 proto tcp comment "mongo secondary"
ufw allow from 10.0.0.3 to any port 27017 proto tcp comment "mongo arbiter"
ufw allow 9216/tcp comment "mongodb-exporter"
ufw reload

# SECONDARY
ufw allow from 10.0.0.1 to any port 27017 proto tcp comment "mongo primary"
ufw allow from 10.0.0.3 to any port 27017 proto tcp comment "mongo arbiter"
ufw reload

# ARBITER
ufw allow from 10.0.0.1 to any port 27017 proto tcp comment "mongo primary"
ufw allow from 10.0.0.2 to any port 27017 proto tcp comment "mongo secondary"
ufw reload

# Verify
ufw status numbered
```

    </div>
    <div class="tab-panel" data-tab-panel="iptables">

```bash
# PRIMARY — accept from secondary and arbiter
iptables -A INPUT -s 10.0.0.2 -p tcp --dport 27017 -j ACCEPT
iptables -A INPUT -s 10.0.0.3 -p tcp --dport 27017 -j ACCEPT
iptables -A INPUT -p tcp --dport 9216 -j ACCEPT

# Persist (Debian/Ubuntu)
apt-get install -y iptables-persistent
iptables-save > /etc/iptables/rules.v4

# Persist (RHEL/Rocky)
service iptables save
```

    </div>
  </div>
</div>

### Connection check — before you continue

```bash
# From SECONDARY VM — must succeed before any mongod config
nc -zv 10.0.0.1 27017
# Expected: Connection to 10.0.0.1 27017 port [tcp] succeeded!

# From ARBITER VM
nc -zv 10.0.0.1 27017
# Expected: Connection to 10.0.0.1 27017 port [tcp] succeeded!

# If nc is not available
curl -s telnet://10.0.0.1:27017 --max-time 2 || echo "FAILED — check firewall"
```

> ⚠️ **Do not proceed to mongod configuration until `nc -zv` succeeds from both secondary and arbiter.** A replica set member that cannot reach its peers will continuously retry and never reach a healthy state. Fix the network first.

<div class="quiz-card">
  <p class="quiz-q">You run <code>nc -zv 10.0.0.1 27017</code> from the secondary and get "Connection refused". The firewall rules look correct. What else could cause this?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    "Connection refused" (as opposed to a timeout/dropped packet) means the network path is open but nothing is listening on that port yet — mongod is not running on the primary. A firewall block produces a <em>timeout</em>, not a refused connection. Start mongod on the primary first, then re-run the check.
  </div>
</div>

---

## 2. Keyfile (Shared Secret)

All members of a replica set authenticate to each other using a shared keyfile. Generate it once on the primary and copy it to every node.

```bash
# Generate on primary
openssl rand -base64 756 > /etc/mongodb/keyfile
chmod 400 /etc/mongodb/keyfile
chown mongod:mongod /etc/mongodb/keyfile

# Copy to secondary and arbiter
scp /etc/mongodb/keyfile user@10.0.0.2:/etc/mongodb/keyfile
scp /etc/mongodb/keyfile user@10.0.0.3:/etc/mongodb/keyfile

# Set permissions on each remote node
ssh user@10.0.0.2 "chmod 400 /etc/mongodb/keyfile && chown mongod:mongod /etc/mongodb/keyfile"
ssh user@10.0.0.3 "chmod 400 /etc/mongodb/keyfile && chown mongod:mongod /etc/mongodb/keyfile"
```

> The keyfile must be **identical** on all members, readable only by the `mongod` user, and at least 6 characters long (typically 756 bytes of base64).

---

## 3. Primary — mongod.conf

```yaml
# /etc/mongod.conf  (Primary: 10.0.0.1)

systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log

storage:
  dbPath: /var/lib/mongo
  journal:
    enabled: true
  engine: wiredTiger
  wiredTiger:
    engineConfig:
      # Rule: ~50% of available RAM, leaving room for OS page cache.
      # Example: 16 GB RAM → cacheSizeGB: 6 (not 8, so page cache + OS has room)
      # Default if unset: 50% of (RAM - 1 GB), min 256 MB
      cacheSizeGB: 6

net:
  port: 27017
  bindIp: 0.0.0.0    # listens on all interfaces; restrict to specific IPs if preferred
  maxIncomingConnections: 65536

replication:
  replSetName: "rs0"
  # oplogSizeMB default: 5% of disk, min 990 MB. Increase for busy primaries.
  oplogSizeMB: 5120   # 5 GB — enough for ~24h of lag tolerance on moderate workloads

security:
  authorization: enabled
  keyFile: /etc/mongodb/keyfile

processManagement:
  timeZoneInfo: /usr/share/zoneinfo
```

### cacheSizeGB — how to size it

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>Step 1 — Find available RAM.</strong> Run <code>free -g</code> or <code>cat /proc/meminfo | grep MemTotal</code>. Example: 32 GB total.
    </div>
    <div class="stepper-panel">
      <strong>Step 2 — Apply the 50% rule with a headroom buffer.</strong> MongoDB's default is <code>(RAM - 1GB) × 0.5</code>. In practice for a dedicated MongoDB VM, set it to roughly <strong>40–50% of RAM</strong> — e.g., 32 GB RAM → <code>cacheSizeGB: 12</code> to 14. Leave the rest for the OS page cache, oplog in memory, and connection overhead.
    </div>
    <div class="stepper-panel">
      <strong>Step 3 — Check WiredTiger cache pressure.</strong> After load, connect to mongosh and run:<br><code>db.serverStatus().wiredTiger.cache</code><br>Watch <em>"pages evicted because they exceeded the in-memory maximum"</em> and <em>"tracked dirty bytes in the cache"</em>. If eviction is high, increase <code>cacheSizeGB</code>.
    </div>
    <div class="stepper-panel">
      <strong>Step 4 — Never set it to 100% of RAM.</strong> The OS itself needs memory, mongod holds per-connection memory outside WiredTiger, and the page cache accelerates oplog reads. A fully saturated WiredTiger cache causes constant eviction pressure — worse than a smaller, stable cache.
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
  <p class="quiz-q">Your primary has 64 GB of RAM. You set <code>cacheSizeGB: 60</code> to maximize MongoDB cache. What problem will this cause in production?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    WiredTiger will occupy 60 GB, leaving only 4 GB for the OS, per-connection buffers, and the filesystem page cache. The page cache is critical — the OS uses it to cache frequently-read data files and the oplog. With it starved, every read that misses WiredTiger hits the disk directly. Additionally, MongoDB allocates per-connection memory <em>outside</em> the WiredTiger cache, so under connection load the system will begin swapping, causing severe latency spikes. The safe ceiling is about 50% of RAM.
  </div>
</div>

---

## 4. Bootstrap the Replica Set (Primary only)

Start mongod without security first to create the admin user, then enable auth.

```bash
# 1. Start mongod (security disabled for initial user creation)
# Temporarily comment out the security: block in mongod.conf, then:
systemctl start mongod

# 2. Connect locally
mongosh --host 127.0.0.1 --port 27017
```

```javascript
// 3. Initiate the replica set — PRIMARY only, with just itself
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "10.0.0.1:27017", priority: 2 }   // higher priority = prefers to stay primary
  ]
})

// Confirm primary is elected (may take a few seconds)
rs.status()
// Look for: "stateStr" : "PRIMARY"
```

### Create Users

```javascript
// Switch to admin db
use admin

// 1. Admin (superuser — for ops/DBA work only)
db.createUser({
  user: "admin",
  pwd: "ch@ngeM3!",        // use a strong generated password in production
  roles: [{ role: "root", db: "admin" }]
})

// 2. Reader (read-only access to application DB)
db.createUser({
  user: "reader",
  pwd: "R3ad0nly!",
  roles: [
    { role: "read", db: "myapp" }
  ]
})

// 3. Writer (read+write access to application DB)
db.createUser({
  user: "writer",
  pwd: "Wr1teUser!",
  roles: [
    { role: "readWrite", db: "myapp" }
  ]
})

// Verify all users were created
db.getUsers()
```

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="admin-role" class="active">admin (root)</button>
    <button data-tab="reader-role">reader</button>
    <button data-tab="writer-role">writer</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="admin-role">
      <strong>root</strong> role gives full access to all resources and actions cluster-wide — user management, replica set config, shutdown, everything. Use this only for human operators and break-glass access. Never use it for application connections.
    </div>
    <div class="tab-panel" data-tab-panel="reader-role">
      <strong>read</strong> on a specific database allows <code>find</code>, <code>listCollections</code>, <code>aggregate</code> (read-only pipelines), and <code>count</code>. No writes, no schema changes. Suitable for analytics queries, reporting tools, and read-only dashboards.
    </div>
    <div class="tab-panel" data-tab-panel="writer-role">
      <strong>readWrite</strong> includes everything <em>read</em> grants plus <code>insert</code>, <code>update</code>, <code>delete</code>, and <code>createCollection/Index</code>. Use this for your application's primary connection. It is scoped to one database — the writer cannot touch other databases.
    </div>
  </div>
</div>

```bash
# 4. Enable security — re-enable the security block in mongod.conf, then restart
systemctl restart mongod

# 5. Verify auth works
mongosh --host 10.0.0.1 -u admin -p 'ch@ngeM3!' --authenticationDatabase admin
```

<div class="quiz-card">
  <p class="quiz-q">Your application connects with the <code>writer</code> user scoped to the <code>myapp</code> database. It tries to run a query on the <code>logs</code> database. What happens?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The query fails with an <code>Unauthorized</code> error. The <code>readWrite</code> role was granted <em>on the <code>myapp</code> database only</em>. MongoDB roles are per-database — a role on <code>myapp</code> gives no access to <code>logs</code>. To grant access to multiple databases, either create additional roles scoped to each, or grant <code>readWriteAnyDatabase</code> on the <code>admin</code> database (which is much broader — scope carefully).
  </div>
</div>

---

## 5. Add Secondary and Arbiter

```javascript
// On PRIMARY — connect as admin
mongosh --host 10.0.0.1 -u admin -p 'ch@ngeM3!' --authenticationDatabase admin

// Add secondary (full data-bearing member)
rs.add({ host: "10.0.0.2:27017", priority: 1 })

// Add arbiter (vote-only, no data)
rs.addArb("10.0.0.3:27017")

// ─── IMPORTANT: check status ───────────────────────────────────────────
rs.status()
```

### rs.status() — what to look for

```javascript
// Healthy output (abbreviated)
{
  "set": "rs0",
  "myState": 1,             // 1 = PRIMARY
  "members": [
    {
      "name": "10.0.0.1:27017",
      "stateStr": "PRIMARY",
      "health": 1,
      "optime": { ... }
    },
    {
      "name": "10.0.0.2:27017",
      "stateStr": "SECONDARY",
      "health": 1,
      "optimeDate": ISODate("..."),
      "lastHeartbeatMessage": "",  // empty = healthy
      "syncSourceHost": "10.0.0.1:27017"
    },
    {
      "name": "10.0.0.3:27017",
      "stateStr": "ARBITER",
      "health": 1
    }
  ]
}
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>health: 1.</strong> All three members must show <code>health: 1</code>. A <code>0</code> here means the member is unreachable from the primary — check firewall and whether mongod is running on that VM.
    </div>
    <div class="stepper-panel">
      <strong>stateStr: "SECONDARY".</strong> Right after adding, the secondary will show <code>STARTUP2</code> while it performs initial sync (copying the primary's data). Wait for it to transition to <code>SECONDARY</code> before routing any reads to it.
    </div>
    <div class="stepper-panel">
      <strong>lastHeartbeatMessage.</strong> Should be empty on healthy members. A non-empty message (e.g. "Error connecting to...") is a sign of a network or auth problem. Fix this before considering the setup complete.
    </div>
    <div class="stepper-panel">
      <strong>optimeDate lag.</strong> The secondary's <code>optimeDate</code> should be close to the primary's. A large gap means the secondary is falling behind — check secondary VM resources (disk I/O, CPU) and oplog size.
    </div>
    <div class="stepper-panel">
      <strong>syncSourceHost.</strong> The secondary should be syncing from the primary (<code>10.0.0.1:27017</code>). In a larger cluster, secondaries can sync from other secondaries (chained replication) — fine in most cases, can increase lag.
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
  <p class="quiz-q">Right after running <code>rs.addArb("10.0.0.3:27017")</code>, <code>rs.status()</code> shows the arbiter with <code>stateStr: "UNKNOWN"</code> and <code>health: 0</code>. What's the most likely cause?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Either (1) <code>mongod</code> is not running on the arbiter VM, (2) the firewall blocks the primary from reaching port 27017 on the arbiter, or (3) the keyfile on the arbiter is missing, wrong permissions, or differs from the primary's keyfile. The arbiter cannot join the set if authentication fails or the port is unreachable. Run <code>nc -zv 10.0.0.3 27017</code> from the primary to isolate networking vs. auth.
  </div>
</div>

---

## 6. Secondary — mongod.conf

The secondary's config is nearly identical to the primary. Key difference: no special initialization is needed — it joins via `rs.add()` from the primary and syncs automatically.

```yaml
# /etc/mongod.conf  (Secondary: 10.0.0.2)

systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log

storage:
  dbPath: /var/lib/mongo
  journal:
    enabled: true
  engine: wiredTiger
  wiredTiger:
    engineConfig:
      cacheSizeGB: 6        # same sizing logic as primary

net:
  port: 27017
  bindIp: 0.0.0.0          # primary's IP must be able to reach this
  maxIncomingConnections: 65536

replication:
  replSetName: "rs0"        # MUST match primary exactly (case-sensitive)

security:
  authorization: enabled
  keyFile: /etc/mongodb/keyfile   # same keyfile as primary

processManagement:
  timeZoneInfo: /usr/share/zoneinfo
```

```bash
# Start and enable on boot
systemctl enable --now mongod

# Verify it's running and listening on 27017
ss -tlnp | grep 27017
# tcp  LISTEN  0.0.0.0:27017  ...  users:(("mongod",...))
```

<div class="quiz-card">
  <p class="quiz-q">The secondary's <code>replSetName</code> is set to <code>RS0</code> (uppercase) while the primary uses <code>rs0</code>. The secondary appears stuck in <code>STARTUP</code>. Why?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    <code>replSetName</code> is case-sensitive. A secondary with <code>RS0</code> cannot join a set named <code>rs0</code> — it refuses to participate because the names don't match. This is one of the most common config typos. Fix the mongod.conf on the secondary, restart mongod, and verify with <code>rs.status()</code> on the primary.
  </div>
</div>

---

## 7. Arbiter — mongod.conf

The arbiter runs a real `mongod` process but stores no application data. Its config is minimal — it only needs the replica set name and the keyfile to authenticate. Give it the smallest VM you can justify (1–2 vCPU, 1–2 GB RAM is fine).

```yaml
# /etc/mongod.conf  (Arbiter: 10.0.0.3)

systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log

storage:
  dbPath: /var/lib/mongo/arbiter   # keep separate from any data you might have
  journal:
    enabled: true
  # Explicitly set small — arbiter stores almost no data
  wiredTiger:
    engineConfig:
      cacheSizeGB: 0.25

net:
  port: 27017
  bindIp: 0.0.0.0

replication:
  replSetName: "rs0"   # must match primary

security:
  authorization: enabled
  keyFile: /etc/mongodb/keyfile   # same keyfile as primary

processManagement:
  timeZoneInfo: /usr/share/zoneinfo
```

```bash
# Create the arbiter data directory
mkdir -p /var/lib/mongo/arbiter
chown -R mongod:mongod /var/lib/mongo/arbiter

systemctl enable --now mongod
```

> ⚠️ **Do not run the arbiter on the same VM as the primary or secondary.** An arbiter's entire value is providing an independent vote during an election. Co-located, if that VM fails you lose both the primary <em>and</em> the tiebreaker simultaneously — exactly the failure you were guarding against.

<div class="quiz-card">
  <p class="quiz-q">Should you add <code>cacheSizeGB</code> to the arbiter's config? What happens if you leave it at its default?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The arbiter stores essentially no data, so the default WiredTiger cache (50% of RAM − 1 GB, minimum 256 MB) wastes RAM that the OS could use for something else. Explicitly setting <code>cacheSizeGB: 0.25</code> (256 MB) is good practice — it signals intent and prevents the cache from grabbing half the RAM on a small VM where memory is scarce.
  </div>
</div>

---

## 8. Write Concern

Write concern controls how many replica set members must acknowledge a write before MongoDB returns success to the client. Getting this wrong is the most common cause of data loss after a failover.

```javascript
// Set default write concern on the replica set (MongoDB 5.0+)
// Run on primary as admin
db.adminCommand({
  setDefaultRWConcern: 1,
  defaultWriteConcern: {
    w: "majority",   // majority of voting members must acknowledge
    j: true,         // writes must be written to journal (on-disk) — not just memory
    wtimeout: 5000   // fail if not confirmed in 5 seconds (prevents infinite hangs)
  }
})

// Per-operation write concern (application level — overrides default)
db.orders.insertOne(
  { item: "widget", qty: 100 },
  { writeConcern: { w: "majority", j: true, wtimeout: 5000 } }
)
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="w1" class="active state-warn">w: 1</button>
    <button data-toggle-opt="wmaj" class="state-ok">w: "majority"</button>
    <button data-toggle-opt="w0" class="state-warn">w: 0</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="w1">
    <strong>w: 1 (default before MongoDB 5.0).</strong> Only the primary must acknowledge. The fastest option. Risk: if the primary crashes before replicating to any secondary, the write is lost — the secondary that gets elected in the subsequent election never had it. <em>Not recommended for anything durable.</em>
  </div>
  <div class="toggle-panel" data-toggle-panel="wmaj">
    <strong>w: "majority" (recommended).</strong> Primary + at least one secondary (2 of 3 votes) must acknowledge before the client gets a success. If the primary fails after this, the secondary already has the data and can safely become primary. Slightly higher latency (one extra round-trip), but durability guaranteed.
  </div>
  <div class="toggle-panel" data-toggle-panel="w0">
    <strong>w: 0 (fire and forget).</strong> MongoDB returns immediately without waiting for <em>any</em> acknowledgement — not even from the primary's in-memory buffer. Maximum throughput for metrics/logs/events where data loss is acceptable. Never use for financial, user, or transactional data.
  </div>
</div>

**How `w: "majority"` works with an arbiter:**

```
Set members: primary (vote), secondary (vote), arbiter (vote)
Total votes:  3
Majority:     2

Write acknowledged by primary + secondary = 2 votes = majority ✓
Write acknowledged by primary + arbiter  = 2 votes = majority ✓  (but arbiter has no data!)
```

> ⚠️ The arbiter counts toward the majority quorum for `w: "majority"`, but it does **not** hold the data. If the primary and arbiter both confirm a write but the secondary hasn't replicated it yet — and then the primary dies — the arbiter cannot supply the data to a new primary. Always pair `w: "majority"` with `j: true` on the primary so the primary's journal is flushed before reporting success.

<div class="quiz-card">
  <p class="quiz-q">With <code>w: "majority"</code> and 3 voting members (primary + secondary + arbiter), the secondary is unreachable. A write arrives at the primary. Does it succeed?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Yes — if <code>wtimeout</code> hasn't expired. The primary + arbiter = 2 votes = majority, so the write can still be acknowledged by <code>w: "majority"</code> even without the secondary. The write is only on the primary and the arbiter has no data copy, so there's elevated risk if the primary crashes before the secondary recovers. This is a known tradeoff of the PSA (Primary-Secondary-Arbiter) topology — for stronger durability guarantees under secondary failure, use a PSS (Primary-Secondary-Secondary) topology instead.
  </div>
</div>

---

## 9. mongodb-exporter (Prometheus)

The Percona `mongodb_exporter` exposes MongoDB's internal metrics in Prometheus format. Run it on the primary VM alongside mongod.

### Create the monitoring user

```javascript
// Connect to primary as admin
mongosh --host 10.0.0.1 -u admin -p 'ch@ngeM3!' --authenticationDatabase admin

use admin
db.createUser({
  user: "mongodb_exporter",
  pwd: "Exporter$ecret!",
  roles: [
    { role: "clusterMonitor",  db: "admin" },   // rs.status(), serverStatus(), etc.
    { role: "read",            db: "local"  },  // oplog stats
    { role: "read",            db: "admin"  },  // profile collection
    { role: "readAnyDatabase", db: "admin"  }   // collection stats across DBs
  ]
})
```

### Install the correct binary

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="pkg" class="active">Package (recommended)</button>
    <button data-tab="binary">Manual binary</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="pkg">

```bash
# RHEL/Rocky/CentOS — Percona repo
yum install -y https://repo.percona.com/yum/percona-release-latest.noarch.rpm
percona-release enable-only tools
yum install -y mongodb_exporter

# Ubuntu/Debian
wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb
dpkg -i percona-release_latest.generic_all.deb
percona-release enable-only tools
apt-get update && apt-get install -y mongodb-exporter

# Confirm installed binary
which mongodb_exporter
mongodb_exporter --version
```

    </div>
    <div class="tab-panel" data-tab-panel="binary">

```bash
# Get the latest release from GitHub
# https://github.com/percona/mongodb_exporter/releases
VERSION="0.40.0"
ARCH="linux-amd64"
wget "https://github.com/percona/mongodb_exporter/releases/download/v${VERSION}/mongodb_exporter-${VERSION}.${ARCH}.tar.gz"

tar -xzf "mongodb_exporter-${VERSION}.${ARCH}.tar.gz"
mv mongodb_exporter /usr/local/bin/mongodb_exporter
chmod +x /usr/local/bin/mongodb_exporter

# Verify
mongodb_exporter --version
```

> Use the **Percona** `mongodb_exporter`, not the old `prometheus-community/mongodb_exporter` — the Percona fork is actively maintained and supports MongoDB 5.0+. The old one has known metric gaps and is no longer updated.

    </div>
  </div>
</div>

### Connection string

```bash
# Format:
# mongodb://<username>:<password>@<PRIMARY_IP>:<PORT>/admin?authSource=admin

MONGODB_URI="mongodb://mongodb_exporter:Exporter%24ecret%21@10.0.0.1:27017/admin?authSource=admin"
# URL-encode special chars in the password: ! → %21, $ → %24, @ → %40
```

### Run as a systemd service

```ini
# /etc/systemd/system/mongodb_exporter.service
[Unit]
Description=Percona MongoDB Exporter
After=network.target mongod.service

[Service]
User=mongod
Group=mongod
ExecStart=/usr/local/bin/mongodb_exporter \
  --mongodb.uri="mongodb://mongodb_exporter:Exporter%24ecret%21@10.0.0.1:27017/admin?authSource=admin" \
  --web.listen-address=":9216" \
  --collect-all \
  --compatible-mode
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now mongodb_exporter

# Verify metrics are being served
curl -s http://localhost:9216/metrics | grep -E "^mongodb_up|^mongodb_rs_members"
# mongodb_up 1
# mongodb_rs_members_state{member="10.0.0.1:27017",state="PRIMARY"}   1
# mongodb_rs_members_state{member="10.0.0.2:27017",state="SECONDARY"} 2
# mongodb_rs_members_state{member="10.0.0.3:27017",state="ARBITER"}   7
```

<div class="quiz-card">
  <p class="quiz-q">The exporter fails to connect and logs <code>Authentication failed</code>. You've triple-checked the password. What's the most overlooked cause?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Special characters in the password must be URL-encoded in the MongoDB URI. A password like <code>Exporter$ecret!</code> contains <code>$</code> (must become <code>%24</code>) and <code>!</code> (must become <code>%21</code>). The raw password passed in a URI string is parsed as URL path components — an un-encoded <code>$</code> or <code>@</code> will be misinterpreted and the credentials will arrive at mongod garbled. Always URL-encode the username and password segments of a MongoDB connection string.
  </div>
</div>

---

## 10. Prometheus Scrape Config

```yaml
# /etc/prometheus/prometheus.yml  (add this job)
scrape_configs:
  - job_name: "mongodb"
    static_configs:
      - targets: ["10.0.0.1:9216"]   # primary's exporter
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
```

**Key metrics to alert on:**

| Metric | Alert condition | Meaning |
|--------|----------------|---------|
| `mongodb_up` | `== 0` | Exporter cannot reach mongod |
| `mongodb_rs_members_state` | any member `!= 1` (PRIMARY) or `!= 2` (SECONDARY) | Unexpected state change |
| `mongodb_mongod_op_latencies_latency_total` | rate spike | High read/write latency |
| `mongodb_mongod_wiredtiger_cache_bytes{type="currently in cache"}` | `> cacheSizeGB × 0.9` | Cache near saturation |
| `mongodb_mongod_replset_member_replication_lag` | `> 30s` | Secondary falling behind |

---

## 11. Operational Runbook

### Health checks at a glance

```javascript
// ── Connect (always specify replica set name for driver-aware routing)
mongosh "mongodb://admin:ch@ngeM3!@10.0.0.1:27017,10.0.0.2:27017,10.0.0.3:27017/admin?replicaSet=rs0&authSource=admin"

// ── Replica set status
rs.status()           // full picture: states, health, lag, oplog
rs.isMaster()         // quick: who is primary, what's the set name
rs.printReplicationInfo()           // primary: oplog size & coverage window
rs.printSecondaryReplicationInfo()  // lag per secondary

// ── Server stats
db.serverStatus().connections   // current, available, totalCreated
db.serverStatus().wiredTiger.cache  // cache hit ratio, dirty bytes
db.serverStatus().repl          // replication info
```

### Common issues and fixes

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="no-primary" class="active">No primary elected</button>
    <button data-tab="lag">Secondary lagging</button>
    <button data-tab="startup2">Stuck in STARTUP2</button>
    <button data-tab="rollback">Rollback on rejoin</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="no-primary">
      <strong>Symptom:</strong> <code>rs.status()</code> shows all members in <code>SECONDARY</code> or <code>UNKNOWN</code>, no primary.<br><br>
      <strong>Cause:</strong> Fewer than majority of votes are reachable (e.g. primary + secondary both down).<br><br>
      <strong>Fix:</strong> Restore at least 2 of the 3 VMs. If the arbiter is up and one data-bearing node is up, they form a majority — an election will run. Never force a single node into primary with <code>rs.reconfigForce()</code> unless you understand rollback risk.
    </div>
    <div class="tab-panel" data-tab-panel="lag">
      <strong>Symptom:</strong> <code>rs.printSecondaryReplicationInfo()</code> shows a large lag; secondary <code>optimeDate</code> is far behind primary.<br><br>
      <strong>Causes:</strong> Disk I/O saturation on secondary, network bandwidth, secondary CPU, or oplog too small (secondary needed data that already rolled off the oplog — forces full resync).<br><br>
      <strong>Fix:</strong> Check <code>iostat -x 1</code> on secondary. Increase <code>oplogSizeMB</code> on primary if the window is too narrow. For severe lag, trigger a manual resync: stop mongod on secondary, wipe <code>dbPath</code>, restart — it will perform initial sync again.
    </div>
    <div class="tab-panel" data-tab-panel="startup2">
      <strong>Symptom:</strong> Secondary stays in <code>STARTUP2</code> for an unusually long time after being added.<br><br>
      <strong>What's happening:</strong> <code>STARTUP2</code> is the initial sync state — the secondary is copying the primary's data. This is expected and can take a long time for large datasets. Check progress with <code>rs.status()</code> — look at <code>initialSyncStatus</code>.<br><br>
      <strong>If it's stuck:</strong> Check <code>/var/log/mongodb/mongod.log</code> on the secondary for errors. A keyfile mismatch or network interruption mid-sync can cause it to fail silently and retry indefinitely.
    </div>
    <div class="tab-panel" data-tab-panel="rollback">
      <strong>Symptom:</strong> After a primary failure and recovery, the old primary rejoins as secondary and MongoDB logs mention a rollback directory.<br><br>
      <strong>What happened:</strong> The old primary had writes that were never replicated before it failed. The new primary's oplog diverged. When the old primary rejoins, those un-replicated writes are <em>rolled back</em> — moved to <code>/var/lib/mongo/rollback/</code> as BSON files.<br><br>
      <strong>Fix:</strong> Examine the rollback files with <code>bsondump</code>. Decide if those writes need to be replayed manually. This is a data recovery operation — prevent it by using <code>w: "majority"</code> write concern.
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">You decide to step down the primary manually for maintenance. You run <code>rs.stepDown()</code>. What happens to in-flight writes during the ~10-second election window?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Writes are temporarily unavailable — clients receive "not primary" errors during the election window. Well-behaved drivers using the replica set connection string will automatically retry the write once the new primary is elected. Drivers with retryable writes enabled (default since MongoDB 4.2) handle this transparently without the application needing to catch the error. Reads directed at the old primary also fail during this window — clients with <code>readPreference: primaryPreferred</code> will fall back to a secondary.
  </div>
</div>

---

## 12. Setup Checklist

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>☐ Firewall.</strong> All three nodes allow inbound 27017 from the other two. Verify with <code>nc -zv &lt;peer_ip&gt; 27017</code> from each node. Primary allows inbound 9216 from Prometheus.
    </div>
    <div class="stepper-panel">
      <strong>☐ Keyfile.</strong> Generated on primary with <code>openssl rand -base64 756</code>, mode 400, owner mongod. Identical copy deployed to secondary and arbiter with the same permissions.
    </div>
    <div class="stepper-panel">
      <strong>☐ mongod.conf on all three nodes.</strong> Same <code>replSetName</code> (case-sensitive), correct <code>cacheSizeGB</code>, keyfile path correct, <code>bindIp: 0.0.0.0</code> (or specific IPs). Mongod started and enabled with systemctl.
    </div>
    <div class="stepper-panel">
      <strong>☐ Replica set initiated.</strong> <code>rs.initiate()</code> on primary only, with <code>priority: 2</code> on the primary member. Secondary added with <code>rs.add()</code>. Arbiter added with <code>rs.addArb()</code>.
    </div>
    <div class="stepper-panel">
      <strong>☐ rs.status() is healthy.</strong> All three members show <code>health: 1</code>. Primary is <code>PRIMARY</code>, secondary is <code>SECONDARY</code> (not STARTUP2), arbiter is <code>ARBITER</code>. No <code>lastHeartbeatMessage</code> errors.
    </div>
    <div class="stepper-panel">
      <strong>☐ Users created.</strong> admin (root), reader, writer, and mongodb_exporter users all verified with <code>db.getUsers()</code>. Security block re-enabled in mongod.conf. Mongod restarted. Auth tested.
    </div>
    <div class="stepper-panel">
      <strong>☐ Write concern set.</strong> Default write concern set to <code>w: "majority", j: true, wtimeout: 5000</code> via <code>setDefaultRWConcern</code>. Application connection string includes <code>replicaSet=rs0</code>.
    </div>
    <div class="stepper-panel">
      <strong>☐ mongodb_exporter running.</strong> Service enabled, metrics visible at <code>:9216/metrics</code>, <code>mongodb_up 1</code> confirmed. Prometheus scrape configured. Key alerts in place.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>
