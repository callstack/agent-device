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

function assertOpenFirstSetup(content: string): void {
  const openFirstRules = content.split(OPEN_FIRST).length - 1;
  assert.equal(openFirstRules, 3, 'recommended, Cursor, and Claude rules must start with open');
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
