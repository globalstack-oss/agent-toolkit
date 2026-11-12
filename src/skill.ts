import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads the globalstack-integration skill. It is the only place the build rules live: the section texts
 * (SKILL.md), the code checklist (checklist.md), the playbooks (playbooks.md) and the lookup details
 * (reference.md).
 */
export const SKILL_NAME = 'globalstack-integration';
/** The bundled script lives in <skill>/scripts/, so the skill folder is one level up. */
export const SKILL_DIR = process.env.GLOBALSTACK_SKILL_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_FILES = { skill: 'SKILL.md', checklist: 'checklist.md', playbooks: 'playbooks.md', reference: 'reference.md' } as const;
export type SkillFiles = Record<keyof typeof SKILL_FILES, string>;

export interface SkillSection {
  number: number;
  title: string;
  text: string;
}
export interface ChecklistItem {
  rule: string;
  how_to_check: string;
  section: number;
}
export interface Playbook {
  id: string;
  title: string;
  /** Null for the general playbook. */
  route: { direction: 'onramp' | 'offramp'; currency: string; country_code: string; network: 'bank' | 'mobile_money' } | null;
  sections: number[];
  steps: Array<{ tool: string; rule: string }>;
  traps: string[];
  smallest_live_test: string;
}
/** A reference.md topic. `appliesTo` is its `Applies to:` line: entries split on commas, each a list of words that must all match the flow. */
export interface ReferenceTopic {
  title: string;
  appliesTo: string[][];
  text: string;
}
export interface Skill {
  sections: SkillSection[];
  checklist: ChecklistItem[];
  playbooks: Playbook[];
  reference: ReferenceTopic[];
}

const fail = (what: string): never => {
  throw new Error(`${SKILL_DIR}: ${what}`);
};

function parseSections(markdown: string): SkillSection[] {
  const parts = markdown.split(/^## /m).slice(1);
  return parts.flatMap((part) => {
    const match = /^(\d+)\. (.+)\n([\s\S]*)$/.exec(part);
    return match ? [{ number: Number(match[1]), title: match[2]!.trim(), text: match[3]!.trim() }] : [];
  });
}

function parseChecklist(text: string): ChecklistItem[] {
  // A rule can wrap onto indented lines before its `Check:` line.
  const items = [...text.matchAll(/^- \[(\d+)\] ((?:.+)(?:\n {2}(?!Check: ).+)*)\n {2}Check: (.+)$/gm)].map((m) => ({
    rule: m[2]!.replace(/\s+/g, ' ').trim(),
    how_to_check: m[3]!.trim(),
    section: Number(m[1]),
  }));
  return items.length ? items : fail('checklist.md has no items');
}

/** The lines under a `Label:` line, up to the next blank line. */
function block(body: string, label: string): string[] {
  const match = new RegExp(`^${label}:\\n((?:.+\\n?)+)`, 'm').exec(body);
  return match ? match[1]!.trim().split('\n') : [];
}

function field(body: string, label: string): string | null {
  return new RegExp(`^${label}: (.+)$`, 'm').exec(body)?.[1]?.trim() ?? null;
}

function parsePlaybook(part: string): Playbook {
  const heading = /^(\w+): (.+)\n/.exec(part) ?? fail(`bad playbook heading "${part.split('\n')[0]}"`);
  const [, id, title] = heading as RegExpExecArray;
  const body = part.slice(heading[0].length);
  const route = field(body, 'Route');
  const [direction, currency, country_code, network] = route ? route.split(/,\s*/) : [];
  const steps = block(body, 'Steps').map((line) => {
    const step = /^\d+\. `(\w+)`: (.+)$/.exec(line) ?? fail(`${id}: bad step "${line}"`);
    return { tool: step[1]!, rule: step[2]!.trim() };
  });
  const playbook: Playbook = {
    id: id!,
    title: title!.trim(),
    route: route ? ({ direction, currency, country_code, network } as Playbook['route']) : null,
    sections: (field(body, 'Sections') ?? '').split(/,\s*/).filter(Boolean).map(Number),
    steps,
    // A trap can wrap onto indented lines.
    traps: block(body, 'Traps').reduce<string[]>((traps, line) => {
      if (line.startsWith('- ') || !traps.length) traps.push(line.replace(/^- /, '').trim());
      else traps[traps.length - 1] += ` ${line.trim()}`;
      return traps;
    }, []),
    smallest_live_test: field(body, 'Smallest live test') ?? '',
  };
  if (!playbook.steps.length || !playbook.traps.length || !playbook.smallest_live_test) fail(`${id}: needs steps, traps and a smallest live test`);
  return playbook;
}

function parseReference(markdown: string): ReferenceTopic[] {
  const topics = markdown.split(/^## /m).slice(1).map((part) => {
    const match = /^(.+)\nApplies to: (.+)\n([\s\S]*)$/.exec(part) ?? fail(`reference.md: topic "${part.split('\n')[0]}" needs an "Applies to:" line`);
    return { title: match[1]!.trim(), appliesTo: match[2]!.split(',').map((entry) => entry.trim().split(/\s+/)), text: match[3]!.trim() };
  });
  return topics.length ? topics : fail('reference.md has no topics');
}

/** The reference topics for a flow: those for every flow (`all`), its direction or its currency. */
export function referenceFor(skill: Skill, flow: { direction?: string; currency?: string }): ReferenceTopic[] {
  return skill.reference.filter((topic) =>
    topic.appliesTo.some((entry) => entry.every((word) => word === 'all' || word === flow.direction || word === flow.currency)),
  );
}

export function parseSkill(files: SkillFiles): Skill {
  const sections = parseSections(files.skill);
  if (!sections.some((s) => s.title.startsWith('The plugin scripts'))) fail('SKILL.md has no "The plugin scripts" section');
  // One playbook per `## id: title` heading; the text before the first is the introduction.
  const playbooks = files.playbooks.split(/^## /m).slice(1).map(parsePlaybook);
  if (!playbooks.some((p) => p.id === 'general')) fail('playbooks.md has no general playbook');
  return { sections, checklist: parseChecklist(files.checklist), playbooks, reference: parseReference(files.reference) };
}

let cached: Skill | null = null;

/** The parsed skill. Read once; a malformed skill fails loudly. */
export function loadSkill(): Skill {
  cached ??= parseSkill(Object.fromEntries(Object.entries(SKILL_FILES).map(([k, f]) => [k, readFileSync(resolve(SKILL_DIR, f), 'utf8')])) as SkillFiles);
  return cached;
}
