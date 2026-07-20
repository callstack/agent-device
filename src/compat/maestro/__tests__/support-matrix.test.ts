import fs from 'node:fs';
import { expect, test } from 'vitest';
import { usageForCommand } from '../../../cli/parser/args.ts';
import { getFlagDefinitions } from '../../../commands/cli-grammar/flag-registry.ts';
import {
  MAESTRO_COMPATIBILITY_ADR_URL,
  MAESTRO_COMPATIBILITY_ISSUE_URL,
  MAESTRO_COMPAT_LIMITATIONS,
  MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
} from '../support-matrix.ts';

test('Maestro flag routes to the versioned compatibility help topic', () => {
  const flag = getFlagDefinitions().find((definition) => definition.key === 'replayMaestro');
  expect(flag?.usageDescription).toContain('supported Maestro YAML subset');
  expect(flag?.usageDescription).toContain('agent-device help maestro');
});

test('Maestro help covers the supported subset and operational boundaries', async () => {
  const help = await usageForCommand('maestro');
  expect(help).not.toBeNull();
  for (const statement of [
    ...MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
    ...MAESTRO_COMPAT_LIMITATIONS,
  ]) {
    expect(help).toContain(statement);
  }
  expect(help).toContain(MAESTRO_COMPATIBILITY_ADR_URL);
  expect(help).toContain(MAESTRO_COMPATIBILITY_ISSUE_URL);
  expect(help).not.toContain('issues/558');
});

test('Maestro replay docs stay in sync with versioned compatibility help', () => {
  const docs = fs.readFileSync('website/docs/docs/replay-e2e.md', 'utf8');
  const plainDocs = docs.replace(/`/g, '');
  for (const statement of [
    ...MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
    ...MAESTRO_COMPAT_LIMITATIONS,
  ]) {
    expect(plainDocs).toContain(statement);
  }
  expect(docs).toContain(MAESTRO_COMPATIBILITY_ADR_URL);
  expect(docs).toContain(MAESTRO_COMPATIBILITY_ISSUE_URL);
  expect(docs).not.toContain('issues/558');
});
