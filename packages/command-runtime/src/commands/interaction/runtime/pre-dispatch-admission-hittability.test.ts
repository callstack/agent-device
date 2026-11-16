import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, TargetHittability } from '@agent-device/contracts/backend';
import type { Point, SnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { createAgentDevice } from '../../../runtime.ts';
import { createMemorySessionStore } from '../../../command-runtime/runtime-factory.ts';
import { ref } from './selector-read-utils.ts';

// The pre-dispatch hittability check on the press route: which targets pay for the native read, and
// what each verdict does. The pure gate and the verdict mapping have their own tests beside them.

function node(
  index: number,
  type: string,
  label: string,
  rect: SnapshotNode['rect'],
): SnapshotNode {
  return { index, depth: 1, parentIndex: 0, type, label, rect, hittable: true };
}

const TREE = makeSnapshotState([
  node(0, 'Application', 'App', { x: 0, y: 0, width: 402, height: 874 }),
  node(1, 'Button', 'Delete Avocado', { x: 294, y: 425, width: 88, height: 82 }),
  node(2, 'Cell', 'Avocado, 3 item, $4.50', { x: 20, y: 425, width: 362, height: 82 }),
  node(3, 'Button', 'Add item', { x: 20, y: 610, width: 362, height: 52 }),
]);

function createPressDevice(verdict: TargetHittability | (() => Promise<TargetHittability>)) {
  const probes: string[] = [];
  const taps: Point[] = [];
  const backend: AgentDeviceBackend = {
    platform: 'ios',
    captureSnapshot: async () => ({ snapshot: TREE }),
    probeTargetHittability: async (_context, probed) => {
      probes.push(probed.label ?? '');
      return typeof verdict === 'function' ? await verdict() : verdict;
    },
    tap: async (_context, point) => {
      taps.push(point);
      return { ok: true };
    },
  };
  const device = createAgentDevice({
    backend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: TREE }]),
    policy: localCommandPolicy(),
  });
  return { device, probes, taps };
}

function refOf(label: string) {
  const found = TREE.nodes.find((candidate) => candidate.label === label)!;
  return ref(`@${found.ref}`);
}

test('a press on a control the platform reports not hittable is refused before any tap', async () => {
  const { device, probes, taps } = createPressDevice('notHittable');

  await assert.rejects(device.interactions.press(refOf('Delete Avocado')), (error: unknown) => {
    const { message, details } = error as { message: string; details?: Record<string, unknown> };
    assert.equal(message, '"Delete Avocado" is not hittable: a tap would land on another element.');
    assert.equal(details?.reason, INTERACTION_ERROR_REASONS.targetNotHittable);
    assert.equal(details?.dispatched, 'no');
    assert.equal(details?.coveredBy, undefined, 'no occlusion evidence is claimed');
    assert.equal(
      details?.hint,
      'Reveal the control (for example swipe its row), then take a fresh snapshot -i.',
    );
    return true;
  });
  assert.deepEqual(probes, ['Delete Avocado']);
  assert.deepEqual(taps, []);
});

for (const verdict of ['hittable', 'unknown'] as const) {
  test(`a gated press the probe answers ${verdict} still taps`, async () => {
    const { device, probes, taps } = createPressDevice(verdict);

    await device.interactions.press(refOf('Delete Avocado'));

    assert.deepEqual(probes, ['Delete Avocado']);
    assert.equal(taps.length, 1);
  });
}

test('a top-level press pays for no probe even when the backend would refuse', async () => {
  const { device, probes, taps } = createPressDevice('notHittable');

  await device.interactions.press(refOf('Add item'));

  assert.deepEqual(probes, []);
  assert.equal(taps.length, 1);
});

test('a probe that rejects the request cancels before any tap', async () => {
  const controller = new AbortController();
  const { device, taps } = createPressDevice(async () => {
    controller.abort();
    return 'hittable';
  });

  await assert.rejects(
    device.interactions.press(refOf('Delete Avocado'), { signal: controller.signal }),
    (error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'request_canceled');
      assert.equal(details?.dispatched, 'no');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test('the Maestro replay fallback keeps the hittability read out of a gated press', async () => {
  const { device, probes, taps } = createPressDevice('notHittable');

  await device.interactions.press(refOf('Delete Avocado'), {
    allowNonHittableCoordinateFallback: true,
  });

  assert.deepEqual(probes, []);
  assert.equal(taps.length, 1);
});
