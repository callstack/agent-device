import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges } from './model.ts';
import {
  checkDaemonProcessReach,
  DAEMON_PROCESS_DENIED_MODULES,
  DAEMON_PROCESS_REACH_RULE,
} from './daemon-process-reach.ts';

const COLLECTOR = 'packages/replay-port/src/source-discovery.ts';

function reach(sources: Record<string, string>) {
  return checkDaemonProcessReach(resolveImportEdges(new Map(Object.entries(sources))));
}

test('the denied set names replay-port caller-side collector modules', () => {
  // Pinned independently so deleting an entry fails here instead of silently shrinking the rule.
  assert.deepEqual([...DAEMON_PROCESS_DENIED_MODULES].sort(), [
    'packages/replay-port/src/script-source-bundle.ts',
    'packages/replay-port/src/source-discovery.ts',
  ]);
});

test('a root platform-runtime module behind a dynamic import cannot reach the collector', () => {
  const found = reach({
    'src/daemon.ts': "export const load = () => import('./daemon-composition.ts');\n",
    'src/daemon-composition.ts': "import './platform-runtime-daemon-services.ts';\n",
    'src/platform-runtime-daemon-services.ts':
      "import '../packages/replay-port/src/source-discovery.ts';\n",
    [COLLECTOR]: 'export const collect = () => [];\n',
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PROCESS_REACH_RULE);
  assert.equal(found[0]!.file, 'src/platform-runtime-daemon-services.ts');
  assert.match(
    found[0]!.message,
    /src\/daemon\.ts -> src\/daemon-composition\.ts -> src\/platform-runtime-daemon-services\.ts -> packages\/replay-port\/src\/source-discovery\.ts/,
  );
});

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
