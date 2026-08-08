# FinTech Regulatory Security — SEBI CSCRF, CERT-In Auditing, Secrets Rotation

Security compliance for regulated financial entities in India — SEBI-registered brokers, exchanges, depository participants, and Asset Management Companies (AMCs).

Test yourself as you go — a knowledge check follows most sections below:

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## The Regulatory Landscape

```mermaid
graph TD
    SEBI["SEBI<br/>Securities and Exchange Board of India"] -->|issues| CSCRF["CSCRF<br/>Cybersecurity and Cyber Resilience Framework"]
    CSCRF -->|mandates| SEBIM["risk management,<br/>incident response, audits"]

    CERTIN["CERT-In<br/>(under MeitY)"] -->|empanels| AUD["security audit firms"]
    CERTIN -->|mandates| CERTINM["6-hour incident reporting,<br/>log retention, VAPT audits"]

    RBI["RBI<br/>Reserve Bank of India"] -->|issues| RBIM["guidelines for payment systems,<br/>NBFC cybersecurity"]
```

SEBI CSCRF (2023, updated 2024) is the primary framework for capital market entities. Non-compliance can result in suspension of trading licenses.

<div class="quiz-card">
  <p class="quiz-q">Which regulator's mandate specifically requires reporting a cybersecurity incident within 6 hours — SEBI or CERT-In?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>CERT-In. SEBI issues the CSCRF framework (risk management, incident response processes, audits), but the hard 6-hour reporting clock comes from CERT-In's own directive.</div>
</div>

---

## 1. SEBI CSCRF — Key Controls

### Risk Categories and Classification

SEBI classifies entities into three categories based on trading volume and systemic importance:

| Category | Who | Key requirements |
|----------|-----|-----------------|
| **Category I** | Stock exchanges, clearing corps, depositories | Most stringent — SOC 24×7, 4hr IR, quarterly VAPT |
| **Category II** | Brokers (top 100), AMCs, custodians | 12hr IR, semi-annual VAPT, SIEM mandatory |
| **Category III** | Smaller brokers, RTA, KRA | Annual VAPT, basic controls |

### Mandatory Controls Under CSCRF

**1. Network Segmentation**

Production trading systems must be isolated:

```mermaid
graph TD
    Internet["Internet Zone"] --> DMZ["DMZ<br/>(WAF, reverse proxy)"]
    DMZ --> App["Application Zone<br/>(OMS, RMS)"]
    App --> DB["Database Zone<br/>(trade DB, position DB)"]
    DB --> Exch["Exchange Connectivity Zone<br/>(FIX gateway, co-lo)"]

    Internet -.->|"✕ no direct path — forbidden"| DB

    style DB stroke:#c0392b,stroke-width:2px
    linkStyle 4 stroke:#c0392b,stroke-dasharray: 4 4
```

No direct path from Internet Zone to Database Zone. Each crossing requires firewall with explicit allow rules. Rules documented and reviewed quarterly.

<div class="quiz-card">
  <p class="quiz-q">In the mandated zone architecture, can a request reach the Database Zone straight from the Internet Zone as long as a firewall rule permits it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. There must be no direct path from the Internet Zone to the Database Zone at all &mdash; traffic has to cross DMZ and the Application Zone first. Every zone crossing needs its own firewall with explicit allow rules, reviewed quarterly.</div>
</div>

**2. Privileged Access Management (PAM)**

All admin access to production must go through a PAM tool (CyberArk, BeyondTrust, or open-source Teleport):

```bash
# Teleport (open-source PAM) setup example
# All SSH and kubectl access is recorded and auditable

# Instead of: ssh admin@prod-db-01
# Engineers use:
tsh ssh admin@prod-db-01
# → session recorded, stored in audit log with timestamp
# → every command typed is captured

# kubectl access
tsh kube login prod-cluster
kubectl get pods
# → all API calls logged with user identity + timestamp
```

**3. Multi-Factor Authentication**

All access to trading systems, admin consoles, and cloud portals must require MFA. Hardcoded in IAM policies:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "BoolIfExists": {
          "aws:MultiFactorAuthPresent": "false"
        }
      }
    }
  ]
}
```

<div class="quiz-card">
  <p class="quiz-q">The MFA IAM policy above uses <code>"Effect": "Deny"</code> keyed on <code>MultiFactorAuthPresent: false</code>, rather than an Allow rule. What does it actually do?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It denies every action on every resource (<code>Action: "*"</code>, <code>Resource: "*"</code>) whenever MFA wasn't presented on the request &mdash; overriding whatever else is allowed. That's what makes MFA effectively mandatory everywhere instead of only on the specific actions an Allow statement would have to enumerate.</div>
</div>

**4. Data Localisation**

SEBI requires trade data, investor data, and audit logs to remain on servers **physically located in India**. Cloud setup must use `ap-south-1` (Mumbai) or on-prem in India. Replication to overseas regions requires approval and data masking.

---

## 2. CERT-In Compliance — Evidence-Based Auditing

### What CERT-In Auditors Look For

CERT-In empaneled auditors don't just look at your config files — they require **documented, timestamped evidence** that controls are actually operational. Kubernetes RBAC policies on a slide deck are not evidence.

```
What auditors actually want:
  ✓  Screenshot + timestamp of who has admin access (from PAM tool)
  ✓  Log showing the last 90 days of admin logins and commands run
  ✓  Evidence that RBAC was reviewed on [specific date] by [specific person]
  ✓  Change tickets linked to every firewall rule modification
  ✓  Vulnerability scan report dated within 6 months (VAPT)
  ✓  Incident response drill conducted on [date] with outcomes documented
  ✓  Proof that terminated employees' access was revoked within 24 hours
```

### Kubernetes RBAC Is Not Enough

A ClusterRole with `verbs: [get, list]` is a good start, but it doesn't satisfy audit requirements alone. You need:

**a) Immutable audit logs of every API call:**

```yaml
# kube-apiserver audit policy — log everything relevant
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all secret/configmap access (data access by humans)
  - level: RequestResponse
    users: ["*"]
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
  
  # Log all admin actions with full request body
  - level: RequestResponse
    userGroups: ["system:masters", "cluster-admin"]
    omitStages: ["RequestReceived"]
  
  # Log all RBAC changes
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources: ["roles", "clusterroles", "rolebindings", "clusterrolebindings"]
  
  # Log pod exec (someone SSHing into a container)
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]
  
  # Default: metadata only (who did what, not full body)
  - level: Metadata
```

```bash
# Store audit logs to CloudWatch or S3 with tamper-proof retention
# kube-apiserver flags:
--audit-log-path=/var/log/kubernetes/audit.log
--audit-log-maxage=90          # retain 90 days locally
--audit-log-maxbackup=10
--audit-log-maxsize=100        # 100MB per file
--audit-policy-file=/etc/kubernetes/audit-policy.yaml

# Ship to S3 (immutable, versioned)
# Use Fluent Bit to forward /var/log/kubernetes/audit.log → S3 bucket
# S3 bucket: enable versioning + Object Lock (WORM) for audit integrity
```

**b) Access review reports:**

```bash
# Generate a timestamped report of who has what access
# Run monthly and store output as evidence

DATE=$(date +%Y-%m-%d)
REPORT_FILE="access-review-${DATE}.txt"

echo "=== Kubernetes RBAC Access Review: ${DATE} ===" > $REPORT_FILE
echo "" >> $REPORT_FILE

echo "--- ClusterRoleBindings (cluster-wide admin access) ---" >> $REPORT_FILE
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] | select(.roleRef.name == "cluster-admin") | 
    "ClusterRoleBinding: \(.metadata.name)\n  Subjects: \(.subjects)"' >> $REPORT_FILE

echo "" >> $REPORT_FILE
echo "--- All RoleBindings in production namespace ---" >> $REPORT_FILE
kubectl get rolebindings -n production -o wide >> $REPORT_FILE

echo "" >> $REPORT_FILE
echo "--- Service accounts with auto-mounted tokens ---" >> $REPORT_FILE
kubectl get serviceaccounts -A -o json | \
  jq -r '.items[] | select(.automountServiceAccountToken != false) | 
    "\(.metadata.namespace)/\(.metadata.name)"' >> $REPORT_FILE

# Upload to evidence bucket
aws s3 cp $REPORT_FILE s3://audit-evidence-bucket/rbac/${DATE}/
echo "Uploaded: s3://audit-evidence-bucket/rbac/${DATE}/${REPORT_FILE}"
```

**c) Change management evidence:**

Every firewall rule change, RBAC modification, or security group update must have a change ticket (Jira, ServiceNow) referenced in the commit or API call. Achieve this via:

```bash
# Require change ticket in Terraform commit message (pre-commit hook)
cat .git/hooks/commit-msg
#!/bin/bash
COMMIT_MSG=$(cat "$1")
if ! echo "$COMMIT_MSG" | grep -qE "CHG-[0-9]+|HOTFIX-[0-9]+"; then
  echo "ERROR: Commit message must reference a change ticket (e.g., CHG-1234)"
  exit 1
fi
```

<div class="quiz-card">
  <p class="quiz-q">A team has RBAC configured correctly (a ClusterRole with <code>verbs: [get, list]</code>) and calls it done. What does a CERT-In auditor say is still missing?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>RBAC config alone isn't evidence a control operated. Auditors want documented, timestamped proof: immutable API audit logs, monthly access-review reports, and change tickets linked to every RBAC/firewall modification &mdash; not just the policy file itself.</div>
</div>

### 6-Hour Incident Reporting to CERT-In

CERT-In's 2022 directive requires reporting cybersecurity incidents within **6 hours** of detection. This means your alerting and escalation pipeline must be fast:

```mermaid
graph TD
    A["Alert fires<br/>(CloudWatch / Prometheus)"] -->|"< 5 minutes"| B["On-call engineer notified<br/>(PagerDuty)"]
    B -->|"< 30 minutes"| C["Incident declared,<br/>IR team assembled"]
    C -->|"< 2 hours"| D["Initial assessment:<br/>is it a reportable incident?"]
    D -->|"< 4 hours"| E["Report filed with CERT-In portal<br/>(cert-in.org.in)"]
    E -->|"within 6 hours of detection"| F["Internal post-incident report<br/>(within 14 days)"]
```

Step through the same pipeline:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Alert fires.</strong> CloudWatch or Prometheus detects the anomaly. This is the moment CERT-In's 6-hour reporting clock starts.
    </div>
    <div class="stepper-panel">
      <strong>2. On-call engineer notified.</strong> PagerDuty pages whoever's on call &mdash; within 5 minutes of the alert.
    </div>
    <div class="stepper-panel">
      <strong>3. Incident declared.</strong> The IR team is assembled &mdash; within 30 minutes.
    </div>
    <div class="stepper-panel">
      <strong>4. Initial assessment.</strong> Is this actually a CERT-In reportable incident? &mdash; within 2 hours.
    </div>
    <div class="stepper-panel">
      <strong>5. Report filed with CERT-In.</strong> Submitted via the CERT-In portal &mdash; within 4 hours of assessment, and within 6 hours of detection overall.
    </div>
    <div class="stepper-panel">
      <strong>6. Internal post-incident report.</strong> Written up separately &mdash; within 14 days.
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
  <p class="quiz-q">Per CERT-In's directive, from what point does the 6-hour reporting clock start counting?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>From detection &mdash; the moment the alert fires (e.g. CloudWatch/Prometheus) &mdash; not from when the incident is confirmed or declared. The report to CERT-In's portal must be filed within 6 hours of that detection; the internal post-incident report has a separate, longer 14-day window.</div>
</div>

```bash
# Automate CERT-In reportable incident detection via CloudTrail + Lambda
# Trigger on: unauthorized API calls, root login, IAM policy changes, S3 public access

# CloudTrail → EventBridge rule → Lambda → creates Jira ticket + notifies IR team
aws events put-rule \
  --name cert-in-incident-trigger \
  --event-pattern '{
    "source": ["aws.cloudtrail"],
    "detail-type": ["AWS API Call via CloudTrail"],
    "detail": {
      "errorCode": ["AccessDenied", "UnauthorizedAccess"],
      "userIdentity": {
        "type": ["Root"]
      }
    }
  }'
```

---

## 3. Zero-Downtime Secrets Rotation

### The Problem

A trading system is stateful. The order management system has live TCP connections to the database. If you rotate the DB password:

```mermaid
graph TD
    S1["1. Change DB password in RDS"] --> S2["2. Update secret in Secrets Manager"]
    S2 --> S3["3. Restart pods to pick up new secret"]
    S3 --> Outage["10–30 second outage<br/>live orders in-flight lost<br/>exchange may penalize erratic order flow"]

    style Outage fill:#c0392b,stroke:#c0392b,color:#fff
```

For a system handling thousands of orders per second, a 10-second outage means open positions exposed to market risk. Zero-downtime rotation requires the DB to accept **both old and new passwords simultaneously** during the transition window.

<div class="quiz-card">
  <p class="quiz-q">Why does simply changing the DB password and restarting pods ("naive rotation") cause an outage on a live trading system?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Restarting the pods to pick up the new password drops their live DB connections while they reconnect &mdash; a 10&ndash;30 second gap where in-flight orders are lost. Zero-downtime rotation instead requires the DB to accept both the old and new passwords simultaneously, so existing connections keep working until they reconnect on their own schedule.</div>
</div>

### Zero-Downtime Rotation: AWS Secrets Manager

AWS Secrets Manager supports a rotation strategy where the DB accepts both credentials during rotation. Step through the phases:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>Phase 1: Create new secret version.</strong> A new password is generated and stored as <code>AWSPENDING</code> &mdash; the current <code>AWSCURRENT</code> version keeps serving unchanged. Lambda step: <code>createSecret</code>.
    </div>
    <div class="stepper-panel">
      <strong>Phase 2: Update DB to accept BOTH old and new passwords.</strong> The database is told about the new password while the old one still works. This dual-auth window is what makes the rotation zero-downtime. Lambda step: <code>setSecret</code>.
    </div>
    <div class="stepper-panel">
      <strong>Phase 3: Verify the new password works.</strong> A test connection using the <code>AWSPENDING</code> credentials confirms they're valid before anything gets promoted. Lambda step: <code>testSecret</code>.
    </div>
    <div class="stepper-panel">
      <strong>Phase 4: Mark new version as AWSCURRENT.</strong> <code>AWSPENDING</code> is promoted to <code>AWSCURRENT</code>. Existing connections using the old password keep working until they reconnect; new connections pick up the new password. Lambda step: <code>finishSecret</code>.
    </div>
    <div class="stepper-panel">
      <strong>Phase 5: Delete the old password from the DB.</strong> Only now is the old credential actually removed &mdash; after every step above confirmed the new one works and is live.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```python
# Lambda rotation function (Python)
import boto3
import json

def lambda_handler(event, context):
    arn = event['SecretId']
    token = event['ClientRequestToken']
    step = event['Step']

    service_client = boto3.client('secretsmanager')
    rds_client = boto3.client('rds')

    if step == "createSecret":
        # Generate new credentials, store as AWSPENDING
        current_secret = json.loads(
            service_client.get_secret_value(SecretId=arn, VersionStage="AWSCURRENT")['SecretString']
        )
        new_password = generate_strong_password()
        new_secret = {**current_secret, "password": new_password}
        
        service_client.put_secret_value(
            SecretId=arn,
            ClientRequestToken=token,
            SecretString=json.dumps(new_secret),
            VersionStages=['AWSPENDING']
        )

    elif step == "setSecret":
        # Add NEW password to DB while OLD password still works
        # For PostgreSQL: ALTER USER trading_app WITH PASSWORD 'new_password';
        # For the brief overlap, DB accepts BOTH via a temp dual-auth approach
        current = get_secret(arn, "AWSCURRENT")
        pending = get_secret(arn, "AWSPENDING")
        
        conn = connect_db(current)  # connect with old password
        conn.execute(f"ALTER USER {pending['username']} WITH PASSWORD '{pending['password']}'")
        # ← DB now accepts new password. Old connections still work (existing sessions)

    elif step == "testSecret":
        # Verify new credentials actually work
        pending = get_secret(arn, "AWSPENDING")
        test_conn = connect_db(pending)  # must succeed
        test_conn.execute("SELECT 1")

    elif step == "finishSecret":
        # Promote AWSPENDING → AWSCURRENT
        service_client.update_secret_version_stage(
            SecretId=arn,
            VersionStage="AWSCURRENT",
            MoveToVersionId=token,
            RemoveFromVersionId=get_current_version_id(arn)
        )
        # Existing connections using old password still work until they reconnect
        # New connections use the new password from Secrets Manager
```

<div class="quiz-card">
  <p class="quiz-q">In AWS Secrets Manager's rotation, at which phase does the database first accept the NEW password while the OLD one still works?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Phase 2 (<code>setSecret</code>) &mdash; the DB is updated to accept both passwords before the new one is even verified (Phase 3) or promoted to AWSCURRENT (Phase 4). That overlap window is what makes the rotation zero-downtime.</div>
</div>

### Zero-Downtime Rotation: HashiCorp Vault Dynamic Secrets

Vault's dynamic secrets engine is better than static rotation — it **generates unique credentials per service instance**, with a TTL. No "rotation event" exists — credentials expire naturally.

```mermaid
sequenceDiagram
    participant APP as Trading App Pod
    participant AGENT as Vault Agent Sidecar
    participant VAULT as HashiCorp Vault
    participant DB as PostgreSQL

    APP->>AGENT: start up
    AGENT->>VAULT: authenticate (Kubernetes auth, using K8s SA token)
    VAULT->>VAULT: verify K8s SA is allowed to get db/creds/trading-role
    VAULT->>DB: CREATE USER vault_abc123 WITH PASSWORD 'x9k2...' VALID UNTIL '...'
    VAULT-->>AGENT: {username: vault_abc123, password: x9k2..., ttl: 1h}
    AGENT-->>APP: write credentials to file /vault/secrets/db-creds

    Note over APP,DB: App connects using vault_abc123

    Note over AGENT,VAULT: At 50% of TTL (30 min), Vault renews

    AGENT->>VAULT: renew lease for vault_abc123
    VAULT-->>AGENT: ttl extended to 1h from now

    Note over AGENT,VAULT: If app is shut down, lease is revoked

    AGENT->>VAULT: revoke lease
    VAULT->>DB: DROP USER vault_abc123
```

```bash
# Setup Vault dynamic secrets for PostgreSQL
vault secrets enable database

vault write database/config/trading-db \
  plugin_name=postgresql-database-plugin \
  allowed_roles="trading-app" \
  connection_url="postgresql://{{username}}:{{password}}@prod-db:5432/trades" \
  username="vault-admin" \
  password="admin-password"

# Define role: what SQL to run to create/revoke credentials
vault write database/roles/trading-app \
  db_name=trading-db \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
  " \
  revocation_statements="DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"
```

```yaml
# Kubernetes: Vault Agent Sidecar injection
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-management
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "trading-app"
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/trading-app"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/trading-app" -}}
          DB_USERNAME={{ .Data.username }}
          DB_PASSWORD={{ .Data.password }}
          {{- end }}
    spec:
      serviceAccountName: trading-app-sa  # bound to Vault role
      containers:
      - name: order-management
        image: trading/oms:latest
        # App reads /vault/secrets/db-creds, Vault agent updates it before TTL expiry
        # No restart needed — app re-reads file on next connection attempt
```

Two genuinely different approaches to rotation, side by side:

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="secretsmanager" class="active">AWS Secrets Manager</button>
    <button data-tab="vault">Vault Dynamic Secrets</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="secretsmanager">
      <strong>Static credential, rotated on a schedule.</strong> One shared password per role, changed periodically through a real "rotation event" (Phases 1&ndash;5). Zero-downtime requires the DB to accept the old and new password simultaneously during the AWSPENDING &rarr; AWSCURRENT transition.
    </div>
    <div class="tab-panel" data-tab-panel="vault">
      <strong>Unique credential per service instance, with a TTL.</strong> Vault generates a new username/password for every app instance that authenticates, valid for a limited time (e.g. 1h), renewed automatically at 50% of TTL. No "rotation event" exists &mdash; credentials just expire naturally, or get revoked the moment the app shuts down.
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Does HashiCorp Vault's dynamic secrets approach have a "rotation event" the way AWS Secrets Manager does?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. Vault issues a unique credential per service instance with a TTL, renewing it automatically at 50% of that TTL and revoking it when the app shuts down. Credentials just expire naturally instead of going through a discrete before/after rotation event.</div>
</div>

### Application-Side: Connection Pool Rotation Without Restart

The app must handle credential rotation without dropping live connections:

```python
# Python: PgBouncer + connection pool with credential refresh
import psycopg2
import threading
import time
import os

class RefreshingConnectionPool:
    def __init__(self, creds_file="/vault/secrets/db-creds"):
        self.creds_file = creds_file
        self.pool = None
        self.lock = threading.Lock()
        self._refresh_credentials()
        # Background thread refreshes every 5 minutes
        threading.Thread(target=self._background_refresh, daemon=True).start()

    def _read_creds(self):
        creds = {}
        with open(self.creds_file) as f:
            for line in f:
                k, v = line.strip().split("=", 1)
                creds[k] = v
        return creds

    def _refresh_credentials(self):
        creds = self._read_creds()
        new_pool = create_pool(
            host=os.environ["DB_HOST"],
            user=creds["DB_USERNAME"],
            password=creds["DB_PASSWORD"],
            database="trades"
        )
        with self.lock:
            old_pool = self.pool
            self.pool = new_pool
            if old_pool:
                # Drain old pool — existing queries finish, then connections close
                old_pool.closeall()  # closes after current transactions complete

    def _background_refresh(self):
        while True:
            time.sleep(300)   # check every 5 minutes
            self._refresh_credentials()

    def get_connection(self):
        with self.lock:
            return self.pool.getconn()
```

---

## Audit Evidence Checklist (CERT-In / SEBI)

| Control | Evidence Required | Frequency |
|---------|------------------|-----------|
| RBAC access review | Exported role bindings + sign-off | Monthly |
| Admin session logs | PAM tool export (who ran what, when) | On demand (keep 1yr) |
| Firewall rule review | Current rules + change tickets | Quarterly |
| Secret rotation | Vault/Secrets Manager rotation log | Per rotation event |
| VAPT (Vulnerability Assessment) | Report from CERT-In empaneled firm | 6-monthly (Cat I/II) |
| Incident response drill | Drill scenario + timeline + outcomes | Annual |
| Employee access revocation | Ticket closed within 24hr of exit | Per offboarding |
| Data backup test | Restore test result + timestamp | Quarterly |
| MFA enforcement | IAM policy + login logs showing MFA | On demand |
| Log retention | S3 lifecycle rule + sample log access | On demand |

---

## SEBI CSCRF Incident Classification

| Severity | Examples | Report to CERT-In |
|----------|----------|------------------|
| **Critical** | Ransomware, trading halt, exchange connectivity down | Within 6 hours |
| **High** | Unauthorized access to trading systems, data exfiltration | Within 6 hours |
| **Medium** | DDoS on public portal, credential compromise | Within 24 hours |
| **Low** | Phishing attempt (no compromise), single VM issue | Within 72 hours |
