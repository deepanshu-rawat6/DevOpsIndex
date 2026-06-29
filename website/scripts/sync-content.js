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
    readOrder: ['README', 'commands', 'boot', 'systemd', 'networking', 'network-tools', 'io-models', 'scheduler', 'security', 'memory-tuning', 'strace-perf', 'containers-evolution', 'cgroup-v2', 'proc-internals', 'ebpf-bpftrace', 'signals'],
  },
  {
    slug: 'networking', title: 'Networking', order: 2,
    readOrder: ['README', 'osi-model', 'tcp-udp', 'tls-encryption', 'http-versions', 'linux-networking', 'grpc-graphql', 'nslookup-vs-curl'],
  },
  {
    slug: 'docker', title: 'Docker', order: 3,
    readOrder: ['README', 'networking', 'buildkit', 'docker-security', 'internals', 'debugging'],
  },
  {
    slug: 'kubernetes', title: 'Kubernetes', order: 4,
    readOrder: ['kubectl-cheatsheet', 'README', 'workloads', 'resource-limits', 'networking', 'coredns', 'storage', 'rbac', 'autoscaling', 'helm', 'eks-architecture', 'pod-lifecycle', 'kube-proxy-modes', 'cross-node-networking', 'hpa-vpa-internals', 'scheduler-internals', 'policy-security', 'node-shutdown'],
  },
  {
    slug: 'cicd', title: 'CI/CD', order: 5,
    readOrder: ['README', 'github-actions', 'jenkins', 'jenkins/ecs-agents', 'argocd', 'gitops-secrets', 'pipeline-design', 'argo-rollouts'],
  },
  {
    slug: 'iac', title: 'Infrastructure as Code', order: 6,
    readOrder: ['README', 'terraform', 'cloudformation'],
  },
  {
    slug: 'aws', title: 'AWS', order: 7,
    readOrder: ['README', 'ecs-fargate', 'request-flow-alb-to-pod', 'services-overview', 'storage-databases', 'databases-deep-dive', 'messaging-serverless-observability'],
  },
  {
    slug: 'gcp', title: 'GCP', order: 8,
    readOrder: ['README', 'services-overview', 'gke', 'bigquery', 'bigtable', 'gcp-vs-aws', 'scenarios'],
  },
  {
    slug: 'monitoring', title: 'Monitoring', order: 9,
    readOrder: ['prometheus', 'alertmanager', 'grafana', 'opentelemetry', 'loki', 'performance-debugging', 'monitoring-scenarios', 'slo-sli', 'alerting-philosophy', 'thanos-mimir'],
  },
  {
    slug: 'git', title: 'Git', order: 10,
    readOrder: ['git-internals', 'git-workflows', 'git-fixes'],
  },
  {
    slug: 'advanced', title: 'Advanced', order: 11,
    readOrder: ['service-mesh', 'ebpf-observability', 'chaos-engineering', 'backup-dr'],
  },
  {
    slug: 'ai-infra', title: 'AI Infrastructure', order: 12,
    readOrder: ['README', 'gpu-scheduling', 'kuberay', 'model-serving', 'llmops', 'networking'],
  },
  {
    slug: 'mlops', title: 'MLOps', order: 13,
    readOrder: ['README', 'experiment-tracking', 'training-pipelines', 'data-drift', 'feature-stores'],
  },
  {
    slug: 'databases', title: 'Database Internals', order: 14,
    readOrder: ['README', 'postgres-internals', 'mysql-internals', 'mongodb-internals', 'redis-internals', 'kafka-internals', 'clickhouse-internals'],
  },
  {
    slug: 'on-prem-k8s', title: 'Databases on Kubernetes', order: 15,
    readOrder: ['README', 'postgres', 'mysql', 'mongodb', 'redis-cluster', 'kafka', 'clickhouse'],
  },
  {
    slug: 'sre', title: 'SRE & Debugging', order: 16,
    readOrder: ['README', 'k8s-debugging', 'k8s-scenarios', 'linux-debugging', 'aws-scenarios', 'cicd-scenarios', 'iac-scenarios', 'sre-concepts', 'self-healing-aiops', 'db-monitoring'],
  },
];

// Clean and recreate output dirs
for (const dir of [DATA_DIR, CONTENT_DIR]) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
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
    const meta = {
      section: section.slug,
      sectionTitle: section.title,
      sectionOrder: section.order,
      pageSlug,
      title,
      filePath: path.join(section.slug, relPath).replace(/\\/g, '/'),
      pageOrder: finalOrder,
    };
    fs.writeFileSync(path.join(CONTENT_DIR, `${jsonKey}.json`), JSON.stringify(meta, null, 2));

    console.log(`  ✓ [${String(finalOrder).padStart(2)}] ${pageSlug}`);
    totalPages++;
  }
}

console.log(`\nSynced ${totalPages} pages to src/data/topics/ and src/content/topics/`);
