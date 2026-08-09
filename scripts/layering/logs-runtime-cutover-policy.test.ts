import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  logsLegacyRouteViolations,
  logsRuntimeNarrowingViolations,
  logsSessionStateOwnershipViolations,
  sourceExecutedUsingDeclarationViolations,
} from './logs-runtime-cutover-policy.ts';

test('legacy logs scan catches a planted provider route and plugin facet', () => {
  assert.deepEqual(
    logsLegacyRouteViolations([
      {
        path: 'src/daemon/planted.ts',
        source: 'await withAppLogProvider(provider, task); await startAppLog(request);',
      },
      {
        path: 'src/platforms/planted/plugin.ts',
        source: 'export const plugin = { appLog: { resolveBackend() {} } };',
      },
    ]),
    [
      'src/daemon/planted.ts: legacy logs route withAppLogProvider',
      'src/daemon/planted.ts: legacy logs route startAppLog',
      'src/platforms/planted/plugin.ts: legacy PlatformPlugin appLog facet',
    ],
  );
});

test('legacy logs scan ignores retired names in comments and string data', () => {
  assert.deepEqual(
    logsLegacyRouteViolations([
      {
        path: 'src/daemon/planted.ts',
        source: `
          // AppLogProvider and startAppLog were removed.
          const migrationNote = 'withAppLogProvider and requireCommandSupported("logs")';
          const metadata = { note: 'appLogProvider' };
        `,
      },
      {
        path: 'src/platforms/apple/plugin.ts',
        source: `const note = 'PUBLIC_COMMANDS.logs';`,
      },
    ]),
    [],
  );
});

test('legacy logs scan retains type-import and computed executable route coverage', () => {
  assert.deepEqual(
    logsLegacyRouteViolations([
      {
        path: 'src/daemon/planted.ts',
        source: `
          import type { AppLogProvider as LegacyProvider } from './old-app-log.ts';
          const route = handlers['startAppLog'];
        `,
      },
    ]),
    [
      'src/daemon/planted.ts: legacy logs route AppLogProvider',
      'src/daemon/planted.ts: legacy logs route startAppLog',
    ],
  );
});

test('legacy logs scan catches planted capability and dual-admission routes', () => {
  const violations = logsLegacyRouteViolations([
    {
      path: 'src/core/command-descriptor/registry.ts',
      source: `
        const registry = [
          { name: 'logs', capability: { apple: {} }, platformExecution: runtime },
          { name: 'events', capability: { apple: {} } },
        ];
      `,
    },
    {
      path: 'src/daemon/handlers/planted.ts',
      source: `const unsupported = requireCommandSupported('logs', device);`,
    },
    {
      path: 'src/platforms/apple/plugin.ts',
      source: `const supports = { [PUBLIC_COMMANDS.logs]: supportsCoreDevice };`,
    },
    {
      path: 'src/core/capabilities.ts',
      source: `const HARMONYOS_SUPPORTED_COMMANDS = new Set(['open', 'logs']);`,
    },
  ]);

  assert.deepEqual(violations, [
    'src/core/command-descriptor/registry.ts: logs descriptor retains legacy capability admission',
    'src/daemon/handlers/planted.ts: legacy logs capability admission requireCommandSupported',
    'src/platforms/apple/plugin.ts: Apple plugin retains legacy logs support or hint closure',
    'src/core/capabilities.ts: HarmonyOS static command set retains logs admission',
  ]);
});

test('narrowing scan catches planted assertions, non-null repair, and bracket access', () => {
  const violations = logsRuntimeNarrowingViolations([
    {
      path: 'src/daemon/handlers/planted.ts',
      source: `
        const widened = runtime as BoundDeviceRuntime<typeof use>;
        widened.operations.appLogStart!({});
        widened.operations['appLogDoctor']({});
      `,
    },
  ]);

  assert.equal(violations.length, 3);
  assert.match(violations.join('\n'), /BoundDeviceRuntime/);
  assert.match(violations.join('\n'), /appLogStart!/);
  assert.match(violations.join('\n'), /appLogDoctor/);
});

test('session state scan catches planted app-log record construction outside its owner', () => {
  assert.deepEqual(
    logsSessionStateOwnershipViolations([
      {
        path: 'src/daemon/handlers/planted.ts',
        source: `sessionStore.set(name, { ...session, appLog: resource, appLogFailure: undefined });`,
      },
      {
        path: 'src/daemon/request-platform-providers.ts',
        source: `
          type Scope = { appLog: { provider?: AppLogProvider } };
          const scope = { appLog: { provider } };
        `,
      },
      {
        path: 'src/daemon/app-log-session-resource.ts',
        source: `sessionStore.set(name, { ...session, appLog: resource });`,
      },
    ]),
    [
      'src/daemon/handlers/planted.ts: session appLog record constructed outside its owner',
      'src/daemon/handlers/planted.ts: session appLogFailure record constructed outside its owner',
      'src/daemon/request-platform-providers.ts: session appLog record constructed outside its owner',
    ],
  );
});

test('source-executed syntax scan rejects using declarations but ignores prose', () => {
  assert.deepEqual(
    sourceExecutedUsingDeclarationViolations([
      {
        path: 'packages/platform-apple/src/logs/planted.ts',
        source: `
          // await using oldHandle = acquire();
          const migrationNote = 'using replacement = acquire()';
          async function run() { await using handle = acquire(); }
          function runSync() { using cleanup = acquireSync(); }
        `,
      },
    ]),
    [
      'packages/platform-apple/src/logs/planted.ts: source-executed TypeScript uses unsupported await using declaration',
      'packages/platform-apple/src/logs/planted.ts: source-executed TypeScript uses unsupported using declaration',
    ],
  );
});
