import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges } from './model.ts';
import {
  checkDaemonProcessReach,
  DAEMON_PROCESS_DENIED_MODULES,
  DAEMON_PROCESS_REACH_RULE,
} from './daemon-process-reach.ts';

const COLLECTOR = 'packages/replay-port/src/source-discovery.ts';

/** Every denied module exists as a stub, so a case fails only on what it plants. */
function reach(sources: Record<string, string>) {
  const tree = new Map<string, string>([
    ...DAEMON_PROCESS_DENIED_MODULES.map(
      (module) => [module, 'export const collect = 1;\n'] as const,
    ),
    ...Object.entries(sources),
  ]);
  return checkDaemonProcessReach([...tree.keys()], resolveImportEdges(tree));
}

test('the denied set names replay-port caller-side collector modules', () => {
  // Pinned independently so deleting an entry fails here instead of silently shrinking the rule.
  assert.deepEqual([...DAEMON_PROCESS_DENIED_MODULES].sort(), [
    'packages/replay-port/src/script-source-bundle.ts',
    'packages/replay-port/src/source-discovery.ts',
  ]);
});

for (const denied of DAEMON_PROCESS_DENIED_MODULES) {
  test(`a root platform-runtime module behind a dynamic import cannot reach ${denied}`, () => {
    const found = reach({
      'src/daemon.ts': "export const load = () => import('./daemon-composition.ts');\n",
      'src/daemon-composition.ts': "import './platform-runtime-daemon-services.ts';\n",
      'src/platform-runtime-daemon-services.ts': `import '../${denied}';\n`,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.rule, DAEMON_PROCESS_REACH_RULE);
    assert.equal(found[0]!.file, 'src/platform-runtime-daemon-services.ts');
    assert.ok(
      found[0]!.message.includes(
        `Chain: src/daemon.ts -> src/daemon-composition.ts -> src/platform-runtime-daemon-services.ts -> ${denied}.`,
      ),
      found[0]!.message,
    );
  });

  test(`a static-only chain from the entry cannot reach ${denied}`, () => {
    const found = reach({
      'src/daemon.ts': "import './daemon-server.ts';\n",
      'src/daemon-server.ts': `import '../${denied}';\n`,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.file, 'src/daemon-server.ts');
    assert.equal(found[0]!.line, 1);
    assert.ok(
      found[0]!.message.includes(`Chain: src/daemon.ts -> src/daemon-server.ts -> ${denied}.`),
      found[0]!.message,
    );
  });
}

test('a type-only edge loads nothing, and the client may import the collector', () => {
  assert.deepEqual(
    reach({
      'src/daemon.ts':
        "import type { Collect } from '../packages/replay-port/src/source-discovery.ts';\n",
      'src/commands/replay/index.ts':
        "import '../../../packages/replay-port/src/source-discovery.ts';\n",
      [COLLECTOR]: 'export type Collect = () => [];\n',
    }),
    [],
  );
});

test('a renamed entry or denied module fails as stale instead of passing silently', () => {
  const found = checkDaemonProcessReach(
    ['src/daemon.ts', 'packages/replay-port/src/script-source-bundle.ts'],
    [],
  );
  assert.deepEqual(
    found.map((violation) => violation.message.split(' is not')[0]),
    [`stale module: ${COLLECTOR}`],
  );
  assert.equal(found[0]!.rule, DAEMON_PROCESS_REACH_RULE);
  assert.equal(checkDaemonProcessReach([COLLECTOR], [], 'src/daemon.ts', [COLLECTOR]).length, 1);
});
