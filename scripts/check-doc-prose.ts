// `pnpm check:doc-prose` — flags filler, marketing, and time-relative words in the user docs
// (website/docs/**/*.md(x) and README.md). Regex masks on purpose: no Markdown parser. It blanks
// YAML frontmatter, HTML comments, fenced code blocks, inline code spans, HTML tags, link
// destinations, and bare URLs, so commands and identifiers never trip a rule. Destinations with
// nested parentheses are not masked.
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

const FRONTMATTER = /^---\n[\s\S]*?\n---(?=\n|$)/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// A fence line, optionally inside blockquotes: the marker run, then the info string or nothing.
const FENCE_LINE = /^ {0,3}(?:> ?)*(`{3,}|~{3,})(.*)$/;
// Spans that are not prose. Code spans stop at a blank line, as paragraphs do.
const NON_PROSE = [
  /(?<!`)(`+)(?!`)(?:(?!\n\s*\n)[\s\S])*?(?<!`)\1(?!`)/g, // backtick runs of matching length
  /<\/?[A-Za-z][^>]*>/g, // HTML or JSX tag
  /\]\([^)]*\)/g, // link or image destination
  /\b(?:https?:\/\/|mailto:|www\.)\S+/g,
];

/** Spaces in place of everything but newlines, so line and column math stays exact. */
function blank(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

/** Blank every fenced code block, fence lines included; an unclosed fence runs to the end. */
function blankFences(text: string): string {
  let fence: string | null = null;
  const lines = text.split('\n').map((line) => {
    const [, marker = '', info = ''] = FENCE_LINE.exec(line) ?? [];
    if (fence === null && marker === '') return line;
    if (fence === null) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && info.trim() === '') {
      fence = null;
    }
    return blank(line);
  });
  return lines.join('\n');
}

function proseOnly(text: string): string {
  const masked = blankFences(text.replace(FRONTMATTER, blank).replaceAll(HTML_COMMENT, blank));
  return NON_PROSE.reduce((prose, pattern) => prose.replaceAll(pattern, blank), masked);
}

/** Violations in one Markdown or MDX file. `fileName` prefixes each message. */
export function checkDocProse(fileName: string, text: string): ProseViolation[] {
  // A Windows checkout with core.autocrlf has CRLF endings; the scan assumes LF.
  const prose = proseOnly(text.replaceAll('\r\n', '\n'));
  const violations = RULE_PATTERNS.flatMap(({ word, reason, pattern }) =>
    [...prose.matchAll(pattern)].map((match) => {
      const line = prose.slice(0, match.index).split('\n').length;
      const column = match.index - prose.lastIndexOf('\n', match.index - 1);
      const where = `${fileName}:${line}:${column}`;
      return { line, column, word, message: `${where}: "${match[0]}" — ${reason}` };
    }),
  );
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
