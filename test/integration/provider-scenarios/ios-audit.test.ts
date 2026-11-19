import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import type { ProviderScenarioRpcResult } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from './providers.ts';
import { createProviderTranscript, type ProviderScenarioProviderEntry } from './transcript.ts';

const APP = 'com.example.app';
const DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

const SCREEN = {
  index: 0,
  type: 'Application',
  label: 'Example',
  rect: { x: 0, y: 0, width: 400, height: 800 },
};

const FINDING_NODES = [
  SCREEN,
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Menu',
    hittable: true,
    rect: { x: 10, y: 60, width: 30, height: 30 },
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Button',
    hittable: true,
    rect: { x: 100, y: 200, width: 200, height: 44 },
  },
  {
    index: 3,
    parentIndex: 0,
    type: 'Image',
    hittable: true,
    rect: { x: 20, y: 300, width: 20, height: 20 },
  },
  {
    index: 4,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: 100, y: 400, width: 200, height: 44 },
  },
];

// The same screen with every finding resolved: no small target, every control named, and no two
// controls of one role sharing a name.
const CLEAN_NODES = [
  SCREEN,
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Menu',
    hittable: true,
    rect: { x: 10, y: 60, width: 60, height: 60 },
  },
  ...FINDING_NODES.slice(2).map((node, position) => ({
    ...node,
    ...(node.type === 'Button' ? { label: `Continue ${position}` } : {}),
  })),
];

function snapshotEntry(nodes: unknown[]): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { nodes, truncated: false },
  };
}

const TAP_ENTRY: ProviderScenarioProviderEntry = {
  command: 'ios.runner.tap',
  deviceId: DEVICE_ID,
  platform: 'apple',
  result: {},
};

function refusalReason(response: ProviderScenarioRpcResult): unknown {
  const data = response.json?.error?.data as { details?: { reason?: unknown } } | undefined;
  return data?.details?.reason;
}

async function withAuditScenario(
  entries: ProviderScenarioProviderEntry[],
  run: (
    daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
    tapRequests: () => Array<{ x?: number; y?: number }>,
  ) => Promise<void>,
): Promise<void> {
  const runnerTranscript = createProviderTranscript(entries);
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: PROVIDER_SCENARIO_IOS_SIMULATOR.name, udid: DEVICE_ID },
    ]),
  });
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () =>
          createAppleRunnerProviderFromTranscript(runnerTranscript, 'ios.runner'),
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      }),
    async (daemon) => {
      assertRpcOk(await daemon.callCommand('open', [APP], { platform: 'ios', udid: DEVICE_ID }));
      await run(daemon, () =>
        runnerTranscript.calls
          .filter((call) => call.command === 'ios.runner.tap')
          .map((call) => call.request as { x?: number; y?: number }),
      );
    },
  );
}

test('Provider-backed integration audit publishes pinned finding refs and keeps stale plain refs refused', async () => {
  await withAuditScenario(
    [
      // The first capture after open settles over a quiet pair of reads of the same screen.
      snapshotEntry(FINDING_NODES),
      snapshotEntry(FINDING_NODES),
      TAP_ENTRY,
      snapshotEntry(FINDING_NODES),
      TAP_ENTRY,
    ],
    async (daemon, tapRequests) => {
      assertRpcOk(await daemon.callCommand('snapshot'));
      // The press expires the complete frame the snapshot issued.
      assertRpcOk(await daemon.callCommand('press', ['@e4']));

      const audit = assertRpcOk(await daemon.callCommand('audit'));
      const findings = audit.findings as Array<{ kind: string; ref: string }>;
      assert.deepEqual(
        findings.map(({ kind, ref }) => [kind, ref]),
        [
          ['small-target', '@e2'],
          ['missing-name', '@e3'],
        ],
      );
      const generation = audit.refsGeneration;
      assert.equal(typeof generation, 'number');

      // Audit publishes a partial frame: a plain finding ref and a ref it never listed stay refused.
      assert.equal(
        refusalReason(await daemon.callCommand('press', ['@e2'])),
        'plain_ref_requires_complete_frame',
      );
      assert.equal(
        refusalReason(await daemon.callCommand('press', [`@e4~s${generation}`])),
        'ref_not_issued',
      );

      // The pinned finding ref presses the Menu button, the node the finding names.
      assertRpcOk(await daemon.callCommand('press', [`@e2~s${generation}`]));
      const taps = tapRequests();
      assert.equal(taps.length, 2);
      assert.deepEqual([taps[1]?.x, taps[1]?.y], [25, 75]);
    },
  );
});

test('Provider-backed integration an audit without findings leaves an expired frame expired', async () => {
  await withAuditScenario(
    [
      snapshotEntry(FINDING_NODES),
      snapshotEntry(FINDING_NODES),
      TAP_ENTRY,
      snapshotEntry(CLEAN_NODES),
    ],
    async (daemon) => {
      assertRpcOk(await daemon.callCommand('snapshot'));
      assertRpcOk(await daemon.callCommand('press', ['@e4']));

      const audit = assertRpcOk(await daemon.callCommand('audit'));
      assert.deepEqual(audit.findings, []);
      assert.equal(audit.refsGeneration, undefined);

      // A plain ref remembered from the snapshot is still refused: the audit issued nothing.
      assert.equal(refusalReason(await daemon.callCommand('press', ['@e2'])), 'ref_frame_expired');
    },
  );
});
