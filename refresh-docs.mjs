// Refreshes the copy of the public docs that gs.mjs search_docs reads when the live docs cannot be reached.
// Run before each release: npm run docs:refresh, or npm run docs:refresh -- <docs checkout>
//
// docs.globalstack.io is built from github.com/Paystack-Passport/docs, so this builds the site's llms-full.txt from
// that repo instead of downloading it, and works where the site cannot be reached. With no checkout given, it clones
// the repo's default branch, which is what the site serves. It follows the site's rules: pages sorted by URL; an MDX
// page is its title, Source line, description and body written out again by remark; an API page is its method, path
// and description from the OpenAPI file. Checked on 21 Oct 2026: built from docs commit 16b851a, it equals byte for
// byte the copy taken from the site in late August. remark 10 and MDX 2 are pinned in package.json because newer
// versions escape underscores differently.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import YAML from 'yaml';

const SITE = 'https://docs.globalstack.io';
const REPOSITORY = 'https://github.com/Paystack-Passport/docs';
const COPY = 'plugin/skills/globalstack-integration/docs/llms-full.txt';

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkFrontmatter)
  .use(remarkStringify, { bullet: '*', fences: true, rule: '-', emphasis: '*', strong: '*', listItemIndent: 'one' });

const slug = (s) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The text docs.globalstack.io serves as llms-full.txt, built from a checkout of the site's source. */
export function buildLlmsFull(dir) {
  const pages = [];
  let openapi;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'string') return pages.push(node);
    if (!node || typeof node !== 'object') return;
    if (typeof node.openapi === 'string') openapi = node.openapi;
    for (const key of ['tabs', 'groups', 'pages']) if (node[key]) walk(node[key]);
  };
  walk(JSON.parse(readFileSync(join(dir, 'docs.json'), 'utf8')).navigation);

  const sections = pages.map((page) => {
    // Heading anchors ({#id}) are Mintlify syntax, not MDX; the site drops them from the text.
    const raw = readFileSync(join(dir, `${page}.mdx`), 'utf8').replace(/^(#{1,6} .*?)\s*\{#[\w-]+\}[ \t]*$/gm, '$1');
    const tree = processor.parse(raw);
    const front = tree.children[0]?.type === 'yaml' ? YAML.parse(tree.children.shift().value) : {};
    // As the site does: code blocks get theme={null}; components lose className and {expression} attributes.
    const visit = (node) => {
      if (node.type === 'code') node.meta = node.meta ? `${node.meta} theme={null}` : 'theme={null}';
      if (node.attributes) {
        node.attributes = node.attributes.filter((a) => a.type === 'mdxJsxAttribute' && a.name !== 'className' && typeof a.value !== 'object');
      }
      (node.children ?? []).forEach(visit);
    };
    visit(tree);
    const url = `${SITE}/${page}`;
    const description = front.description ? `${front.description}\n\n` : '';
    return { url, text: `# ${front.title ?? ''}\nSource: ${url}\n\n${description}${processor.stringify(tree)}` };
  });

  if (openapi) {
    const spec = JSON.parse(readFileSync(join(dir, openapi), 'utf8'));
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const url = `${SITE}/api-reference/${slug(op.tags?.[0] ?? 'default')}/${slug(op.summary)}`;
        sections.push({ url, text: `# ${op.summary}\nSource: ${url}\n\n/${openapi} ${method} ${path}\n${op.description ?? ''}\n\n` });
      }
    }
  }

  sections.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return sections.map((section) => `${section.text}\n\n`).join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const given = process.argv[2];
  const dir = given ?? mkdtempSync(join(tmpdir(), 'globalstack-docs-'));
  try {
    if (!given) execFileSync('git', ['clone', '--quiet', '--depth', '1', REPOSITORY, dir], { stdio: 'inherit' });
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const text = buildLlmsFull(dir);
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      COPY,
      `<!-- Copy of ${SITE}/llms-full.txt taken ${today}, built from the site's source (github.com/Paystack-Passport/docs at ${commit}). gs.mjs search_docs reads it when the live docs cannot be reached. Refresh with: npm run docs:refresh -->\n${text}`,
    );
    console.log(`docs copy refreshed from docs ${commit} (${text.length} characters, ${today})`);
  } finally {
    if (!given) rmSync(dir, { recursive: true, force: true });
  }
}
