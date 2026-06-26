# Helm

## 1. Architecture

```mermaid
flowchart LR
    CLI[Helm CLI] --> CH[Chart<br/>tgz / dir]
    CH --> TE[Template Engine<br/>Go text/template]
    TE --> MF[Rendered Manifests]
    MF --> KA[K8s API Server]
    KA --> ET[etcd]
    CLI --> REL[Release Record<br/>stored as Secret]
    REL --> KA
```

---

## 2. Chart Structure

```mermaid
flowchart TD
    ROOT[mychart/] --> CY[Chart.yaml<br/>name · version · appVersion]
    ROOT --> VY[values.yaml<br/>default values]
    ROOT --> TMP[templates/]
    ROOT --> CH[charts/<br/>subcharts]
    ROOT --> NT[NOTES.txt<br/>post-install msg]
    TMP --> HP[_helpers.tpl<br/>named templates]
    TMP --> DY[deployment.yaml]
    TMP --> SY[service.yaml]
    TMP --> INY[ingress.yaml]
    TMP --> TSY[tests/test-*.yaml]
```

**Chart.yaml essentials:**
```yaml
apiVersion: v2
name: mychart
description: My application chart
type: application      # or library
version: 1.2.3         # chart version (SemVer)
appVersion: "2.0.0"    # app version (informational)
dependencies:
  - name: redis
    version: "18.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
```

---

## 3. Core Commands

```bash
# Repo management
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm search repo nginx
helm search hub nginx                        # Artifact Hub

# Install
helm install <release> <chart> -n <ns>
helm install myapp ./mychart -f prod-values.yaml
helm install myapp oci://registry/chart:1.0.0

# Upgrade
helm upgrade myapp ./mychart --install      # upsert
helm upgrade myapp ./mychart \
  --set image.tag=2.0.0 \
  --atomic \                                # rollback on failure
  --timeout 5m

# Rollback
helm rollback myapp 2                       # to revision 2
helm rollback myapp 0                       # to previous

# Uninstall
helm uninstall myapp -n <ns>
helm uninstall myapp --keep-history         # keep release record

# Inspect
helm list -A
helm status myapp -n <ns>
helm history myapp -n <ns>
helm get values myapp                       # user-supplied values
helm get all myapp                          # everything
```

---

## 4. Templating

```yaml
# values.yaml
replicaCount: 2
image:
  repository: nginx
  tag: "1.25"
service:
  port: 80
```

```yaml
# templates/deployment.yaml

# Values object
replicas: {{ .Values.replicaCount }}

# Release built-ins
name: {{ .Release.Name }}-app
namespace: {{ .Release.Namespace }}
isUpgrade: {{ .Release.IsUpgrade }}

# Chart metadata
chartVersion: {{ .Chart.Version }}

# Embed a file
config: {{ .Files.Get "config/app.conf" | b64enc }}

# Range (loop)
env:
{{- range $k, $v := .Values.envVars }}
  - name: {{ $k }}
    value: {{ $v | quote }}
{{- end }}

# if / else
{{- if .Values.ingress.enabled }}
# ... ingress spec
{{- else }}
# fallback
{{- end }}

# include named template from _helpers.tpl
labels: {{- include "mychart.labels" . | nindent 4 }}

# tpl: render string as template
{{- tpl .Values.configTemplate . }}
```

**_helpers.tpl pattern:**
```yaml
{{- define "mychart.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

---

## 5. Hooks

```mermaid
flowchart TD
    PI[pre-install] --> INST[Resources Created]
    INST --> PO[post-install]
    PU[pre-upgrade] --> UPG[Resources Updated]
    UPG --> POU[post-upgrade]
    PR[pre-rollback] --> RB[Resources Rolled Back]
    RB --> POR[post-rollback]
    PD[pre-delete] --> DEL[Resources Deleted]
    DEL --> POD[post-delete]
```

```yaml
# Hook job example
metadata:
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-weight": "-5"          # lower runs first
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
```

**Hook weights:** lower number = runs first. Multiple hooks at same weight run in name order.

**Delete policies:**
- `before-hook-creation` — delete previous run before this one (default)
- `hook-succeeded` — delete after success
- `hook-failed` — delete after failure

---

## 6. Library Charts and Dependencies

```yaml
# Chart.yaml — declare dependency
dependencies:
  - name: postgresql
    version: "13.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled    # toggle via values
    tags:
      - database

# Update dependency lock
helm dependency update ./mychart
# Downloads to charts/ as tarballs
```

**Library chart** (`type: library`): reusable named templates only, never deployed directly.

```yaml
# Chart.yaml of library
apiVersion: v2
name: mylib
type: library
version: 0.1.0
```

```yaml
# Consume it
dependencies:
  - name: mylib
    version: "0.1.x"
    repository: "file://../mylib"
```

---

## 7. Helmfile

```yaml
# helmfile.yaml
repositories:
  - name: bitnami
    url: https://charts.bitnami.com/bitnami

releases:
  - name: redis
    namespace: infra
    chart: bitnami/redis
    version: "18.6.0"
    values:
      - values/redis.yaml

  - name: myapp
    namespace: app
    chart: ./charts/myapp
    values:
      - values/myapp-{{ .Environment.Name }}.yaml
    needs:
      - infra/redis              # deploy after redis

environments:
  staging:
    values:
      - envs/staging.yaml
  production:
    values:
      - envs/production.yaml
```

```bash
helmfile sync                     # apply all releases
helmfile diff                     # show pending changes
helmfile apply                    # diff + sync
helmfile destroy                  # uninstall all
helmfile -e production sync       # target environment
helmfile -l name=myapp sync       # target by label
```

---

## 8. Debugging

```bash
# Render templates locally (no cluster needed)
helm template myapp ./mychart -f values.yaml

# Render single template
helm template myapp ./mychart -s templates/deployment.yaml

# Lint
helm lint ./mychart
helm lint ./mychart -f prod-values.yaml

# Dry-run against cluster (server-side validation)
helm install myapp ./mychart --dry-run --debug

# helm diff plugin (shows what upgrade will change)
helm plugin install https://github.com/databus23/helm-diff
helm diff upgrade myapp ./mychart -f values.yaml

# Inspect rendered values
helm get values myapp -a              # all (including defaults)
helm get manifest myapp               # live rendered manifests

# Upgrade flow
```

```mermaid
flowchart TD
    UV[helm upgrade called] --> FH[Fetch current<br/>release state]
    FH --> RT[Run pre-upgrade<br/>hooks]
    RT --> TM[Render templates]
    TM --> VL[Validate against<br/>API server]
    VL --> AP[Apply manifests]
    AP --> WA[Wait for rollout<br/>--atomic / --wait]
    WA --> OK{Success?}
    OK -->|yes| PH[Run post-upgrade<br/>hooks]
    OK -->|no| RB[Auto rollback<br/>if --atomic]
    PH --> DONE[Save new<br/>release revision]
```
