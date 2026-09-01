import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contractsImplementationAuthorityViolations } from './contracts-implementation-policy.ts';

function messages(source: string, path = 'packages/contracts/src/planted.ts'): string[] {
  return contractsImplementationAuthorityViolations([{ path, source }]).map(
    (violation) => violation.message,
  );
}

test('contracts rejects host process and timer mechanics', () => {
  for (const source of [
    "import fs from 'node:fs';",
    "import { readFile } from 'fs/promises';",
    "import { spawn } from 'node:child_process';",
    "import { setTimeout as sleep } from 'node:timers/promises';",
    'setTimeout(work, 10);',
    'globalThis.setImmediate(work);',
    'clearInterval(timer);',
  ]) {
    assert.equal(messages(source).length, 1, source);
  }
});

test('contracts policy ignores type vocabulary, prose, tests, and capture-kit mechanics', () => {
  assert.deepEqual(
    messages(
      [
        'export type Timeout = { setTimeout: number };',
        'const prose = "import fs from \'node:fs\'; setTimeout(work, 10)";',
        '// clearInterval(timer);',
      ].join('\n'),
    ),
    [],
  );
  assert.deepEqual(messages("import fs from 'node:fs';", 'packages/contracts/src/a.test.ts'), []);
  assert.deepEqual(
    messages("import fs from 'node:fs';", 'packages/capture-kit/src/app-log-output.ts'),
    [],
  );
});

test('network traffic vocabulary cannot grow parser implementation inside contracts', () => {
  assert.deepEqual(
    messages(
      [
        "import type { NetworkEntry } from './network-log.ts';",
        'export type NetworkDump = Readonly<{ entries: readonly NetworkEntry[] }>;',
        'export interface NetworkParserOptions { readonly maxEntries: number }',
      ].join('\n'),
      'packages/contracts/src/network-traffic.ts',
    ),
    [],
  );
  assert.match(
    messages(
      'export function readRecentNetworkTrafficFromText() { return []; }',
      'packages/contracts/src/network-traffic.ts',
    )[0]!,
    /runtime implementation/,
  );
  assert.match(
    messages(
      'export const parseNetworkTimestamp = (value: string) => value;',
      'packages/contracts/src/network-traffic-value.ts',
    )[0]!,
    /parser modules belong in @agent-device\/capture-kit/,
  );
  assert.deepEqual(
    messages(
      'export function readRecentNetworkTrafficFromText() { return []; }',
      'packages/capture-kit/src/network-traffic.ts',
    ),
    [],
  );
});

test('contracts rejects mutable interaction-outcome lifecycle', () => {
  assert.match(
    messages('const targets = new WeakMap();', 'packages/contracts/src/interaction-outcome.ts')[0]!,
    /src\/core/,
  );
});

test('contracts rejects snapshot quality warning rendering', () => {
  assert.match(
    messages(
      'export function renderSnapshotQualityWarnings() { return []; }',
      'packages/contracts/src/snapshot-quality-warnings.ts',
    )[0]!,
    /src\/snapshot\/snapshot-presentation/,
  );
});

test('iOS snapshot contracts reject planning implementation and provider imports', () => {
  const contract = 'packages/contracts/src/ios-snapshot.ts';
  assert.match(
    messages('export const presentSnapshot = (nodes: unknown[]) => nodes;', contract)[0]!,
    /typed vocabulary only/,
  );
  assert.match(
    messages(
      [
        "import type { planIosSnapshot } from '@agent-device/capture-kit/ios-snapshot-planning';",
        'export type IosPlan = { readonly value: string };',
      ].join('\n'),
      contract,
    )[0]!,
    /planning algorithms or provider\/lifecycle implementation/,
  );
  assert.match(
    messages(
      [
        "import type { ProviderSnapshot } from '@agent-device/provider-ios';",
        'export type IosProvider = { readonly value: string };',
      ].join('\n'),
      contract,
    )[0]!,
    /provider\/lifecycle implementation/,
  );
  assert.deepEqual(
    messages(
      [
        "import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';",
        'export type IosNode = RawSnapshotNode;',
      ].join('\n'),
      contract,
    ),
    [],
  );
});
