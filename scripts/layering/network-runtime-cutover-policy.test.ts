import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  networkLegacyRouteViolations,
  networkRuntimeNarrowingViolations,
  networkRuntimeRouteViolations,
} from './network-runtime-cutover-policy.ts';

test('network cutover scan catches planted legacy execution and dual admission', () => {
  assert.deepEqual(
    networkLegacyRouteViolations([
      {
        path: 'src/daemon/handlers/planted.ts',
        source: `
          await readSessionNetworkCapture(input);
          await provider.dumpNetwork({ include: 'all' });
          requireCommandSupported('network', device);
        `,
      },
      {
        path: 'src/core/command-descriptor/registry.ts',
        source: `const commands = [{ name: 'network', capability: { apple: {} } }];`,
      },
      {
        path: 'src/core/capabilities.ts',
        source: `const WEB_QUERY_COMMANDS = ['find', 'network'];`,
      },
      {
        path: 'src/platforms/apple/plugin.ts',
        source: `const supports = { [PUBLIC_COMMANDS.network]: supportsDevice };`,
      },
    ]),
    [
      'src/daemon/handlers/planted.ts: legacy network route readSessionNetworkCapture',
      'src/daemon/handlers/planted.ts: daemon invokes legacy WebProvider.dumpNetwork',
      'src/daemon/handlers/planted.ts: legacy network capability admission requireCommandSupported',
      'src/core/command-descriptor/registry.ts: network descriptor retains legacy capability admission',
      'src/core/capabilities.ts: static platform command set retains network admission',
      'src/platforms/apple/plugin.ts: Apple plugin retains legacy network support or hint closure',
    ],
  );
});

test('network cutover scan rejects a retired implementation by committed path', () => {
  assert.deepEqual(
    networkLegacyRouteViolations([
      { path: 'src/daemon/network-log.ts', source: `export const parser = () => [];` },
    ]),
    ['src/daemon/network-log.ts: retired daemon network implementation remains'],
  );
});

test('network cutover scan ignores retired names in comments and string data', () => {
  assert.deepEqual(
    networkLegacyRouteViolations([
      {
        path: 'src/daemon/planted.ts',
        source: `
          // readSessionNetworkCapture and requireCommandSupported('network') were removed.
          const note = 'provider.dumpNetwork and PUBLIC_COMMANDS.network';
        `,
      },
    ]),
    [],
  );
});

test('network narrowing scan catches planted casts, non-null repair, and bracket access', () => {
  const violations = networkRuntimeNarrowingViolations([
    {
      path: 'src/daemon/handlers/planted.ts',
      source: `
        const widened = runtime as BoundDeviceRuntime<typeof use>;
        widened.operations.networkDump!({});
        widened.operations['networkDump']({});
      `,
    },
  ]);
  assert.equal(violations.length, 3);
  assert.match(violations.join('\n'), /type assertion/);
  assert.match(violations.join('\n'), /non-null/);
  assert.match(violations.join('\n'), /bracketed/);
});

test('network route scan rejects planted neither and duplicate routes', () => {
  assert.deepEqual(networkRuntimeRouteViolations([]), [
    '(network runtime): expected one handleNetworkCommand route, found 0',
    '(network runtime): expected one narrowed networkDump call, found 0',
  ]);
  assert.deepEqual(
    networkRuntimeRouteViolations([
      {
        path: 'src/daemon/planted.ts',
        source: `
          handleNetworkCommand(first);
          handleNetworkCommand(second);
          runtime.operations.networkDump(input);
          fallback.operations.networkDump(input);
        `,
      },
    ]),
    [
      '(network runtime): expected one handleNetworkCommand route, found 2',
      '(network runtime): expected one narrowed networkDump call, found 2',
    ],
  );
});
