import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SKILL_DIR } from '../skill';
import { defineTool } from './types';

export const DOCS_URL = 'https://docs.globalstack.io/llms-full.txt';
/** The copy shipped with the plugin, for agents without network access (Codex cloud, locked-down CI). */
export const DOCS_COPY = resolve(SKILL_DIR, 'docs/llms-full.txt');
const MAX_SECTION_CHARS = 4000;

/** Doc lines the code check found to be out of date (2026-09-30). */
const STALE_NOTES: Array<{ match: RegExp; note: string }> = [
  { match: /mock spread|deterministic jitter/i, note: 'Out of date: rates are real market rates, not mock values.' },
  { match: /\b(rate|destination_amount)\b[^\n]{0,80}placeholder|placeholder[^\n]{0,80}\b(rate|destination_amount)\b/i, note: 'Out of date: conversion `rate` and `destination_amount` are real values, not placeholders.' },
];

interface Section {
  title: string;
  source: string | null;
  body: string;
}

export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  for (const chunk of text.split(/\n(?=# )/)) {
    const title = chunk.match(/^# (.*)$/m)?.[1]?.trim();
    if (!title) continue;
    const source = chunk.match(/^Source: (\S+)/m)?.[1] ?? null;
    sections.push({ title, source, body: chunk });
  }
  return sections;
}

/** A page's path from its Source link or a path: `https://docs.globalstack.io/errors#codes` and `errors.md` give `/errors`. */
export function pagePath(page: string): string {
  const path = page.trim().replace(/^https?:\/\/[^/]+/, '').replace(/[#?].*$/, '').replace(/\.md$/, '').replace(/\/+$/, '');
  return path.startsWith('/') ? path : `/${path}`;
}

const notesFor = (section: Section) => STALE_NOTES.filter((stale) => stale.match.test(section.body)).map((stale) => stale.note);

/**
 * BM25 over each page's text, plus a bonus for each query word in the page's title. A word counts for less each time
 * it repeats and in a long page, so a page that names every field (Webhook events, the changelog) does not outrank
 * the page about the request. A word also matches inside a longer one: `beneficiary` in `beneficiary_id`.
 */
export function rankSections(sections: Section[], query: string, limit: number) {
  const terms = [...new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 1))];
  if (terms.length === 0) return [];
  const count = (haystack: string, term: string) => haystack.split(term).length - 1;
  const pages = sections.map((section) => ({ section, title: section.title.toLowerCase(), body: section.body.toLowerCase() }));
  const averageLength = pages.reduce((sum, page) => sum + page.body.length, 0) / pages.length;
  const idf = new Map(
    terms.map((term) => {
      const having = pages.filter((page) => page.body.includes(term)).length;
      return [term, Math.log(1 + (pages.length - having + 0.5) / (having + 0.5))];
    }),
  );
  return pages
    .map(({ section, title, body }) => {
      const norm = 1.2 * (0.25 + (0.75 * body.length) / averageLength);
      const score = terms.reduce((sum, term) => {
        const tf = count(body, term);
        // A title word counts even when every page has it (`create`, `list`): it says what the page is for.
        const inTitle = title.includes(term) ? 2 * Math.max(idf.get(term)!, 1) : 0;
        return sum + (idf.get(term)! * tf * 2.2) / (tf + norm) + inTitle;
      }, 0);
      // The changelog mentions everything; rank it below the reference pages.
      return { section, score: score * (title === 'changelog' ? 0.2 : 1) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ section }) => ({
      title: section.title,
      source: section.source,
      notes: notesFor(section),
      text:
        section.body.length > MAX_SECTION_CHARS
          ? `${section.body.slice(0, MAX_SECTION_CHARS)}\n[cut: ${section.source ? `search_docs '{"page":"${pagePath(section.source)}"}' returns the whole page` : 'open the source for the rest'}]`
          : section.body,
    }));
}

/** The page whose Source link has this path, whole. */
export function findPage(sections: Section[], page: string) {
  const path = pagePath(page);
  const section = sections.find((s) => s.source !== null && pagePath(s.source) === path);
  return section ? [{ title: section.title, source: section.source, notes: notesFor(section), text: section.body }] : [];
}

interface Docs {
  sections: Section[];
  /** Set when the live docs could not be reached and the plugin's copy answered. */
  copyNote?: string;
}

export function createSearchDocs(fetchFn: typeof fetch = fetch, copyPath = DOCS_COPY) {
  let cache: Promise<Docs> | null = null;
  const live = () =>
    fetchFn(DOCS_URL, { signal: AbortSignal.timeout(8_000) }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { sections: splitSections(await response.text()) };
    });
  const copy = (liveError: unknown): Docs => {
    const text = readFileSync(copyPath, 'utf8');
    const taken = text.match(/taken ((?:on or before )?\d{4}-\d{2}-\d{2})/)?.[1] ?? 'on an unknown date';
    return {
      sections: splitSections(text),
      copyNote:
        `${DOCS_URL} could not be reached (${liveError instanceof Error ? liveError.message : String(liveError)}). ` +
        `These sections come from the copy in this plugin, taken ${taken}. Check a detail your code depends on against the live docs when you can.`,
    };
  };
  const load = () => {
    cache ??= live().catch((error) => copy(error));
    cache.catch(() => (cache = null));
    return cache;
  };

  return defineTool({
    name: 'search_docs',
    title: 'Search the Global Stack docs',
    description:
      'Searches the public Global Stack API docs and returns the best matching sections with their source link, or returns one page whole. ' +
      'Needs no API key. Without network access it uses the copy shipped in this plugin and says so.',
    group: 'read',
    calls: [],
    inputSchema: {
      query: z.string().min(2).optional().describe('What to look for, e.g. "offramp quote target_amount" or "webhook signature".'),
      page: z.string().min(2).optional().describe('A page to return whole, by its source link or path, e.g. "/errors".'),
      limit: z.number().int().min(1).max(5).optional().describe('How many sections a query returns. Default 3.'),
    },
    async run({ query, page, limit }) {
      if (!query === !page) {
        return { ok: false, status: null, code: 'invalid_input', developer_message: 'Give either a query to search for or a page to read whole.', next_steps: null, request_id: null };
      }
      try {
        const docs = await load();
        const copy = docs.copyNote ? { docs_copy: docs.copyNote } : {};
        if (page) {
          const results = findPage(docs.sections, page);
          return { ok: true, page: pagePath(page), ...copy, results, hint: results.length ? undefined : 'No page has this path. Search with a query to find its source link.' };
        }
        const results = rankSections(docs.sections, query!, limit ?? 3);
        return { ok: true, query, ...copy, results, hint: results.length ? undefined : 'No match. Try other words.' };
      } catch (error) {
        return {
          ok: false,
          status: null,
          code: 'docs_unavailable',
          developer_message: `Could not load ${DOCS_URL} or the copy in this plugin: ${error instanceof Error ? error.message : String(error)}`,
          next_steps: null,
          request_id: null,
        };
      }
    },
  });
}
