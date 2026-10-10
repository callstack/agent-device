import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const AGENT_SETUP = join(ROOT, 'website', 'docs', 'docs', 'agent-setup.md');
const OPEN_FIRST = 'For a normal app-driving task, start immediately.';
const MANDATORY_STARTUP_PROBES = [
  {
    pattern: /Before planning commands, run `agent-device --version`/,
    example: 'Before planning commands, run `agent-device --version`',
  },
  {
    pattern: /Before planning device work, run `agent-device --version`/,
    example: 'Before planning device work, run `agent-device --version`',
  },
  {
    pattern: /run `agent-device help workflow` before planning/,
    example: 'run `agent-device help workflow` before planning',
  },
] as const;

const RECOMMENDED_RULE_HEADING = '## Recommended agent rule';

function readCanonicalRule(content: string): string {
  const sectionStart = content.indexOf(RECOMMENDED_RULE_HEADING);
  assert.notEqual(sectionStart, -1, 'agent setup must have a recommended agent rule section');
  const sectionEnd = content.indexOf('\n## ', sectionStart + RECOMMENDED_RULE_HEADING.length);
  const section = content.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const ruleBlocks = [...section.matchAll(/^```text\n([\s\S]*?)^```$/gm)];
  assert.equal(ruleBlocks.length, 1, 'recommended agent rule section must hold one rule block');
  return ruleBlocks[0][1];
}

function assertOpenFirstSetup(content: string): void {
  assert.ok(
    readCanonicalRule(content).split('\n')[1]?.startsWith(OPEN_FIRST),
    'canonical agent rule must start normal work with open right after its scope line',
  );
  const openFirstRules = content.split(OPEN_FIRST).length - 1;
  assert.equal(openFirstRules, 1, 'client setup must reference the canonical rule, not copy it');
  for (const probe of MANDATORY_STARTUP_PROBES) {
    assert.doesNotMatch(
      content,
      probe.pattern,
      `agent setup contains mandatory startup probe: ${probe.pattern}`,
    );
  }
}

test('agent setup rules start normal work with open and avoid mandatory probes', async () => {
  assertOpenFirstSetup(await readFile(AGENT_SETUP, 'utf8'));
});

for (const probe of MANDATORY_STARTUP_PROBES) {
  test(`agent setup contract rejects ${probe.pattern}`, async () => {
    const content = await readFile(AGENT_SETUP, 'utf8');
    assert.throws(
      () => assertOpenFirstSetup(`${content}\n${probe.example}\n`),
      /agent setup contains mandatory startup probe/,
    );
  });
}

test('agent setup contract rejects a rule that defers the open-first instruction', async () => {
  const content = await readFile(AGENT_SETUP, 'utf8');
  const openFirstLine = content.split('\n').find((line) => line.startsWith(OPEN_FIRST));
  assert.ok(openFirstLine);
  const deferred = content
    .replace(`${openFirstLine}\n`, '')
    .replace(
      'Keep mutating commands against one session serial.\n',
      `Keep mutating commands against one session serial.\n${openFirstLine}\n`,
    );
  assert.notEqual(deferred, content);
  assert.throws(() => assertOpenFirstSetup(deferred), /right after its scope line/);
});
