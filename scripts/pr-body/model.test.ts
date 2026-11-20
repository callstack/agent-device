// Tests for the pull-request body rules (scripts/pr-body/model.ts).
//
// Every case states the rule it pins and pairs a passing body with the closest failing one, so a
// rule that stops firing shows up as a missing failure rather than as a green run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPullRequest,
  conventionalType,
  countBodyWords,
  isBotAuthor,
  MIN_NO_CHANGE_REASON_WORDS,
  WORD_BUDGET,
  type BodyViolation,
  type ShaResolution,
} from './model.ts';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function verdictFor(
  title: string,
  body: string,
  overrides: {
    readonly author?: string;
    readonly authorType?: string;
    readonly draft?: boolean;
    readonly resolve?: (sha: string) => ShaResolution;
  } = {},
): {
  violations: readonly BodyViolation[];
  notes: readonly string[];
  exemption: string | null;
  words: number;
} {
  return checkPullRequest({
    title,
    body,
    author: overrides.author ?? 'thymikee',
    authorType: overrides.authorType ?? 'User',
    draft: overrides.draft ?? false,
    head: HEAD,
    resolveValidationSha:
      overrides.resolve ??
      ((sha) =>
        sha === HEAD.slice(0, 10)
          ? { verdict: 'ancestor' }
          : { verdict: 'unknown', reason: 'not fetched' }),
  });
}

function rulesOf(verdict: { violations: readonly BodyViolation[] }): string[] {
  return verdict.violations.map((violation) => violation.rule);
}

const PASSING = `## Summary

The CLI now waits for the emulator process to exit. Closes #4700.

## Before / after

Before, \`close --shutdown\` returned first. After, it returns once the process is gone.

## Validation

Tested at \`${HEAD.slice(0, 10)}\`. \`pnpm check:affected --run\` passed.`;

test('a body with every required section passes', () => {
  const verdict = verdictFor('fix(close): wait for the emulator to exit', PASSING);
  assert.deepEqual(verdict.violations, []);
  assert.deepEqual(verdict.notes, []);
  assert.equal(verdict.exemption, null);
});

test('each failure message names its rule and what to add', () => {
  const verdict = verdictFor('feat(audit): add a check', '## Summary\n');
  for (const violation of verdict.violations) {
    assert.match(violation.message, /^[A-Za-z /]+ rule: /);
    assert.ok(violation.message.endsWith('.'), violation.message);
  }
});

test('a missing Summary, Before / after, and Validation are reported together', () => {
  const verdict = verdictFor('feat(audit): add a check', 'nothing here');
  // The SHA rule stays quiet when the section it governs is absent: the Validation failure already
  // names it, and two messages for one omission read as two things to fix.
  assert.deepEqual(rulesOf(verdict), ['summary', 'before-after', 'validation']);
});

test('a Summary heading with no prose fails the Summary rule', () => {
  const verdict = verdictFor('chore(gates): enforce bodies', '## Summary\n\n## Validation\n\nx');
  assert.ok(rulesOf(verdict).includes('summary'));
});

test('a feat without Before / after fails, and a chore without it passes', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(rulesOf(verdictFor('feat(audit): add a check', body)), ['before-after']);
  assert.deepEqual(rulesOf(verdictFor('chore(gates): enforce bodies', body)), []);
});

test('the scope and the breaking marker do not hide the type', () => {
  assert.equal(conventionalType('feat(audit)!: drop the flag'), 'feat');
  assert.equal(conventionalType('fix: repair close'), 'fix');
  assert.equal(conventionalType('refactor(host-kit): move a module'), 'refactor');
  assert.equal(conventionalType('docs(agents): shorten a rule'), 'docs');
  assert.equal(conventionalType('Rebuilt the CLI'), null);
});

test('a feat with a scoped breaking title still requires Before / after', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(rulesOf(verdictFor('feat(audit)!: drop the flag', body)), ['before-after']);
});

test('Before / after stating No observable change with a reason passes', () => {
  const body = `## Summary\n\nReason.\n\n## Before / after\n\nNo observable change: the flag is internal and no output differs.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(verdictFor('fix(cli): drop an internal flag', body).violations, []);
});

test('Before / after stating No observable change without a reason fails', () => {
  const body = `## Summary\n\nReason.\n\n## Before / after\n\nNo observable change.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(rulesOf(verdictFor('fix(cli): drop an internal flag', body)), ['before-after']);
});

test('the No observable change floor is a stated reason, not the phrase', () => {
  // The shortest accepted reason is the phrase plus one clause, so the floor sits above both.
  assert.ok(MIN_NO_CHANGE_REASON_WORDS > 'No observable change'.split(' ').length);
  const short = 'No observable change: internal only.';
  const reason = 'No observable change: the flag is internal and no output differs.';
  assert.ok(
    short.split(/\s+/).length < MIN_NO_CHANGE_REASON_WORDS &&
      reason.split(/\s+/).length >= MIN_NO_CHANGE_REASON_WORDS,
  );
});

test('a refactor requires Value and other types do not', () => {
  const body = `## Summary\n\nMoved it.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(rulesOf(verdictFor('refactor(host-kit): move a module', body)), ['value']);
  assert.deepEqual(rulesOf(verdictFor('test(daemon): pin a deadline', body)), []);
});

test('a Value section holding only measured numbers in a table or a transcript satisfies the rule', () => {
  // Numbers are often printed as a table or a command transcript, and that is the content the rule
  // asks for. What it rejects is an empty section.
  const table = `## Summary\n\nMoved it.\n\n## Value\n\n| Metric | Base | Head |\n| --- | --- | --- |\n| Lines | 905 | 120 |\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(verdictFor('refactor(host-kit): move a module', table).violations, []);
  const empty = `## Summary\n\nMoved it.\n\n## Value\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.ok(rulesOf(verdictFor('refactor(host-kit): move a module', empty)).includes('value'));
});

test('the Validation section requires a SHA', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nAll checks passed.`;
  assert.deepEqual(rulesOf(verdictFor('chore(gates): enforce bodies', body)), ['validation-sha']);
});

test('a Validation SHA that is an ancestor of the head passes', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'ancestor' }),
  });
  assert.deepEqual(verdict.violations, []);
});

test('a Validation SHA that is not an ancestor fails as a stale body', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at deadbeef.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'diverged' }),
  });
  assert.deepEqual(rulesOf(verdict), ['validation-sha']);
  assert.match(verdict.violations[0]!.message, /not an ancestor of this PR's head/);
});

test('a Validation SHA the repository does not have fails as unreachable', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at ${'b'.repeat(40)}.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'unreachable' }),
  });
  assert.deepEqual(rulesOf(verdict), ['validation-sha']);
  assert.match(verdict.violations[0]!.message, /not a commit this repository has/);
});

test('a date or a count the repository has no commit for is not read as the tested SHA', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested 20261120 over 1000000 runs.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'unreachable' }),
  });
  assert.deepEqual(rulesOf(verdict), ['validation-sha']);
  assert.match(verdict.violations[0]!.message, /name the tested commit SHA/);
});

test('an all-digit SHA the repository has still counts', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at 1234567.`;
  const ancestor = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'ancestor' }),
  });
  assert.deepEqual(ancestor.violations, []);
  const diverged = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'diverged' }),
  });
  assert.match(diverged.violations[0]!.message, /not an ancestor of this PR's head/);
});

test('a SHA this checkout cannot resolve is a note, not a failure', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'unknown', reason: 'this checkout does not carry the PR head' }),
  });
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.notes.length, 1);
  assert.match(verdict.notes[0]!, /was not compared with the PR head/);
});

test('a base SHA named beside the tested SHA still satisfies the rule', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\nBase \`cafe123\`, tested at ${HEAD.slice(0, 10)}.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: (sha) =>
      sha === HEAD.slice(0, 10) ? { verdict: 'ancestor' } : { verdict: 'diverged' },
  });
  assert.deepEqual(verdict.violations, []);
});

test('a SHA inside a fenced receipt still counts', () => {
  const body = `## Summary\n\nReason.\n\n## Validation\n\n\`\`\`\ncheck:affected --run --head ${HEAD.slice(0, 10)} ok\n\`\`\`\n\nPassed.`;
  const verdict = verdictFor('chore(gates): enforce bodies', body, {
    resolve: () => ({ verdict: 'ancestor' }),
  });
  assert.deepEqual(verdict.violations, []);
});

test('an issue number is not read as a SHA', () => {
  const body = `## Summary\n\nPart of #4761.\n\n## Validation\n\nAll checks passed, see #4761.`;
  assert.deepEqual(rulesOf(verdictFor('chore(gates): enforce bodies', body)), ['validation-sha']);
});

test('the word budget counts prose outside code blocks and tables', () => {
  const filler = 'word '.repeat(250);
  assert.equal(countBodyWords(filler), 250);
  // A heading is prose too: it is the author's words.
  assert.equal(countBodyWords(`## Summary\n\n${filler}`), 251);
  // A fenced block and a table each leave only the heading.
  const heading = countBodyWords('## Summary');
  assert.equal(countBodyWords('## Summary\n\n```\n' + filler + '\n```\n'), heading);
  assert.equal(
    countBodyWords(`## Summary\n\n| a | b |\n| --- | --- |\n| ${filler} | ${filler} |\n`),
    heading,
  );
});

test('a body at the budget fails and one word under it passes', () => {
  const prose = 'word '.repeat(WORD_BUDGET);
  const body = `## Summary\n\n${prose}\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.ok(rulesOf(verdictFor('chore(gates): enforce bodies', body)).includes('word-budget'));
  const shorter = body.replace(prose, 'word '.repeat(WORD_BUDGET - 10));
  assert.ok(
    !rulesOf(verdictFor('chore(gates): enforce bodies', shorter)).includes('word-budget'),
    'a body under the budget must not trip it',
  );
});

const FOOTER =
  '<!-- codesmith:footer -->\n' +
  'Autofix footer prose that nobody wrote and nobody can edit. '.repeat(20) +
  '\n<!-- /codesmith:footer -->\n\n' +
  '<!-- This is an auto-generated description by cubic. -->\n' +
  'Generated summary prose that repeats the whole diff. '.repeat(20) +
  '<!-- End of auto-generated description by cubic. -->\n';

test('bot footers are excluded from the word count', () => {
  const withFooter = `${PASSING}\n\n${FOOTER}`;
  assert.equal(countBodyWords(withFooter), countBodyWords(PASSING));
  assert.deepEqual(
    verdictFor('fix(close): wait for the emulator to exit', withFooter).violations,
    [],
  );
});

test('a footer cannot contribute a heading', () => {
  const body =
    `## Summary\n\nReason.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.\n\n` +
    `<!-- codesmith:footer -->\n\n## Before / after\n\nMade by the bot, not the author.\n`;
  assert.deepEqual(rulesOf(verdictFor('fix(close): wait for the emulator to exit', body)), [
    'before-after',
  ]);
});

test('a heading inside a fenced example does not open a section', () => {
  const body = `## Summary\n\nReason.\n\n\`\`\`md\n## Before / after\n\nNot a section.\n\`\`\`\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(rulesOf(verdictFor('fix(close): wait for the emulator to exit', body)), [
    'before-after',
  ]);
});

test('level-three headings stay inside their section', () => {
  const body = `## Summary\n\nReason.\n\n## Before / after\n\n### Before\n\n4 warnings.\n\n### After\n\n8 warnings.\n\n## Validation\n\nTested at ${HEAD.slice(0, 10)}.`;
  assert.deepEqual(verdictFor('feat(audit): run native checks', body).violations, []);
});

test('an empty section does not satisfy its rule', () => {
  const body = '## Summary\n\nReason.\n\n## Validation\n\n## Before / after\n';
  const verdict = verdictFor('fix(close): wait for the emulator to exit', body);
  // Both sections are present and both are empty, and the SHA rule stays quiet because the section it
  // governs holds nothing to name a SHA in.
  assert.deepEqual(rulesOf(verdict), ['before-after', 'validation']);
});

test('a draft is exempt', () => {
  const verdict = verdictFor('feat(audit): add a check', '', { draft: true });
  assert.deepEqual(verdict.violations, []);
  assert.match(verdict.exemption ?? '', /draft/);
});

test('a bot author is exempt', () => {
  for (const author of ['renovate[bot]', 'dependabot[bot]', 'renovate']) {
    const verdict = verdictFor('fix(deps): bump vitest', '', { author });
    assert.deepEqual(verdict.violations, []);
    assert.match(verdict.exemption ?? '', /bot/);
  }
  assert.equal(isBotAuthor('thymikee', 'User'), false);
  assert.equal(isBotAuthor('octocat', 'Bot'), true);
});

test('CRLF endings do not hide a heading', () => {
  const crlf = PASSING.replaceAll('\n', '\r\n');
  assert.deepEqual(verdictFor('fix(close): wait for the emulator to exit', crlf).violations, []);
});
