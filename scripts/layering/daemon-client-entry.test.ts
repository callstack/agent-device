import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDaemonClientEntry,
  CLI_PROCESS_ENTRIES,
  DAEMON_CLIENT_ENTRY_RULE,
} from './daemon-client-entry.ts';
import { resolveImportEdges } from './model.ts';

const DAEMON_MODULE = 'packages/daemon/src/server/platform-request-scope.ts';

/** The CLI entries and a daemon module exist as stubs, so a case fails only on what it plants. */
function check(sources: Record<string, string>) {
  const tree = new Map<string, string>([
    ...CLI_PROCESS_ENTRIES.map((entry) => [entry, 'export {};\n'] as const),
    [DAEMON_MODULE, 'export const scope = 1;\n'],
    ...Object.entries(sources),
  ]);
  return checkDaemonClientEntry([...tree.keys()], resolveImportEdges(tree));
}

test('a daemon import from a module the CLI never reaches is not CLI reach', () => {
  assert.deepEqual(check({ 'src/daemon-composition.ts': `import '../${DAEMON_MODULE}';\n` }), []);
});

test('a root module the CLI lazy-loads cannot launder a daemon import', () => {
  const violations = check({
    'src/cli.ts': "export const run = () => import('./cli/commands/device.ts');\n",
    'src/cli/commands/device.ts':
      "export const release = () => import('../../platform-runtime-claim-recovery.ts');\n",
    'src/platform-runtime-claim-recovery.ts': `import '../${DAEMON_MODULE}';\n`,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, DAEMON_CLIENT_ENTRY_RULE);
  assert.equal(violations[0]!.file, 'src/platform-runtime-claim-recovery.ts');
  assert.ok(
    violations[0]!.message.includes(
      `Chain: src/cli.ts -> src/cli/commands/device.ts -> src/platform-runtime-claim-recovery.ts -> ${DAEMON_MODULE}.`,
    ),
    violations[0]!.message,
  );
});

test('a daemon import inside a client-side root is left to the client-side policy', () => {
  assert.deepEqual(check({ 'src/cli.ts': `import '../${DAEMON_MODULE}';\n` }), []);
});

test('a type-only import by a reached root module is not a load', () => {
  assert.deepEqual(
    check({
      'src/cli.ts': "import './platform-runtime-types.ts';\n",
      'src/platform-runtime-types.ts': `import type { scope } from '../${DAEMON_MODULE}';\n`,
    }),
    [],
  );
});

test('a missing CLI entry fails as stale instead of passing silently', () => {
  const violations = checkDaemonClientEntry(['src/cli.ts'], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /stale module: src\/bin\.ts/);
});
