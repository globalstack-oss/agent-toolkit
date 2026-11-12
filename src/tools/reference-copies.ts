// Finds the app's copies of the reference code and compares them with this plugin's code/ folder. A fix to the
// reference code reaches an app only when its copies are replaced, so the acceptance check says which are behind.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SKILL_DIR } from '../skill';

/** The first line of every file in code/ (and of the copies made before the plugin was named). */
const BANNER = /GlobalStack (reference code, from the globalstack plugin|ready-made code)/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor']);

export type CopyStatus = 'current' | 'outdated' | 'unknown';

/** The file without the one edit the banner allows (an extension on relative imports) and without spacing changes. */
const normalise = (text: string) =>
  text
    .replace(/(from\s+['"]\.{1,2}\/[^'"]+?)\.(?:js|ts|mjs|mts)(['"])/g, '$1$2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\r\n/g, '\n')
    .trim();
const digest = (text: string) => createHash('sha256').update(normalise(text)).digest('hex');

export function referenceCopies(appDir = process.cwd(), codeDir = resolve(SKILL_DIR, 'code')): Array<{ path: string; file: string; status: CopyStatus }> {
  const current = new Map(
    readdirSync(codeDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [f, digest(readFileSync(join(codeDir, f), 'utf8'))] as const),
  );
  const found: Array<{ path: string; file: string; status: CopyStatus }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (/\.m?ts$/.test(name) && stat.size < 500_000) {
        const text = readFileSync(path, 'utf8');
        if (!BANNER.test(text.slice(0, 400))) continue;
        const file = name.replace(/\.mts$/, '.ts');
        const want = current.get(file);
        found.push({ path: relative(appDir, path), file, status: !want ? 'unknown' : digest(text) === want ? 'current' : 'outdated' });
      }
    }
  };
  walk(resolve(appDir), 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
