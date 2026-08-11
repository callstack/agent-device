import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

type Contract = {
  id: string;
  requiredText: string;
};

type Prohibition = {
  id: string;
  forbiddenText: string;
};

const SKILLS = [
  {
    name: 'iOS Simulator',
    path: join(ROOT, 'skills', 'ios-simulator', 'SKILL.md'),
    contracts: [
      {
        id: 'human-owned CLI installation',
        requiredText: 'npm install -g agent-device@latest',
      },
      {
        id: 'immediate app-driving start',
        requiredText: 'For a normal app-driving task, start immediately.',
      },
      { id: 'validation help routing', requiredText: 'agent-device help validate' },
      {
        id: 'autonomous mutable install refusal',
        requiredText: 'Do not run that command autonomously',
      },
      {
        id: 'foreground platform open',
        requiredText: 'agent-device open <app-or-bundle-id> --platform ios --foreground',
      },
    ] satisfies Contract[],
    prohibitions: [
      { id: 'version startup probe', forbiddenText: 'agent-device --version' },
      { id: 'routine help startup probe', forbiddenText: 'agent-device help manual-qa' },
    ] satisfies Prohibition[],
  },
  {
    name: 'Android Emulator',
    path: join(ROOT, 'skills', 'android-emulator', 'SKILL.md'),
    contracts: [
      {
        id: 'human-owned CLI installation',
        requiredText: 'npm install -g agent-device@latest',
      },
      {
        id: 'immediate app-driving start',
        requiredText: 'For a normal app-driving task, start immediately.',
      },
      { id: 'validation help routing', requiredText: 'agent-device help validate' },
      {
        id: 'autonomous mutable install refusal',
        requiredText: 'Do not run that command autonomously',
      },
      {
        id: 'foreground platform open',
        requiredText: 'agent-device open <app-or-package-id> --platform android --foreground',
      },
    ] satisfies Contract[],
    prohibitions: [
      { id: 'version startup probe', forbiddenText: 'agent-device --version' },
      { id: 'routine help startup probe', forbiddenText: 'agent-device help manual-qa' },
    ] satisfies Prohibition[],
  },
] as const;

function assertSkillContract(content: string, contract: Contract): void {
  assert.ok(content.includes(contract.requiredText), `missing ${contract.id} guidance`);
}

function assertSkillProhibition(content: string, prohibition: Prohibition): void {
  assert.ok(!content.includes(prohibition.forbiddenText), `contains ${prohibition.id} guidance`);
}

describe('simulator skill contracts', () => {
  for (const skill of SKILLS) {
    test(`${skill.name} keeps its required workflow guidance`, async () => {
      const content = await readFile(skill.path, 'utf8');
      for (const contract of skill.contracts) assertSkillContract(content, contract);
      for (const prohibition of skill.prohibitions) {
        assertSkillProhibition(content, prohibition);
      }
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

    for (const prohibition of skill.prohibitions) {
      test(`${skill.name} rejects ${prohibition.id} guidance`, async () => {
        const content = await readFile(skill.path, 'utf8');
        const broken = `${content}\n${prohibition.forbiddenText}\n`;
        assert.throws(
          () => assertSkillProhibition(broken, prohibition),
          new RegExp(`contains ${prohibition.id} guidance`),
        );
      });
    }
  }
});
