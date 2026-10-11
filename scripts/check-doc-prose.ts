// `pnpm check:doc-prose` — flags filler, marketing, and time-relative words in the user docs
// (website/docs/**/*.md(x) and README.md). Line-based on purpose: no Markdown parser. It skips
// YAML frontmatter, fenced code blocks, inline code spans, HTML tags and comments, link
// destinations, and bare URLs, so commands and identifiers never trip a rule.
//
// There is no allowlist: a legitimate hit ('just' meaning 'only', a quoted message) gets its sentence
// rewritten.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_DIR = 'website/docs';

const FILLER = 'condescending filler: if it were simple, the reader would not be reading the docs';
const MARKETING = 'marketing adjective: state what the feature does instead';
const TIME_RELATIVE = 'time-relative: rots as soon as it ships; state the behavior or a version';

/** Banned words and phrases, matched case-insensitively as whole words. */
export const PROSE_RULES: readonly { readonly word: string; readonly reason: string }[] = [
  { word: 'just', reason: FILLER },
  { word: 'simply', reason: FILLER },
  { word: 'easy', reason: FILLER },
  { word: 'easily', reason: FILLER },
  { word: 'obvious', reason: FILLER },
  { word: 'obviously', reason: FILLER },
  { word: 'powerful', reason: MARKETING },
  { word: 'seamless', reason: MARKETING },
  { word: 'seamlessly', reason: MARKETING },
  { word: 'robust', reason: MARKETING },
  { word: 'intuitive', reason: MARKETING },
  { word: 'currently', reason: TIME_RELATIVE },
  { word: 'recently', reason: TIME_RELATIVE },
  { word: 'nowadays', reason: TIME_RELATIVE },
  { word: 'coming soon', reason: TIME_RELATIVE },
  { word: 'as of now', reason: TIME_RELATIVE },
  { word: 'newly added', reason: TIME_RELATIVE },
];

export type ProseViolation = {
  readonly line: number;
  readonly column: number;
  readonly word: string;
  readonly message: string;
};

const RULE_PATTERNS = PROSE_RULES.map((rule) => ({
  ...rule,
  pattern: new RegExp(String.raw`\b${rule.word.replaceAll(' ', String.raw`\s+`)}\b`, 'gi'),
}));

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
// Spans that are not prose, blanked in place so columns stay true.
const NON_PROSE = [
  /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, // inline code span; backtick runs of matching length
  /<!--.*?-->/g,
  /<\/?[A-Za-z][^>]*>/g, // HTML or JSX tag
  /\]\([^)]*\)/g, // link or image destination
  /\b(?:https?:\/\/|mailto:|www\.)\S+/g,
];

function blank(text: string): string {
  return ' '.repeat(text.length);
}

function maskNonProse(line: string): string {
  return NON_PROSE.reduce((masked, pattern) => masked.replace(pattern, blank), line);
}

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return close === -1 ? 0 : close + 1;
}

/** A closing fence repeats the opening character at least as many times, and nothing else. */
function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(fence) && trimmed.replaceAll(fence[0] ?? '', '') === '';
}

/** The open fence after `line`: opened, closed, or carried over. */
function fenceAfter(fence: string | null, line: string): string | null {
  if (fence === null) return FENCE_OPEN.exec(line)?.[1] ?? null;
  return closesFence(line, fence) ? null : fence;
}

/** The line with the end of a multi-line HTML comment blanked, or null when it does not end. */
function afterCommentClose(line: string): string | null {
  const end = line.indexOf('-->') + 3;
  return end < 3 ? null : blank(line.slice(0, end)) + line.slice(end);
}

/** Each line's prose with everything else blanked; lines inside code or comments yield nothing. */
function* proseLines(lines: readonly string[]): Generator<{ index: number; prose: string }> {
  let fence: string | null = null;
  let inComment = false;
  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const inCode = fence !== null || FENCE_OPEN.test(raw);
    fence = fenceAfter(fence, raw);
    if (inCode) continue;
    const line = inComment ? afterCommentClose(raw) : raw;
    if (line === null) continue;
    const prose = maskNonProse(line);
    const open = prose.indexOf('<!--');
    inComment = open !== -1;
    yield { index, prose: inComment ? prose.slice(0, open) : prose };
  }
}

/** Violations in one Markdown or MDX file. `fileName` prefixes each message. */
export function checkDocProse(fileName: string, text: string): ProseViolation[] {
  const violations: ProseViolation[] = [];
  for (const { index, prose } of proseLines(text.split('\n'))) {
    for (const { word, reason, pattern } of RULE_PATTERNS) {
      for (const match of prose.matchAll(pattern)) {
        const where = `${fileName}:${index + 1}:${match.index + 1}`;
        violations.push({
          line: index + 1,
          column: match.index + 1,
          word,
          message: `${where}: "${match[0]}" — ${reason}`,
        });
      }
    }
  }
  return violations.sort((a, b) => a.line - b.line || a.column - b.column);
}

function docFiles(): string[] {
  const pages = (fs.readdirSync(path.join(REPO_ROOT, DOCS_DIR), { recursive: true }) as string[])
    .map((entry) => `${DOCS_DIR}/${entry.split(path.sep).join('/')}`)
    .filter((file) => /\.mdx?$/.test(file));
  return ['README.md', ...pages.sort()];
}

function main(): number {
  const files = docFiles();
  const violations = files.flatMap((file) =>
    checkDocProse(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')),
  );
  if (violations.length === 0) {
    process.stdout.write(`doc prose: ${files.length} files clean.\n`);
    return 0;
  }
  for (const { message } of violations) process.stderr.write(`${message}\n`);
  process.stderr.write(
    `doc prose: ${violations.length} hit(s). Rewrite the sentence; the rules live in PROSE_RULES (scripts/check-doc-prose.ts).\n`,
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
