import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { parseSync } from 'oxc-parser';
import { readRunnerRequestFixture, REPO_ROOT } from '@agent-device/test-kit';

/**
 * The repository-wide half of the runner request pin (`contracts/fixtures/runner-requests.json`):
 * the drives that produce each entry live in the apple-runner package, platform-apple, and root, so
 * the guard that reads their sources belongs to no one package. Each package drive pins its own
 * entries with `assertProducedRunnerRequests`; this file proves every producer is such a drive and
 * that no drive writes a request itself.
 */

test('every runner request producer is a dedicated runner-requests drive that checks its own entries', () => {
  for (const producer of new Set(readRunnerRequestFixture().map((entry) => entry.producer))) {
    const source = fs.readFileSync(path.join(REPO_ROOT, producer), 'utf8');
    assert.ok(
      producer.endsWith('runner-requests.test.ts') &&
        source.includes('assertProducedRunnerRequests(import.meta.filename'),
      `${producer} must be a dedicated *runner-requests.test.ts drive that checks its own entries`,
    );
  }
});

const SEND_NAMES = new Set([
  'runAppleRunnerCommand',
  'executeRunnerCommandWithSession',
  'waitForRunner',
  'sendRunnerCommandOnce',
]);

function requestDriveViolations(source: string, file: string): string[] {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, []);
  const sendAliases = new Set(SEND_NAMES);
  const violations: string[] = [];
  type Node = {
    type?: string;
    name?: string;
    value?: unknown;
    start?: number;
    [key: string]: unknown;
  };
  function walk(value: unknown, visit: (node: Node) => void): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
      return;
    }
    const node = value as Node;
    visit(node);
    for (const child of Object.values(node)) walk(child, visit);
  }
  const nodeName = (value: unknown): string | undefined => {
    const node = value as Node | undefined;
    return node?.type === 'Identifier'
      ? node.name
      : typeof node?.value === 'string'
        ? node.value
        : undefined;
  };
  walk(parsed.program, (node) => {
    if (node.type === 'ImportSpecifier' && SEND_NAMES.has(nodeName(node.imported) ?? '')) {
      const alias = nodeName(node.local);
      if (alias) sendAliases.add(alias);
    }
  });
  walk(parsed.program, (node) => {
    if (node.type === 'VariableDeclarator' && sendAliases.has(nodeName(node.init) ?? '')) {
      const alias = nodeName(node.id);
      if (alias) sendAliases.add(alias);
    }
  });
  walk(parsed.program, (node) => {
    const line = source.slice(0, node.start).split('\n').length;
    if (
      node.type === 'Property' &&
      !node.shorthand &&
      nodeName(node.key) === 'command' &&
      nodeName(node.value) !== 'RunnerCommand'
    ) {
      violations.push(`request literal at ${line}`);
    }
    if (node.type === 'CallExpression' && sendAliases.has(nodeName(node.callee) ?? '')) {
      violations.push(`direct send at ${line}`);
    }
  });
  return violations;
}

test('the request drive guard catches quoted and computed fields and aliased sends', () => {
  assert.equal(
    requestDriveViolations(
      "const a = { 'command': 'tap' }; const b = { ['command']: 'tap' };",
      'fixture.ts',
    ).length,
    2,
  );
  assert.equal(
    requestDriveViolations(
      "import { runAppleRunnerCommand as send } from './runner'; const sendAgain = send; sendAgain(device, request);",
      'fixture.ts',
    ).length,
    1,
  );
  assert.deepEqual(
    requestDriveViolations('const send = { command: RunnerCommand };', 'fixture.ts'),
    [],
  );
});

test('runner request drives send only requests production builds', () => {
  const producers = readRunnerRequestFixture().map((entry) => path.join(REPO_ROOT, entry.producer));
  const sources = [
    ...new Set(producers),
    path.join(REPO_ROOT, 'packages/test-kit/src/runner-requests.fixtures.ts'),
    path.join(REPO_ROOT, 'packages/platform-apple/src/__tests__/recording-runner-provider.ts'),
  ];
  const offending = sources.flatMap((file) =>
    requestDriveViolations(fs.readFileSync(file, 'utf8'), file).map(
      (violation) => `${path.relative(REPO_ROOT, file)}: ${violation}`,
    ),
  );
  assert.deepEqual(offending, []);
});
