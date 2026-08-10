import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

type Contract = {
  id: string;
  requiredText: string;
};

const SKILLS = [
  {
    name: 'iOS Simulator',
    path: join(ROOT, 'skills', 'ios-simulator', 'SKILL.md'),
    contracts: [
      {
        id: 'foreground platform open',
        requiredText: 'agent-device open <app-or-bundle-id> --platform ios --foreground',
      },
      {
        id: 'initial interactive snapshot',
        requiredText: '`open` returns the initial interactive snapshot.',
      },
      { id: 'current ref or selector', requiredText: 'Use its current refs or a selector.' },
      { id: 'settled planned actions', requiredText: 'agent-device press @eN --settle' },
      { id: 'type settle exception', requiredText: '`type` never takes `--settle`;' },
      {
        id: 'end-state verification',
        requiredText: 'Verify the end state with a selector or exact text, then close:',
      },
      { id: 'session close', requiredText: 'agent-device close' },
    ] satisfies Contract[],
  },
  {
    name: 'Android Emulator',
    path: join(ROOT, 'skills', 'android-emulator', 'SKILL.md'),
    contracts: [
      {
        id: 'foreground platform open',
        requiredText: 'agent-device open <app-or-package-id> --platform android --foreground',
      },
      {
        id: 'initial interactive snapshot',
        requiredText: '`open` returns the initial interactive snapshot.',
      },
      { id: 'current ref or selector', requiredText: 'Use its current refs or a selector.' },
      { id: 'settled planned actions', requiredText: 'agent-device press @eN --settle' },
      { id: 'type settle exception', requiredText: '`type` never takes `--settle`;' },
      {
        id: 'end-state verification',
        requiredText: 'Verify the end state with a selector or exact text, then close:',
      },
      { id: 'session close', requiredText: 'agent-device close' },
    ] satisfies Contract[],
  },
] as const;

function assertSkillContract(content: string, contract: Contract): void {
  assert.ok(content.includes(contract.requiredText), `missing ${contract.id} guidance`);
}

describe('simulator skill contracts', () => {
  for (const skill of SKILLS) {
    test(`${skill.name} keeps its required workflow guidance`, async () => {
      const content = await readFile(skill.path, 'utf8');
      for (const contract of skill.contracts) assertSkillContract(content, contract);
    });

    for (const contract of skill.contracts) {
      test(`${skill.name} rejects a missing ${contract.id} contract`, async () => {
        const content = await readFile(skill.path, 'utf8');
        const broken = content.replace(contract.requiredText, '[removed]');
        assert.notEqual(broken, content, `test fixture must remove ${contract.id} guidance`);
        assert.throws(
          () => assertSkillContract(broken, contract),
          new RegExp(`missing ${contract.id} guidance`),
        );
      });
    }
  }
});
