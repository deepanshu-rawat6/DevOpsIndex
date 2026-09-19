import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.resolve(__dirname, '../src/data/topics');
const CONTENT_DIR = path.resolve(__dirname, '../src/content/topics');

const SECTIONS = [
  {
    slug: 'linux', title: 'Linux', order: 1,
    readOrder: ['README', 'commands', 'boot', 'systemd', 'networking', 'network-tools', 'io-models', 'scheduler', 'security', 'memory-tuning', 'strace-perf', 'containers-evolution', 'cgroup-v2', 'proc-internals', 'ebpf-bpftrace', 'signals', 'namespaces', 'filesystem-internals', 'numa-irq-tuning', 'kernel-memory-internals', 'io-schedulers-and-storage', 'perf-and-flamegraphs'],
  },
  {
    slug: 'networking', title: 'Networking', order: 2,
    readOrder: ['README', 'osi-model', 'tcp-udp', 'tls-encryption', 'acme-certificate-automation', 'http-versions', 'grpc-graphql', 'grpc-deep-dive', 'linux-networking', 'bgp-routing', 'load-balancers', 'cdn', 'nslookup-vs-curl', 'zero-trust', 'dns-internals', 'overlay-networks', 'ipvs-and-cni', 'service-mesh', 'quic-http3'],
  },
  {
    slug: 'docker', title: 'Docker', order: 3,
    readOrder: ['README', 'networking', 'buildkit', 'docker-security', 'internals', 'debugging', 'compose-advanced', 'runtime-and-alternatives', 'registry-and-distribution'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Networking', slug: 'networking' },
    ],
  },
  {
    slug: 'kubernetes', title: 'Kubernetes', order: 4,
    readOrder: ['kubectl-cheatsheet', 'README', 'workloads', 'resource-limits', 'networking', 'coredns', 'storage', 'rbac', 'autoscaling', 'helm', 'eks-architecture', 'pod-lifecycle', 'controller-pattern', 'custom-resources-operators', 'kubeadm-bootstrap', 'kube-proxy-modes', 'cross-node-networking', 'hpa-vpa-internals', 'scheduler-internals', 'policy-security', 'node-shutdown'],
    sectionPrereqs: [
      { title: 'Docker',     slug: 'docker' },
      { title: 'Linux',      slug: 'linux' },
      { title: 'Networking', slug: 'networking' },
    ],
  },
  {
    slug: 'cicd', title: 'CI/CD', order: 5,
    readOrder: ['README', 'github-actions', 'jenkins', 'jenkins/ecs-agents', 'argocd', 'gitops-secrets', 'pipeline-design', 'argo-rollouts'],
    sectionPrereqs: [
      { title: 'Docker',     slug: 'docker' },
      { title: 'Kubernetes', slug: 'kubernetes' },
      { title: 'Git',        slug: 'git' },
    ],
  },
  {
    slug: 'iac', title: 'Infrastructure as Code', order: 6,
    readOrder: ['README', 'terraform', 'cloudformation', 'pulumi', 'ansible', 'ansible/core-concepts', 'ansible/cloud-integration', 'ansible/advanced'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Networking', slug: 'networking' },
    ],
  },
  {
    slug: 'aws', title: 'AWS', order: 7,
    readOrder: ['README', 'services-overview', 'ecs-fargate', 'request-flow-alb-to-pod', 'storage-databases', 'databases-deep-dive', 'messaging-serverless-observability'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Networking', slug: 'networking' },
      { title: 'Docker',     slug: 'docker' },
    ],
  },
  {
    slug: 'gcp', title: 'GCP', order: 8,
    readOrder: ['README', 'from-aws', 'services-overview', 'security-compliance', 'compute', 'gke', 'request-flow-glb-to-pod', 'storage', 'databases', 'bigquery', 'bigtable', 'data-pipelines', 'serverless', 'messaging', 'reliability-dr', 'cost-optimization', 'migration-methodology', 'observability', 'cicd', 'gcp-vs-aws', 'scenarios'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Networking', slug: 'networking' },
      { title: 'Docker',     slug: 'docker' },
      { title: 'Kubernetes', slug: 'kubernetes' },
    ],
  },
  {
    slug: 'monitoring', title: 'Monitoring', order: 9,
    readOrder: ['README', 'prometheus', 'alertmanager', 'grafana', 'opentelemetry', 'loki', 'performance-debugging', 'monitoring-scenarios', 'slo-sli', 'alerting-philosophy', 'thanos-mimir'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Kubernetes', slug: 'kubernetes' },
    ],
  },
  {
    slug: 'git', title: 'Git', order: 10,
    readOrder: ['README', 'git-internals', 'git-workflows', 'git-fixes'],
  },
  {
    slug: 'advanced', title: 'Advanced', order: 11,
    readOrder: ['README', 'service-mesh', 'ebpf-observability', 'chaos-engineering', 'chaos-engineering-handson', 'backup-dr', 'dr-zero-downtime', 'low-latency-networking', 'fintech-security', 'fintech-compliance', 'trading-systems', 'trading-data-streaming'],
    prerequisites: {
      'service-mesh':           [{ title: 'Kubernetes',       slug: 'kubernetes' },
                                  { title: 'Networking',      slug: 'networking' }],
      'ebpf-observability':     [{ title: 'Linux (eBPF)',      slug: 'linux/ebpf-bpftrace' },
                                  { title: 'Monitoring',      slug: 'monitoring' }],
      'chaos-engineering':      [{ title: 'Kubernetes',       slug: 'kubernetes' },
                                  { title: 'Monitoring',      slug: 'monitoring' }],
      'backup-dr':              [{ title: 'Kubernetes',       slug: 'kubernetes' },
                                  { title: 'AWS',             slug: 'aws' }],
      'low-latency-networking': [{ title: 'Networking',       slug: 'networking' },
                                  { title: 'Linux',           slug: 'linux' }],
      'fintech-security':       [{ title: 'Networking',       slug: 'networking' },
                                  { title: 'Kubernetes',      slug: 'kubernetes' }],
      'trading-data-streaming': [{ title: 'Kafka Internals',  slug: 'databases/kafka-internals' },
                                  { title: 'System Design',   slug: 'system-design' }],
    },
  },
  {
    slug: 'ai-infra', title: 'AI Infrastructure', order: 12,
    readOrder: ['README', 'gpu-scheduling', 'kuberay', 'model-serving', 'llmops', 'networking'],
    sectionPrereqs: [
      { title: 'Kubernetes', slug: 'kubernetes' },
    ],
  },
  {
    slug: 'mlops', title: 'MLOps', order: 13,
    readOrder: ['README', 'experiment-tracking', 'training-pipelines', 'data-drift', 'feature-stores'],
    sectionPrereqs: [
      { title: 'AI Infrastructure', slug: 'ai-infra' },
      { title: 'Database Internals', slug: 'databases' },
    ],
  },
  {
    slug: 'databases', title: 'Database Internals', order: 14,
    readOrder: ['README', 'postgres-internals', 'mysql-internals', 'mongodb-internals', 'redis-internals', 'etcd', 'kafka-internals', 'clickhouse-internals', 'elasticsearch-internals', 'replication', 'caching'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Networking', slug: 'networking' },
    ],
  },
  {
    slug: 'on-prem-k8s', title: 'Databases on Kubernetes', order: 15,
    readOrder: ['README', 'postgres', 'mysql', 'mongodb', 'redis-cluster', 'kafka', 'clickhouse'],
    sectionPrereqs: [
      { title: 'Kubernetes',         slug: 'kubernetes' },
      { title: 'Database Internals', slug: 'databases' },
    ],
  },
  {
    slug: 'on-prem-vm', title: 'On-Prem VM Setup', order: 16,
    readOrder: ['README', 'mongodb'],
    sectionPrereqs: [
      { title: 'Linux',             slug: 'linux' },
      { title: 'Database Internals', slug: 'databases' },
    ],
  },
  {
    slug: 'system-design', title: 'System Design', order: 17,
    readOrder: ['README', 'scaling', 'cap-pacelc', 'rate-limiting', 'async-patterns', 'api-design', 'distributed-transactions', 'file-transfer-storage', 'realtime-chat', 'end-to-end-encryption', 'distributed-id-generation', 'geospatial-services', 'probabilistic-data-structures'],
    prerequisites: {
      'scaling':                       [{ title: 'Linux',             slug: 'linux' },
                                        { title: 'Networking',        slug: 'networking' },
                                        { title: 'Database Internals', slug: 'databases' }],
      'cap-pacelc':                    [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'DB Replication',    slug: 'databases/replication' }],
      'rate-limiting':                 [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'Redis Internals',   slug: 'databases/redis-internals' }],
      'async-patterns':                [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'Kafka Internals',   slug: 'databases/kafka-internals' }],
      'api-design':                    [{ title: 'HTTP Versions',     slug: 'networking/http-versions' },
                                        { title: 'gRPC & GraphQL',    slug: 'networking/grpc-graphql' }],
      'distributed-transactions':      [{ title: 'CAP & PACELC',     slug: 'system-design/cap-pacelc' },
                                        { title: 'Async Patterns',    slug: 'system-design/async-patterns' }],
      'file-transfer-storage':         [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'CDN',               slug: 'networking/cdn' },
                                        { title: 'TLS & Encryption',  slug: 'networking/tls-encryption' }],
      'realtime-chat':                 [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'HTTP Versions',     slug: 'networking/http-versions' },
                                        { title: 'Redis Internals',   slug: 'databases/redis-internals' }],
      'end-to-end-encryption':         [{ title: 'Realtime Chat',     slug: 'system-design/realtime-chat' },
                                        { title: 'TLS & Encryption',  slug: 'networking/tls-encryption' }],
      'distributed-id-generation':     [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'CAP & PACELC',      slug: 'system-design/cap-pacelc' }],
      'geospatial-services':           [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'Redis Internals',   slug: 'databases/redis-internals' }],
      'probabilistic-data-structures': [{ title: 'Scaling',           slug: 'system-design/scaling' },
                                        { title: 'Rate Limiting',     slug: 'system-design/rate-limiting' }],
    },
  },
  {
    slug: 'sre', title: 'SRE & Debugging', order: 18,
    readOrder: ['README', 'k8s-debugging', 'k8s-scenarios', 'linux-debugging', 'aws-scenarios', 'cicd-scenarios', 'iac-scenarios', 'sre-concepts', 'self-healing-aiops', 'db-monitoring'],
    sectionPrereqs: [
      { title: 'Linux',      slug: 'linux' },
      { title: 'Kubernetes', slug: 'kubernetes' },
      { title: 'Monitoring', slug: 'monitoring' },
    ],
  },
  {
    slug: 'coding-practice', title: 'Coding Practice', order: 19,
    readOrder: ['README', 'concurrent-patterns', 'btree', 'skip-list', 'lru-cache', 'rate-limiter-implementations', 'consistent-hashing', 'bloom-filter'],
    prerequisites: {
      'concurrent-patterns':         [{ title: 'Go — Concurrency',              slug: 'go/concurrency' }],
      'btree':                       [{ title: 'PostgreSQL Internals',           slug: 'databases/postgres-internals' }],
      'skip-list':                   [{ title: 'Probabilistic Data Structures',  slug: 'system-design/probabilistic-data-structures' }],
      'lru-cache':                   [{ title: 'Database Internals',             slug: 'databases' }],
      'rate-limiter-implementations': [{ title: 'Rate Limiting',                slug: 'system-design/rate-limiting' }],
      'consistent-hashing':          [{ title: 'Scaling',                       slug: 'system-design/scaling' }],
      'bloom-filter':                [{ title: 'Probabilistic Data Structures',  slug: 'system-design/probabilistic-data-structures' }],
    },
  },
  {
    slug: 'platform-engineering', title: 'Platform Engineering', order: 20,
    readOrder: ['README', 'idp-concepts', 'backstage', 'crossplane', 'developer-self-service', 'multi-tenancy', 'platform-observability', 'cost-attribution'],
    sectionPrereqs: [
      { title: 'Kubernetes', slug: 'kubernetes' },
      { title: 'CI/CD',      slug: 'cicd' },
      { title: 'IaC',        slug: 'iac' },
    ],
    prerequisites: {
      'crossplane':             [{ title: 'K8s Custom Resources', slug: 'kubernetes/custom-resources-operators' },
                                 { title: 'IaC',                  slug: 'iac' }],
      'multi-tenancy':          [{ title: 'K8s RBAC',             slug: 'kubernetes/rbac' },
                                 { title: 'K8s Networking',        slug: 'kubernetes/networking' }],
      'platform-observability': [{ title: 'Monitoring',            slug: 'monitoring' },
                                 { title: 'SRE Concepts',          slug: 'sre/sre-concepts' }],
      'cost-attribution':       [{ title: 'K8s Resource Limits',   slug: 'kubernetes/resource-limits' },
                                 { title: 'GCP Cost Optimization', slug: 'gcp/cost-optimization' }],
    },
  },
  {
    slug: 'security-engineering', title: 'Security Engineering', order: 21,
    readOrder: ['README', 'container-security', 'supply-chain', 'secrets-management', 'sast-dast', 'k8s-security'],
    sectionPrereqs: [
      { title: 'Docker',      slug: 'docker' },
      { title: 'Kubernetes',  slug: 'kubernetes' },
      { title: 'CI/CD',       slug: 'cicd' },
    ],
    prerequisites: {
      'supply-chain':       [{ title: 'CI/CD',           slug: 'cicd' }],
      'k8s-security':       [{ title: 'K8s RBAC',        slug: 'kubernetes/rbac' },
                             { title: 'K8s Networking',  slug: 'kubernetes/networking' }],
      'secrets-management': [{ title: 'IaC',             slug: 'iac' }],
    },
  },
  {
    slug: 'ebpf', title: 'eBPF', order: 22,
    readOrder: ['README', 'bpf-fundamentals', 'cilium', 'tetragon', 'bpftrace'],
    sectionPrereqs: [
      { title: 'Linux',       slug: 'linux' },
      { title: 'Kubernetes',  slug: 'kubernetes' },
      { title: 'Networking',  slug: 'networking' },
    ],
    prerequisites: {
      'cilium':   [{ title: 'K8s Networking',  slug: 'kubernetes/networking' }],
      'tetragon': [{ title: 'Cilium',          slug: 'ebpf/cilium' },
                   { title: 'K8s Security',    slug: 'security-engineering/k8s-security' }],
    },
  },
];

// Clean and recreate output dirs
function cleanDirs() {
  for (const dir of [DATA_DIR, CONTENT_DIR]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fixMermaid(content) {
  return content.replace(/```mermaid\n([\s\S]*?)```/g, (_, block) => {
    let fixed = block
      .replace(/<br>/g, '<br/>')
      .replace(/\\n/g, '<br/>')
      // Remove rx:N from classDef (not supported in mermaid v11)
      .replace(/,\s*rx:\d+/g, '')
      // Rewrite bidirectional <--> arrows as two one-way arrows aren't supported in graph TD
      // Replace A <-->|label| B with A -->|label| B
      .replace(/<-->/g, '-->');
    fixed = fixed.replace(/\{([^"{}][^{}]*)\}/g, (m, inner) =>
      /[()[\]\/<>]/.test(inner) ? `{"${inner}"}` : m
    );
    // Only rewrite unquoted square bracket labels containing special chars.
    // Skip shapes like [("cylinder")], [/"slant"/], etc. — they start with non-alpha quote chars.
    fixed = fixed.replace(/\[([^"\][()\/<>][^\]]*)\]/g, (m, inner) =>
      /[()[\]\/]/.test(inner) ? `["${inner}"]` : m
    );
    return '```mermaid\n' + fixed + '```';
  });
}

function extractTitle(content, filename) {
  const match = content.match(/^#{1,2}\s+(.+)$/m);
  if (match) return match[1].trim();
  return filename
    .replace(/\.md$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function extractDescription(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('```') || line.startsWith('<')) continue;
    // Strip inline markdown: bold, italic, backticks, links
    return line
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .slice(0, 160);
  }
  return '';
}

// Recursively collect all .md files in a directory
function collectMdFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full, baseDir));
    } else if (entry.name.endsWith('.md')) {
      results.push(path.relative(baseDir, full));
    }
  }
  return results;
}

// Convert a relPath to the "key" used in readOrder
// e.g. "README.md" → "README", "workloads.md" → "workloads"
// "github-actions/README.md" → "github-actions", "jenkins/ecs-agents.md" → "jenkins/ecs-agents"
function relPathToOrderKey(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const withoutExt = normalized.replace(/\.md$/, '');
  // subdir/README → subdir
  if (withoutExt.endsWith('/README')) {
    return withoutExt.replace(/\/README$/, '');
  }
  return withoutExt;
}

function syncAll() {
  cleanDirs();
  let totalPages = 0;

  for (const section of SECTIONS) {
  const sectionDir = path.join(REPO_ROOT, section.slug);
  if (!fs.existsSync(sectionDir)) {
    console.warn(`  skipping ${section.slug} (not found)`);
    continue;
  }

  const mdFiles = collectMdFiles(sectionDir);

  for (const relPath of mdFiles) {
    const srcFile = path.join(sectionDir, relPath);
    let content = fs.readFileSync(srcFile, 'utf8');
    content = fixMermaid(content);

    const title = extractTitle(content, path.basename(relPath));
    const description = extractDescription(content);

    // Compute pageSlug
    const parts = relPath.replace(/\\/g, '/').split('/');
    let pageSlug;
    if (parts.length === 1) {
      pageSlug = parts[0] === 'README.md'
        ? section.slug
        : `${section.slug}/${parts[0].replace(/\.md$/, '')}`;
    } else {
      if (parts[parts.length - 1] === 'README.md') {
        pageSlug = `${section.slug}/${parts.slice(0, -1).join('/')}`;
      } else {
        pageSlug = `${section.slug}/${parts.map((p, i) => i === parts.length - 1 ? p.replace(/\.md$/, '') : p).join('/')}`;
      }
    }

    // Determine read order index
    const orderKey = relPathToOrderKey(relPath.replace(/\\/g, '/'));
    const pageOrder = section.readOrder.indexOf(orderKey);
    const finalOrder = pageOrder === -1 ? 999 : pageOrder;

    // Copy markdown to data dir
    const destFile = path.join(DATA_DIR, section.slug, relPath);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, content);

    // Write JSON manifest entry
    const jsonKey = pageSlug.replace(/\//g, '--');
    const prerequisites = section.prerequisites?.[orderKey] ?? section.sectionPrereqs ?? [];
    const meta = {
      section: section.slug,
      sectionTitle: section.title,
      sectionOrder: section.order,
      pageSlug,
      title,
      description,
      filePath: path.join(section.slug, relPath).replace(/\\/g, '/'),
      pageOrder: finalOrder,
      prerequisites,
    };
    fs.writeFileSync(path.join(CONTENT_DIR, `${jsonKey}.json`), JSON.stringify(meta, null, 2));

    console.log(`  ✓ [${String(finalOrder).padStart(2)}] ${pageSlug}`);
    totalPages++;
  }
}

  console.log(`\nSynced ${totalPages} pages to src/data/topics/ and src/content/topics/`);
}

syncAll();

// Watch mode: run with `node scripts/sync-content.js --watch` (or `npm run sync:watch`)
if (process.argv.includes('--watch')) {
  console.log('[sync-content] Watching for markdown changes… (Ctrl+C to stop)');
  let debounce;
  fs.watch(REPO_ROOT, { recursive: true }, (_, filename) => {
    if (!filename?.endsWith('.md')) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log(`[sync-content] ${filename} changed, resyncing…`);
      syncAll();
    }, 300);
  });
}
