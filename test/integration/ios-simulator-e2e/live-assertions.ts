import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  assertFilesDiffer,
  assertJsonContains,
  assertMp4File,
  assertNonEmptyFile,
  createLiveDeviceAssertions,
} from '../live-device-e2e/assertions.ts';
import type { CliJsonResult } from '../cli-json.ts';
import type { IosSimulatorBehaviorId } from './behavior-coverage.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

export { assertFilesDiffer, assertJsonContains, assertMp4File, assertNonEmptyFile };

export const { assertElementText, assertWaitSelector, assertWaitText, capturePng } =
  createLiveDeviceAssertions<IosSimulatorBehaviorId, LiveContext>(
    runStep,
    verifyCommand,
    PUBLIC_COMMANDS.wait,
  );

export type LiveSnapshotNode = {
  depth?: unknown;
  hittable?: unknown;
  identifier?: unknown;
  index?: unknown;
  label?: unknown;
  parentIndex?: unknown;
  type?: unknown;
};

export function snapshotNodes(result: { json?: any }): LiveSnapshotNode[] {
  const nodes = result.json?.data?.nodes;
  assert.ok(
    Array.isArray(nodes),
    `snapshot response did not contain nodes: ${JSON.stringify(result)}`,
  );
  return nodes as LiveSnapshotNode[];
}

/**
 * Three forward scrolls reach 2.25 viewports of finger travel. The reverse steps are shorter: a
 * controlled iOS scroll can still carry post-release inertia under host load (ADR 0013), so a
 * forward step can carry a short target past the viewport, and a reverse step plus that inertia
 * must stay inside one viewport so the reverse sweep cannot skip it again.
 */
const FORWARD = { direction: 'down', amount: '0.75' } as const;
const REVERSE = { direction: 'up', amount: '0.5' } as const;
const SCROLL_SEARCH_PLAN = [FORWARD, FORWARD, FORWARD, REVERSE, REVERSE, REVERSE];
// A stalled capture, or one taken while the last scroll was still moving, says nothing about where
// the element is, so re-reading it must not consume a scroll. A couple of re-reads per scroll absorb
// a slow runner without masking a real absence.
const SCROLL_SEARCH_REREADS = 2;
const SETTLE_MS = '1000';

export type ScrollSearchStep = (typeof SCROLL_SEARCH_PLAN)[number];

export type ScrollSearchDevice = {
  probeVisibility: (probe: number) => Promise<CliJsonResult>;
  /** Gives a surface that was still moving a bounded pause before the next read. */
  settle: () => Promise<void>;
  scroll: (step: ScrollSearchStep, index: number) => Promise<unknown>;
};

export async function assertElementTextAfterScrolling(
  context: LiveContext,
  selector: string,
  expected: string,
): Promise<void> {
  await searchForVisibleElement(selector, {
    probeVisibility: (probe) =>
      runStep(
        context,
        `check ${selector} visibility (probe ${probe})`,
        ['is', 'visible', selector],
        { allowFailure: true },
      ),
    settle: async () => {
      await runStep(context, `settle before re-reading ${selector}`, ['wait', SETTLE_MS]);
    },
    scroll: (step, index) =>
      runStep(context, `scroll ${step.direction} toward ${selector} (scroll ${index})`, [
        'scroll',
        step.direction,
        step.amount,
      ]).then((result) => result.json?.data),
  });
  await assertElementText(context, selector, expected);
}

/**
 * Searches by semantic visibility rather than selector existence. An offscreen node can exist in
 * the accessibility tree, so a successful `wait <selector>` is not sufficient evidence to skip
 * scrolling. The callbacks keep this live-device policy deterministic and unit-testable without a
 * simulator.
 */
export async function searchForVisibleElement(
  selector: string,
  device: ScrollSearchDevice,
): Promise<void> {
  const history: string[] = [];
  let probes = 0;
  const readWindow = async (): Promise<boolean> => {
    for (let rereads = 0; ; rereads += 1) {
      probes += 1;
      const result = await device.probeVisibility(probes);
      history.push(`probe ${probes}: ${JSON.stringify(result.json ?? { status: result.status })}`);
      if (result.status === 0) return true;
      const unread = unreadSurface(result);
      if (unread === undefined || rereads === SCROLL_SEARCH_REREADS) return false;
      if (unread === 'moving') {
        await device.settle();
        history.push(`settled for ${SETTLE_MS} ms`);
      }
    }
  };

  for (const [index, step] of SCROLL_SEARCH_PLAN.entries()) {
    if (await readWindow()) return;
    const scrolled = await device.scroll(step, index + 1);
    history.push(`scroll ${step.direction} ${index + 1}: ${JSON.stringify(scrolled ?? null)}`);
  }
  if (await readWindow()) return;
  assert.fail(`${selector} did not become visible after scrolling\n${history.join('\n')}`);
}

/** Why a missed probe says nothing about where the element is, if it says nothing. */
function unreadSurface(result: CliJsonResult): 'moving' | 'stalled' | undefined {
  const details = result.json?.error?.details;
  if (details?.postGestureOutcome?.kind === 'unsettled') return 'moving';
  return details?.captureStalled === true ? 'stalled' : undefined;
}

function requireNode(
  result: CliJsonResult,
  identifier: string,
): { label?: unknown; rect?: { height: number; width: number; x: number; y: number } } {
  const nodes = Array.isArray(result.json?.data?.nodes) ? result.json.data.nodes : [];
  const node = nodes.find(
    (candidate: { identifier?: unknown }) => candidate.identifier === identifier,
  );
  assert.ok(node, `snapshot missing ${identifier}: ${JSON.stringify(result.json)}`);
  return node;
}

export function requireNodeRect(
  result: CliJsonResult,
  identifier: string,
): { height: number; width: number; x: number; y: number } {
  const rect = requireNode(result, identifier).rect;
  assert.ok(rect, `snapshot node ${identifier} has no rect: ${JSON.stringify(result.json)}`);
  for (const value of [rect.x, rect.y, rect.width, rect.height]) {
    assert.ok(Number.isFinite(value), `snapshot node ${identifier} has invalid rect`);
  }
  return rect;
}

export function requireDevice(result: CliJsonResult, udid: string): { booted?: unknown } {
  const devices = Array.isArray(result.json?.data?.devices) ? result.json.data.devices : [];
  const device = devices.find((candidate: { id?: unknown }) => candidate.id === udid);
  assert.ok(device, `device inventory missing ${udid}: ${JSON.stringify(result.json)}`);
  return device;
}
