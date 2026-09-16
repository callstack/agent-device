import { expect, test } from 'vitest';
import { executeMaestroFlow, inspectMaestroFlow } from '@agent-device/maestro';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import {
  makeRuntimeEnvelope,
  makeDependencies,
  makeSnapshot,
  noMaestroIncludeSources,
} from './daemon-runtime-port-fixtures.ts';

const ON_SCREEN = { x: 18, y: 62, width: 366, height: 144 };
const BELOW_VIEWPORT = { x: 18, y: 2000, width: 366, height: 144 };

// React Native keeps a `testID` wrapper's text beside it instead of inside it, so the wrapper
// reaches the fold childless with nothing to delegate its identifier to. Whether that is fatal then
// depends on the wrapper's own declared hittability: the Apple runner answers for every node and
// the Simulator AX bridge answers for none, and #2638 is the flow that passed on one producer and
// failed on the other.
function hookCapture(
  rect: typeof ON_SCREEN,
  hittable: boolean | undefined,
): Array<Omit<SnapshotNode, 'ref'>> {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'members.count',
      rect,
      ...(hittable === undefined ? {} : { hittable }),
    },
  ];
}

async function replay(
  assertion: 'assertVisible' | 'assertNotVisible',
  hittable: boolean | undefined,
  rect: typeof ON_SCREEN,
) {
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) =>
      request.command === 'snapshot'
        ? { ok: true, data: makeSnapshot(hookCapture(rect, hittable)) }
        : { ok: true, data: {} },
    dependencies: makeDependencies(),
    platform: 'ios',
  });
  const flow = inspectMaestroFlow(
    ['appId: com.example.app', '---', `- ${assertion}:`, '    id: members.count'].join('\n'),
    '/flows/identifier-hook.yaml',
  );
  return await executeMaestroFlow(flow, port, { readSource: noMaestroIncludeSources });
}

test('resolves an on-screen identifier hook whose capture reported no hittability', async () => {
  expect(await replay('assertVisible', undefined, ON_SCREEN)).toMatchObject({
    ok: true,
    replayed: 1,
  });
});

test('keeps a declared non-hittable identifier hook out of the visible set', async () => {
  expect(await replay('assertNotVisible', false, ON_SCREEN)).toMatchObject({
    ok: true,
    replayed: 1,
  });
});

test('does not report a kept identifier hook as visible past the viewport', async () => {
  expect(await replay('assertNotVisible', undefined, BELOW_VIEWPORT)).toMatchObject({
    ok: true,
    replayed: 1,
  });
});
