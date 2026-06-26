import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeExternalLinks from 'rehype-external-links';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';

/**
 * Rehype plugin: rewrite relative .md links to /topic/... URLs.
 * @param section  e.g. "cicd"
 * @param subpath  subdirectory within section the file lives in, e.g. "jenkins" (for cicd/jenkins/README.md)
 */
function rehypeRewriteMdLinks(section: string, subpath: string) {
  return () => (tree: any) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a' || !node.properties?.href) return;
      const href: string = node.properties.href;
      if (!href.endsWith('.md') || href.startsWith('http')) return;

      // Cross-section: ../other-section/file.md
      if (href.startsWith('../')) {
        const parts = href.replace(/^\.\.\//, '').split('/');
        if (parts.length >= 2) {
          const crossSection = parts[0];
          const rest = parts.slice(1).join('/').replace(/\.md$/, '');
          node.properties.href = rest === 'README' || rest === ''
            ? `/topic/${crossSection}`
            : `/topic/${crossSection}/${rest}`;
        }
        return;
      }

      // Same-directory relative link: ./file.md or file.md
      const clean = href.replace(/^\.\//, '');
      const slug = clean.replace(/\.md$/, '');

      // Build the full path considering the file's location in the section
      const base = subpath ? `${section}/${subpath}` : section;

      if (slug === 'README') {
        // README in same directory = parent page
        node.properties.href = subpath ? `/topic/${base}` : `/topic/${section}`;
      } else {
        node.properties.href = `/topic/${base}/${slug}`;
      }
    });
  };
}

export async function renderMd(src: string, section: string, subpath = ''): Promise<string> {
  if (!src) return '';
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRewriteMdLinks(section, subpath))
    .use(rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(src);
  return String(file);
}
