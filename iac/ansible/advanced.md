# Ansible Advanced

Roles, collections, Ansible Vault, AWX/Tower, performance tuning, and testing strategies.

---

## Roles

A role is a reusable, self-contained unit of automation. Instead of one giant playbook, you split work into roles and compose them.

### Role Directory Structure

```
roles/
└── nginx/
    ├── defaults/
    │   └── main.yml        # lowest precedence variables (overridable)
    ├── vars/
    │   └── main.yml        # higher precedence variables (rarely overridden)
    ├── tasks/
    │   ├── main.yml        # entry point — import other task files here
    │   ├── install.yml
    │   └── configure.yml
    ├── handlers/
    │   └── main.yml        # handlers for this role
    ├── templates/
    │   └── nginx.conf.j2   # Jinja2 templates
    ├── files/
    │   └── index.html      # static files
    ├── meta/
    │   └── main.yml        # role metadata + dependencies
    └── README.md
```

### Role: defaults/main.yml

```yaml
# roles/nginx/defaults/main.yml
nginx_user: www-data
nginx_worker_processes: "{{ ansible_processor_count }}"
nginx_worker_connections: 1024
nginx_port: 80
ssl_enabled: false
ssl_cert_path: /etc/ssl/certs/nginx.crt
ssl_key_path: /etc/ssl/private/nginx.key
```

### Role: tasks/main.yml

```yaml
# roles/nginx/tasks/main.yml
---
- name: Include OS-specific variables
  ansible.builtin.include_vars: "{{ ansible_os_family | lower }}.yml"

- name: Install nginx
  ansible.builtin.import_tasks: install.yml

- name: Configure nginx
  ansible.builtin.import_tasks: configure.yml

- name: Start nginx
  ansible.builtin.service:
    name: nginx
    state: started
    enabled: true
```

### Role: tasks/configure.yml

```yaml
# roles/nginx/tasks/configure.yml
---
- name: Create nginx config directory
  ansible.builtin.file:
    path: /etc/nginx/conf.d
    state: directory
    mode: "0755"

- name: Deploy main nginx config
  ansible.builtin.template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf
    owner: root
    mode: "0644"
    validate: nginx -t -c %s      # validate before replacing
  notify: Reload nginx

- name: Deploy site configs
  ansible.builtin.template:
    src: "site.conf.j2"
    dest: "/etc/nginx/conf.d/{{ item.name }}.conf"
    mode: "0644"
  loop: "{{ nginx_vhosts }}"
  notify: Reload nginx
  when: nginx_vhosts is defined
```

### Role: meta/main.yml

```yaml
# roles/nginx/meta/main.yml
galaxy_info:
  author: yourname
  description: Install and configure nginx
  license: MIT
  min_ansible_version: "2.14"
  platforms:
    - name: Ubuntu
      versions: ["22.04", "20.04"]
    - name: EL
      versions: ["8", "9"]

dependencies:
  - role: common            # runs before this role
  - role: ssl_certs
    vars:
      domain: "{{ app_domain }}"
    when: ssl_enabled
```

### Using Roles in a Playbook

```yaml
# site.yml
---
- name: Configure web servers
  hosts: web
  become: true

  roles:
    - common                    # simple role reference
    - role: nginx               # explicit form
      vars:
        nginx_port: 443
        ssl_enabled: true
    - role: myapp
      tags: app                 # all tasks in role get this tag

  # roles run before tasks
  tasks:
    - name: Final smoke test
      ansible.builtin.uri:
        url: "http://localhost/health"
```

### Creating a Role with ansible-galaxy

```bash
ansible-galaxy role init roles/nginx
ansible-galaxy role init roles/myapp --offline
```

---

## Collections

Collections are the packaging format for distributing roles, modules, plugins, and playbooks together. Introduced in Ansible 2.9.

```
namespace.collection_name
amazon.aws         # AWS modules (official)
google.cloud       # GCP modules (official)
community.general  # hundreds of community modules
ansible.posix      # POSIX-focused modules (mount, sysctl, etc.)
```

### Installing Collections

```bash
# From Ansible Galaxy
ansible-galaxy collection install amazon.aws
ansible-galaxy collection install community.general

# Pin version
ansible-galaxy collection install amazon.aws:==7.0.0

# From requirements file
ansible-galaxy collection install -r requirements.yml
```

```yaml
# requirements.yml
collections:
  - name: amazon.aws
    version: ">=7.0.0"
  - name: google.cloud
    version: ">=1.3.0"
  - name: community.general
  - name: ansible.posix

roles:
  - name: geerlingguy.nginx
    version: "3.1.0"
```

```bash
# Install all requirements
ansible-galaxy install -r requirements.yml
ansible-galaxy collection install -r requirements.yml
```

### Using Collection Modules

```yaml
# FQCN (Fully Qualified Collection Name) — always preferred
- amazon.aws.ec2_instance:
    name: web01

# Short name (only works if collection is in ansible.cfg)
- ec2_instance:
    name: web01
```

```ini
# ansible.cfg — set collection search path
[defaults]
collections_paths = ./collections:~/.ansible/collections
```

---

## Ansible Vault

Vault encrypts sensitive data at rest. Encrypted files live in your repo — secrets never travel in plaintext.

```mermaid
flowchart TD
    A[Plain secret: db_password=s3cr3t] -->|ansible-vault encrypt| B[AES256 encrypted blob]
    B -->|commit to git| C[Repository]
    C -->|ansible-playbook --vault-password-file| D[Decrypt at runtime]
    D --> E[Variable available in play]
```

### Encrypting Files

```bash
# Encrypt an entire file
ansible-vault encrypt group_vars/all/vault.yml

# Create new encrypted file
ansible-vault create group_vars/production/vault.yml

# Edit encrypted file (opens $EDITOR)
ansible-vault edit group_vars/production/vault.yml

# View without decrypting to disk
ansible-vault view group_vars/production/vault.yml

# Re-key (change password)
ansible-vault rekey group_vars/production/vault.yml

# Decrypt to plain text
ansible-vault decrypt group_vars/production/vault.yml
```

### Encrypting Individual Values (inline)

```bash
# Encrypt a single string
ansible-vault encrypt_string 's3cr3tpassword' --name 'db_password'

# Output — paste into vars file
db_password: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  3036343832353065363465383834306462623035313630363261353666323766313865313164626233
  ...
```

```yaml
# group_vars/production/vault.yml
vault_db_password: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  303634383235306536346538383430...

# group_vars/production/vars.yml (plain — references vault var)
db_password: "{{ vault_db_password }}"
```

### Running Playbooks with Vault

```bash
# Interactive password prompt
ansible-playbook site.yml --ask-vault-pass

# Password from file (CI/CD)
ansible-playbook site.yml --vault-password-file ~/.vault_pass

# Password from environment variable
export ANSIBLE_VAULT_PASSWORD_FILE=~/.vault_pass
ansible-playbook site.yml

# Multiple vault IDs (different passwords for different environments)
ansible-playbook site.yml \
  --vault-id dev@~/.vault_dev \
  --vault-id prod@~/.vault_prod
```

### Multiple Vault IDs

```bash
# Encrypt with a specific vault ID label
ansible-vault encrypt_string 's3cr3t' \
  --vault-id prod@~/.vault_prod \
  --name db_password

# The encrypted value is tagged with vault ID
db_password: !vault |
  $ANSIBLE_VAULT;1.2;AES256;prod
  ...
```

### Vault Best Practices

```
group_vars/
├── all/
│   └── vars.yml           # plain variables
├── production/
│   ├── vars.yml           # plain — references vault_ prefixed vars
│   └── vault.yml          # encrypted — contains vault_ prefixed vars
└── staging/
    ├── vars.yml
    └── vault.yml
```

Convention: prefix all vault variables with `vault_`, reference them from plain vars files. This way you can view `vars.yml` without decrypting anything.

---

## AWX / Ansible Tower

AWX is the open-source version of Red Hat Ansible Automation Platform (AAP/Tower). It provides a web UI, REST API, RBAC, schedules, and centralized credentials for Ansible.

```mermaid
graph TD
    subgraph AWX
        UI[Web UI / REST API]
        JobTemplates[Job Templates]
        Inventory[Managed Inventory]
        Credentials[Credential Store]
        Projects[Projects - Git repos]
        Scheduler[Scheduler]
        CallbackURL[Webhook / Provisioning Callback]
    end

    UI --> JobTemplates
    JobTemplates --> Inventory
    JobTemplates --> Credentials
    JobTemplates --> Projects
    Scheduler -->|triggers| JobTemplates
    CallbackURL -->|triggers| JobTemplates

    subgraph Execution
        EE[Execution Environment - container]
        ManagedHosts[Managed Hosts]
    end

    JobTemplates --> EE
    EE -->|SSH/SSM/WinRM| ManagedHosts

    subgraph Sources
        Git[Git repo - playbooks]
        Vault[HashiCorp Vault / AWS SM]
        LDAP[LDAP / SSO]
    end

    Projects --> Git
    Credentials --> Vault
    UI --> LDAP
```

### Key AWX Concepts

| Concept | Description |
|---------|-------------|
| Organization | Top-level tenant. Users, teams, inventories scoped per org |
| Project | A Git repository containing playbooks |
| Inventory | Static or dynamic inventory (synced from cloud/LDAP) |
| Credential | SSH key, AWS IAM, Vault token — stored encrypted |
| Job Template | Playbook + inventory + credential + extra_vars |
| Workflow | DAG of job templates with conditional branches |
| Execution Environment | OCI container image with Ansible + dependencies |
| Notification | Slack/email/webhook on job success/failure |

### AWX via kubectl (K8s install)

```bash
# Install AWX Operator
kubectl apply -k github.com/ansible/awx-operator/config/default?ref=2.x.x

# Create AWX instance
cat <<EOF | kubectl apply -f -
apiVersion: awx.ansible.com/v1beta1
kind: AWX
metadata:
  name: awx
spec:
  service_type: ClusterIP
  ingress_type: ingress
  hostname: awx.example.com
EOF

# Get admin password
kubectl get secret awx-admin-password -o jsonpath='{.data.password}' | base64 -d
```

### Execution Environments (EE)

EEs replaced the old Python venv approach. A job always runs in a container with pinned Ansible + collections + Python deps.

```yaml
# execution-environment.yml
version: 3
images:
  base_image:
    name: registry.redhat.io/ansible-automation-platform/ee-minimal-rhel8:latest

dependencies:
  galaxy:
    collections:
      - name: amazon.aws
        version: ">=7.0.0"
      - name: community.general
  python:
    - boto3>=1.28
    - botocore>=1.31
  system:
    - git [platform:rpm]

build_arg_defaults:
  EE_BASE_IMAGE: quay.io/ansible/awx-ee:latest
```

```bash
# Build EE image
pip install ansible-builder
ansible-builder build -t my-ee:1.0 -f execution-environment.yml
docker push my-registry/my-ee:1.0
```

---

## Performance Tuning

### forks — Parallel Connections

```ini
# ansible.cfg
[defaults]
forks = 50    # default is 5 — increase dramatically for large fleets
```

```bash
# Override at runtime
ansible-playbook site.yml -f 50
```

### Pipelining

Without pipelining: for each task Ansible SCP-uploads the module, then runs it (2 SSH round trips).  
With pipelining: module is sent via stdin in one round trip.

```ini
[ssh_connection]
pipelining = True    # ~3-5x faster for many tasks
```

**Requires:** `requiretty` must be disabled in `/etc/sudoers` (or use `Defaults !requiretty`).

### SSH ControlMaster (Persistent Connections)

```ini
[ssh_connection]
ssh_args = -o ControlMaster=auto -o ControlPath=/tmp/ansible-ssh-%h-%p-%r -o ControlPersist=60s
```

Reuses the SSH connection for all tasks on a host within 60 seconds instead of opening a new TCP connection per task.

### Fact Caching

Gathering facts adds ~0.5-2s per host. Cache them to skip on subsequent runs.

```ini
[defaults]
gathering          = smart          # skip if cached, gather if not
fact_caching       = jsonfile
fact_caching_connection = /tmp/ansible_facts_cache
fact_caching_timeout = 86400        # 24 hours in seconds
```

```ini
# Redis cache (better for distributed teams)
fact_caching       = redis
fact_caching_connection = localhost:6379:0
fact_caching_timeout = 86400
```

### Async Tasks

Run slow tasks in the background, poll for completion:

```yaml
- name: Long-running backup (don't block)
  ansible.builtin.command: /usr/local/bin/backup.sh
  async: 3600          # max time to wait (seconds)
  poll: 0              # 0 = fire and forget, check later
  register: backup_job

# ... other tasks run here in parallel ...

- name: Wait for backup to complete
  ansible.builtin.async_status:
    jid: "{{ backup_job.ansible_job_id }}"
  register: backup_result
  until: backup_result.finished
  retries: 60
  delay: 30
```

### Strategy Plugins

```yaml
- hosts: web
  strategy: free          # each host runs independently, don't wait for others
  # strategy: linear     # default — all hosts complete task N before task N+1
  # strategy: host_pinned # like free but respects serial
```

### Rolling Updates with serial

```yaml
- hosts: web
  serial: "25%"         # update 25% of fleet at a time
  # serial: 2           # 2 hosts at a time
  # serial: [1, 5, 10]  # canary: 1, then 5, then 10 at a time
  max_fail_percentage: 10
```

---

## Testing Ansible

### Molecule — Unit/Integration Testing for Roles

```bash
pip install molecule molecule-docker
cd roles/nginx
molecule init scenario --driver-name docker
```

```yaml
# molecule/default/molecule.yml
driver:
  name: docker
platforms:
  - name: ubuntu22
    image: geerlingguy/docker-ubuntu2204-ansible
    pre_build_image: true
  - name: centos9
    image: geerlingguy/docker-centos9-ansible
    pre_build_image: true

provisioner:
  name: ansible
  inventory:
    host_vars:
      ubuntu22:
        nginx_port: 80
      centos9:
        nginx_port: 8080

verifier:
  name: ansible
```

```yaml
# molecule/default/converge.yml
---
- name: Converge
  hosts: all
  become: true
  roles:
    - role: nginx
```

```yaml
# molecule/default/verify.yml
---
- name: Verify
  hosts: all
  tasks:
    - name: Check nginx is running
      ansible.builtin.service_facts:

    - name: Assert nginx is active
      ansible.builtin.assert:
        that:
          - ansible_facts.services['nginx.service'].state == 'running'
          - ansible_facts.services['nginx.service'].status == 'enabled'

    - name: Check nginx responds
      ansible.builtin.uri:
        url: "http://localhost:{{ nginx_port }}/"
        status_code: 200
```

```bash
# Full test cycle
molecule test            # create → converge → verify → destroy
molecule converge        # only provision (for iterative dev)
molecule verify          # only run verifier
molecule login           # SSH into test container
molecule destroy         # tear down
```

### ansible-lint

```bash
pip install ansible-lint

# Lint playbook
ansible-lint site.yml

# Lint all YAML in project
ansible-lint

# With config
cat .ansible-lint
warn_list:
  - no-changed-when
  - command-instead-of-shell
skip_list:
  - yaml[line-length]
```

### --check and --diff

```bash
# Dry run — show what would change, don't apply
ansible-playbook site.yml --check

# Show diffs for file changes
ansible-playbook site.yml --check --diff

# Both together (most useful for reviewing before apply)
ansible-playbook site.yml --check --diff -v
```

---

## Directory Layout — Production Project

```
project/
├── ansible.cfg
├── requirements.yml             # collections + roles
├── site.yml                     # master playbook (imports others)
├── webservers.yml               # play for web tier
├── dbservers.yml                # play for db tier
│
├── inventories/
│   ├── production/
│   │   ├── hosts.yml            # static inventory or dynamic plugin config
│   │   ├── group_vars/
│   │   │   ├── all/
│   │   │   │   ├── vars.yml
│   │   │   │   └── vault.yml    # encrypted
│   │   │   └── web/
│   │   │       └── vars.yml
│   │   └── host_vars/
│   │       └── web01.example.com.yml
│   └── staging/
│       └── ...
│
├── roles/
│   ├── common/
│   ├── nginx/
│   └── myapp/
│
├── collections/                 # vendored collections (for air-gapped)
│   └── ansible_collections/
│
└── molecule/                    # integration tests (or per-role)
```

---

## Debugging Playbooks

```bash
# Increase verbosity
ansible-playbook site.yml -v      # task results
ansible-playbook site.yml -vv     # file diffs + module args
ansible-playbook site.yml -vvv    # connection details
ansible-playbook site.yml -vvvv   # SSH debug output

# Run specific tasks by tag
ansible-playbook site.yml --tags "nginx,ssl"
ansible-playbook site.yml --skip-tags "slow_task"

# Run from a specific task
ansible-playbook site.yml --start-at-task "Deploy app config"

# Step through interactively
ansible-playbook site.yml --step

# Debug module — print variables
- ansible.builtin.debug:
    var: my_variable

- ansible.builtin.debug:
    msg: "Value is {{ my_variable }}, type is {{ my_variable | type_debug }}"

# Pause and inspect
- ansible.builtin.pause:
    prompt: "Check the state, press Enter to continue"

# Print all variables for a host
- ansible.builtin.debug:
    var: hostvars[inventory_hostname]
```

---

## Common Patterns

### Conditional Role Include

```yaml
roles:
  - role: monitoring
    when: monitoring_enabled | default(true) | bool
```

### Environment-Specific Variables

```bash
# Override for specific environment
ansible-playbook site.yml \
  -i inventories/production/ \
  -e "@overrides/production.yml" \
  --vault-password-file ~/.vault_prod
```

### Idempotency Guard — Run Once

```yaml
- name: Initialize database schema
  ansible.builtin.command: /opt/app/bin/db-migrate.sh
  args:
    creates: /var/lib/app/.db_initialized   # file acts as lock
  run_once: true
  delegate_to: "{{ groups['db'][0] }}"
```

### Wait for Service to be Ready

```yaml
- name: Wait for app port to open
  ansible.builtin.wait_for:
    host: "{{ ansible_host }}"
    port: 8080
    delay: 5
    timeout: 120
    state: started
```

---

## Windows Support (WinRM)

Ansible manages Windows hosts via WinRM (Windows Remote Management), not SSH.

```mermaid
sequenceDiagram
    participant C as Control Node Linux/Mac
    participant W as Windows Host

    C->>W: HTTP/HTTPS to port 5985/5986
    Note over W: WinRM listener running
    W->>W: Authenticate via Kerberos/NTLM/Basic
    C->>W: Send PowerShell commands
    W-->>C: Return JSON result
```

### Setup on Windows host (run as Administrator)

```powershell
# Enable WinRM and configure for Ansible
$url = "https://raw.githubusercontent.com/ansible/ansible/devel/examples/scripts/ConfigureRemotingForAnsible.ps1"
$file = "$env:temp\ConfigureRemotingForAnsible.ps1"
(New-Object -TypeName System.Net.WebClient).DownloadFile($url, $file)
powershell.exe -ExecutionPolicy ByPass -File $file
```

### Inventory for Windows

```ini
[windows]
win-server-01.example.com
win-server-02.example.com

[windows:vars]
ansible_user=Administrator
ansible_password="{{ vault_win_password }}"
ansible_connection=winrm
ansible_winrm_transport=ntlm         # or kerberos, credssp, basic
ansible_winrm_server_cert_validation=ignore
ansible_port=5986
```

### Windows modules

```yaml
# Install Windows feature
- ansible.windows.win_feature:
    name: Web-Server                  # IIS
    state: present
    include_management_tools: true

# Manage Windows service
- ansible.windows.win_service:
    name: W3SVC
    state: started
    start_mode: auto

# Copy file
- ansible.windows.win_copy:
    src: files/app.exe
    dest: C:\Apps\app.exe

# Run command
- ansible.windows.win_command:
    cmd: C:\Apps\setup.exe /quiet

# PowerShell script
- ansible.windows.win_shell: |
    Get-Service | Where-Object {$_.Status -eq 'Stopped'}

# Registry
- ansible.windows.win_regedit:
    path: HKLM:\SOFTWARE\MyApp
    name: Version
    data: "2.0"
    type: string

# Chocolatey package manager
- chocolatey.chocolatey.win_chocolatey:
    name: googlechrome
    state: present
```

```bash
pip install pywinrm           # required on control node
ansible-galaxy collection install ansible.windows
ansible-galaxy collection install chocolatey.chocolatey
```

---

## Lookup Plugins

Lookups pull data from external sources into variables at playbook parse time (on the control node, not the remote).

```yaml
# Read a file
vars:
  ssh_pub_key: "{{ lookup('file', '~/.ssh/id_rsa.pub') }}"

# Environment variable
  home_dir: "{{ lookup('env', 'HOME') }}"

# AWS SSM Parameter Store
  db_pass: "{{ lookup('amazon.aws.aws_ssm', '/prod/db/password', region='us-east-1') }}"

# HashiCorp Vault
  secret: "{{ lookup('community.hashi_vault.hashi_vault', 'secret/data/myapp token=s.xxxx') }}"

# Read lines from a file as a list
  server_list: "{{ lookup('file', 'servers.txt').splitlines() }}"

# URL (fetch remote content)
  latest_version: "{{ lookup('url', 'https://api.github.com/repos/org/repo/releases/latest') | from_json | json_query('tag_name') }}"

# Pipe (run command on control node)
  git_hash: "{{ lookup('pipe', 'git rev-parse --short HEAD') }}"

# CSV file
  # data/users.csv: name,uid,group
  user_info: "{{ lookup('csvfile', 'alice file=data/users.csv delimiter=, col=1') }}"
```

### query() vs lookup()

`lookup()` returns a comma-joined string for multi-value results.  
`query()` always returns a list — preferred with `loop`:

```yaml
- name: Loop over all matching files
  ansible.builtin.debug:
    msg: "{{ item }}"
  loop: "{{ query('fileglob', '/etc/ssl/certs/*.crt') }}"
```

---

## Advanced Filters and Tests

### selectattr / rejectattr — filter list of dicts

```yaml
vars:
  users:
    - { name: alice, active: true,  role: admin }
    - { name: bob,   active: false, role: user }
    - { name: carol, active: true,  role: user }

tasks:
  - name: Only active users
    debug:
      var: users | selectattr('active') | list
    # → [alice, carol]

  - name: Active admins only
    debug:
      var: users | selectattr('active') | selectattr('role', 'equalto', 'admin') | list
    # → [alice]

  - name: Inactive users
    debug:
      var: users | rejectattr('active') | list
    # → [bob]
```

### map — extract attribute from list

```yaml
  - name: List of usernames only
    debug:
      var: users | map(attribute='name') | list
    # → ['alice', 'bob', 'carol']

  - name: List of names uppercased
    debug:
      var: users | map(attribute='name') | map('upper') | list
```

### Tests — use with `is`

```yaml
when: my_var is defined
when: my_var is not defined
when: my_var is none
when: my_path is file
when: my_path is directory
when: my_string is match('^web.*')     # regex match from start
when: my_string is search('prod')      # regex search anywhere
when: my_var is number
when: my_list is iterable
when: 'admin' in my_roles_list
```

### Other useful filters

```yaml
# Combine dicts (right takes precedence)
"{{ defaults | combine(overrides, recursive=True) }}"

# Extract keys from list of dicts
"{{ items | map(attribute='id') | list }}"

# Flatten nested list
"{{ [[1,2],[3,[4,5]]] | flatten }}"
"{{ [[1,2],[3,[4,5]]] | flatten(levels=1) }}"

# Zip two lists
"{{ ['a','b'] | zip(['x','y']) | list }}"  # → [['a','x'],['b','y']]

# Product (cartesian)
"{{ regions | product(instance_types) | list }}"

# Unique
"{{ my_list | unique | sort }}"

# Random item from list
"{{ my_list | random }}"

# Format strings
"{{ '%s-%s' | format(env, region) }}"

# to_yaml / to_json — for debug or writing config files
"{{ my_dict | to_nice_yaml }}"
"{{ my_dict | to_nice_json }}"

# from_yaml / from_json — parse strings
"{{ raw_yaml_string | from_yaml }}"
```

---

## Custom Modules

When no built-in module fits, write your own in Python. Modules run on the managed node.

### Minimal module structure

```python
# library/my_module.py
from ansible.module_utils.basic import AnsibleModule

def run_module():
    argument_spec = dict(
        name=dict(type='str', required=True),
        state=dict(type='str', default='present', choices=['present', 'absent']),
        value=dict(type='int', required=False, default=0),
    )

    module = AnsibleModule(
        argument_spec=argument_spec,
        supports_check_mode=True,       # implement dry-run
    )

    name  = module.params['name']
    state = module.params['state']

    # Check current state
    current = get_current_state(name)   # your logic here
    changed = False

    if module.check_mode:
        module.exit_json(changed=(current != state), msg="Would change state")

    if state == 'present' and current != 'present':
        do_create(name, module.params['value'])
        changed = True
    elif state == 'absent' and current == 'present':
        do_delete(name)
        changed = True

    module.exit_json(
        changed=changed,
        name=name,
        state=state,
        msg=f"Resource {name} is {state}",
    )

def main():
    run_module()

if __name__ == '__main__':
    main()
```

### Using the custom module

```
project/
├── library/
│   └── my_module.py      # auto-discovered by Ansible
└── playbook.yml
```

```yaml
- name: Use custom module
  my_module:
    name: "myresource"
    state: present
    value: 42
  register: result
```

### Module return values

```python
module.exit_json(changed=False, msg="Already present", data={...})
module.fail_json(msg="Something went wrong", rc=1)
```

`exit_json` → task succeeds. `fail_json` → task fails, play stops (unless `ignore_errors: true`).

---

## Tags — Deep Dive

Tags let you run or skip subsets of a playbook without changing the file.

```yaml
- name: Install packages
  ansible.builtin.apt:
    name: nginx
  tags: [install, nginx]

- name: Configure nginx
  ansible.builtin.template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf
  tags: [configure, nginx]

- name: Always run this
  ansible.builtin.debug:
    msg: "This runs even with --tags"
  tags: always                      # 'always' is a special tag — runs regardless

- name: Never run by default
  ansible.builtin.command: /usr/local/bin/dangerous.sh
  tags: never                       # only runs if explicitly --tags never
```

```bash
# Run only nginx-tagged tasks
ansible-playbook site.yml --tags nginx

# Run install and configure
ansible-playbook site.yml --tags "install,configure"

# Skip slow tasks
ansible-playbook site.yml --skip-tags slow

# List all tags in a playbook
ansible-playbook site.yml --list-tags

# List tasks that would run
ansible-playbook site.yml --tags nginx --list-tasks
```

### Tag inheritance

Tags cascade: role tags apply to all tasks in the role, play tags apply to all tasks in the play.

```yaml
- hosts: web
  tags: web_tier             # all tasks in play inherit this tag
  roles:
    - role: nginx
      tags: nginx            # all tasks in role also get 'nginx' tag
```

---

## Delegation and local_action

Run a task on a different host than the play target. Classic use: register a backend with a load balancer, or run a DB migration once from a specific host.

```yaml
# delegate_to — run task on this host instead of current target
- name: Remove from load balancer before deploy
  ansible.builtin.uri:
    url: "http://lb.internal/api/deregister/{{ inventory_hostname }}"
    method: POST
  delegate_to: lb.internal          # runs on lb.internal, not the web server

# delegate_to localhost — run on control node
- name: Create DNS record in Route53
  amazon.aws.route53:
    zone: example.com
    record: "{{ inventory_hostname }}.example.com"
    type: A
    value: "{{ ansible_host }}"
  delegate_to: localhost
  run_once: true

# local_action — shorthand for delegate_to: localhost
- name: Write deployment log locally
  local_action:
    module: ansible.builtin.lineinfile
    path: /var/log/deployments.log
    line: "{{ inventory_hostname }} deployed at {{ ansible_date_time.iso8601 }}"
```

### delegate_facts

```yaml
- name: Gather facts from DB server, store on web server's vars
  ansible.builtin.setup:
  delegate_to: db01.internal
  delegate_facts: true           # facts stored under hostvars['db01.internal']
```

---

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Ansible
        run: pip install ansible boto3

      - name: Install collections
        run: ansible-galaxy collection install -r requirements.yml

      - name: Write SSH key
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.DEPLOY_KEY }}" > ~/.ssh/deploy.pem
          chmod 600 ~/.ssh/deploy.pem

      - name: Write Vault password
        run: echo "${{ secrets.VAULT_PASS }}" > ~/.vault_pass

      - name: Deploy
        env:
          AWS_ACCESS_KEY_ID:     ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          ansible-playbook site.yml \
            -i inventory_aws_ec2.yml \
            --vault-password-file ~/.vault_pass \
            -e "env=production"
```

### Jenkins Pipeline

```groovy
// Jenkinsfile
pipeline {
    agent { label 'ansible' }

    environment {
        VAULT_PASS = credentials('ansible-vault-pass')
        AWS_CREDS  = credentials('aws-prod')
    }

    stages {
        stage('Lint') {
            steps {
                sh 'ansible-lint site.yml'
            }
        }
        stage('Check') {
            steps {
                withCredentials([[$class: 'AmazonWebServicesCredentialsBinding', credentialsId: 'aws-prod']]) {
                    sh '''
                        echo "${VAULT_PASS}" > /tmp/.vault_pass
                        ansible-playbook site.yml \
                          -i inventory_aws_ec2.yml \
                          --vault-password-file /tmp/.vault_pass \
                          --check --diff
                    '''
                }
            }
        }
        stage('Deploy') {
            when { branch 'main' }
            steps {
                sh 'ansible-playbook site.yml -i inventory_aws_ec2.yml --vault-password-file /tmp/.vault_pass'
            }
        }
    }
    post {
        always { sh 'rm -f /tmp/.vault_pass' }
    }
}
```

### Running in a container (Execution Environment)

```dockerfile
# Dockerfile for Ansible runner
FROM python:3.11-slim
RUN pip install ansible boto3 botocore pywinrm \
 && ansible-galaxy collection install amazon.aws google.cloud community.general
WORKDIR /ansible
ENTRYPOINT ["ansible-playbook"]
```

```yaml
# GitLab CI
deploy:
  image: my-registry/ansible-runner:latest
  script:
    - ansible-playbook site.yml -i inventory_aws_ec2.yml
  variables:
    ANSIBLE_VAULT_PASSWORD_FILE: /tmp/vault_pass
```

---

## Callback Plugins

Callback plugins hook into Ansible events (task start, result, play end) for custom output or notifications.

### Built-in callbacks

```ini
# ansible.cfg
[defaults]
stdout_callback    = yaml          # prettier output (yaml|json|debug|dense|minimal)
callback_whitelist = timer,profile_tasks,mail
```

| Callback | What it does |
|----------|--------------|
| `timer` | Print total playbook runtime at end |
| `profile_tasks` | Show time each task took |
| `profile_roles` | Show time each role took |
| `mail` | Email on failure |
| `slack` | Post to Slack on play end |
| `json` | Machine-readable JSON output (for CI parsing) |
| `log_plays` | Log all play output to `/var/log/ansible.log` |

### Slack callback

```ini
# ansible.cfg
[defaults]
callback_whitelist = community.general.slack

[callback_slack]
webhook_url = https://hooks.slack.com/services/T.../B.../xxx
channel     = #deployments
username    = ansible-bot
```

### Custom callback plugin

```python
# callback_plugins/my_notify.py
from ansible.plugins.callback import CallbackBase

class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE    = 'notification'
    CALLBACK_NAME    = 'my_notify'

    def v2_playbook_on_stats(self, stats):
        hosts = sorted(stats.processed.keys())
        for h in hosts:
            s = stats.summarize(h)
            if s['failures'] or s['unreachable']:
                self._post_alert(f"FAILED: {h} — {s}")

    def _post_alert(self, msg):
        import requests
        requests.post(os.environ['ALERT_WEBHOOK'], json={'text': msg})
```

---

## `failed_when` and `changed_when`

Control when Ansible considers a task failed or changed — essential for `command`/`shell` tasks which are always `changed`.

```yaml
# command module doesn't know if something changed — mark it explicitly
- name: Check if service config is valid
  ansible.builtin.command: nginx -t
  register: nginx_check
  changed_when: false                         # never marks as changed (read-only)
  failed_when: nginx_check.rc != 0

# Custom failure condition
- name: Run database migration
  ansible.builtin.command: /opt/app/bin/migrate
  register: migrate_result
  changed_when: "'0 migrations applied' not in migrate_result.stdout"
  failed_when:
    - migrate_result.rc != 0
    - "'already up to date' not in migrate_result.stdout"   # not a failure

# Shell with pipe — rc is always 0 from grep when match found
- name: Check process count
  ansible.builtin.shell: ps aux | grep nginx | grep -v grep | wc -l
  register: nginx_procs
  changed_when: false
  failed_when: nginx_procs.stdout | int < 2
```
