// The pull request body gate: `pnpm check:pr-body`.
//
// Enforces the `## PR body` rule in docs/agents/pull-requests.md. It reads the title and the body from
// the event payload at `GITHUB_EVENT_PATH`, never from the checked-out tree, so it has nothing to
// grade outside CI.

import fs from 'node:fs';

const WORD_LIMIT = 250;
/** Review bots append a footer to the body. The author did not write it, so it is not counted. */
const BOT_FOOTER = /<!--\s*(?:codesmith:footer|This is an auto-generated description)/;

const SECTION_HINTS: Readonly<Record<string, string>> = {
  Summary: 'the invariant and behavior, the reason, the linked issue, and scope expansion',
  'Before / after':
    'up to 3 calls at base and head with the output that differs, or `No observable change` with a reason',
  Value: '2-4 numbers measured at base and head',
  Validation: 'the tested SHA, command results, CI obligations, and unresolved risks',
};

type PullRequest = {
  title?: string;
  body?: string | null;
  draft?: boolean;
  user?: { login?: string; type?: string };
};

function requiredSections(title: string): string[] {
  const type = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(title.trim())?.[1];
  if (type === 'feat' || type === 'fix') return ['Summary', 'Before / after', 'Validation'];
  if (type === 'refactor') return ['Summary', 'Value', 'Validation'];
  return ['Summary', 'Validation'];
}

/** The text under a `## <heading>` line, up to the next heading. Undefined without that heading. */
function sectionText(prose: string, heading: string): string | undefined {
  const lines = prose.split('\n');
  const wanted = `## ${heading}`.toLowerCase();
  const start = lines.findIndex(
    (line) =>
      line
        .trim()
        .toLowerCase()
        .replace(/\s*\/\s*/, ' / ') === wanted,
  );
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

function bodyViolations(title: string, body: string): string[] {
  const prose = (body.split(BOT_FOOTER)[0] ?? '')
    .replaceAll('\r', '')
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/^(`{3,}|~{3,})[\s\S]*?^\1[^\n]*$/gm, '');
  const violations = requiredSections(title)
    .filter((heading) => !sectionText(prose, heading))
    .map((heading) => `Add a "## ${heading}" section: ${SECTION_HINTS[heading]}.`);
  const words = prose.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (words >= WORD_LIMIT) {
    violations.push(
      `Shorten the body: it has ${words} words outside code blocks, and the limit is below ${WORD_LIMIT}.`,
    );
  }
  return violations;
}

function main(): number {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error('check:pr-body grades a pull request event. It runs in CI only.');
    return 1;
  }
  const pullRequest: PullRequest | undefined = JSON.parse(
    fs.readFileSync(eventPath, 'utf8'),
  ).pull_request;
  if (!pullRequest) {
    console.error(`${eventPath} holds no pull_request event.`);
    return 1;
  }
  const { title = '', body, draft, user } = pullRequest;
  if (draft || user?.type === 'Bot' || user?.login?.endsWith('[bot]')) {
    console.log('PR body: not checked for a draft or a bot author.');
    return 0;
  }
  const violations = bodyViolations(title, body ?? '');
  if (violations.length === 0) {
    console.log('PR body: ok.');
    return 0;
  }
  console.error(`PR body: ${violations.length} rule(s) failed. See docs/agents/pull-requests.md.`);
  for (const violation of violations) console.error(`- ${violation}`);
  return 1;
}

process.exitCode = main();
