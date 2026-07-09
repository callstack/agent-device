import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../../core/command-descriptor/registry.ts';
import { explainCommand, formatCommandExplanation } from '../command-explain.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const fileExists = (file: string) => fs.existsSync(path.join(repoRoot, file));

describe('explainCommand', () => {
  test('resolves every descriptor name and catalog key', () => {
    for (const descriptor of commandDescriptors) {
      expect(explainCommand(descriptor.name, { fileExists })).toMatchObject({
        found: true,
        explanation: { command: descriptor.name },
      });
      if ('key' in descriptor.catalog && descriptor.catalog.key) {
        expect(explainCommand(descriptor.catalog.key, { fileExists })).toMatchObject({
          found: true,
          explanation: { command: descriptor.name },
        });
      }
    }
  });

  test('projects click policy, flags, and validated ownership files', () => {
    const result = explainCommand('click', { fileExists });
    expect(result).toMatchObject({
      found: true,
      explanation: {
        command: 'click',
        family: 'interaction',
        daemon: { route: 'interaction' },
        exposure: {
          batchable: true,
          mcp: true,
          dispatch: false,
          postActionObservation: 'settle-and-verify',
        },
        cli: { usage: 'click <x y|@ref|selector>' },
      },
    });
    if (!result.found) return;
    expect(result.explanation.cli?.commandFlags.map((flag) => flag.key)).toContain('settle');
    expect(result.explanation.files).toContain('src/commands/interaction/index.ts');
    expect(result.explanation.files).toContain('src/daemon/handlers/interaction.ts');
    expect(result.explanation.files.every(fileExists)).toBe(true);
  });

  test('degrades gracefully for schema-only local commands', () => {
    expect(explainCommand('web', { fileExists })).toMatchObject({
      found: true,
      explanation: {
        command: 'web',
        catalog: { group: 'local-cli' },
        cli: { usage: 'web setup | web doctor' },
        files: ['src/core/command-descriptor/registry.ts', 'src/utils/cli-command-overrides.ts'],
      },
    });
  });
});

describe('formatCommandExplanation', () => {
  test('suggests close descriptor names for unknown queries', () => {
    expect(explainCommand('longpres')).toEqual({
      found: false,
      query: 'longpres',
      suggestions: expect.arrayContaining(['longpress']),
    });
  });

  test('renders concise text and serializable JSON', () => {
    const result = explainCommand('longPress', { fileExists });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(formatCommandExplanation(result.explanation)).toContain('longpress [public]');
    expect(JSON.parse(JSON.stringify(result.explanation))).toMatchObject({
      command: 'longpress',
      aliases: ['longPress'],
    });
  });
});
