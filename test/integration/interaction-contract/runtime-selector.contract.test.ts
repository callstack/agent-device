import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import type { Point } from '../../../src/kernel/snapshot.ts';
import { selector } from '../../../src/commands/index.ts';
import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName, scenarioNames } from './coverage-manifest.ts';
import { RUNTIME_SELECTOR_COVERAGE } from './runtime-selector.coverage.ts';
import {
  closedDrawerSnapshot,
  continueButtonSnapshot,
  coveredButtonSnapshot,
  drawerWithVisibleTwinSnapshot,
  edgeGrazingDrawerSnapshot,
  nonHittableButtonSnapshot,
  RUNNER_CONTINUE_NODES,
} from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';
import { runnerSnapshotEntry, runnerTapEntry, withIosContractDaemon } from './daemon-harness.ts';

// ADR 0011 Layer 3, runtime-selector path: daemon tree capture, selector
// chain resolution, guarded coordinate tap. One behavior assertion per
// claimed matrix cell — the deep rule semantics stay in the unit suites.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(RUNTIME_SELECTOR_COVERAGE, guarantee);

test(scenario('disambiguation'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(drawerWithVisibleTwinSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.click(selector('label=Profile'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.ref, 'e2');
  assert.deepEqual(taps, [{ x: 120, y: 765 }]);
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'offscreen')[0]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(closedDrawerSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Explore'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /off-screen element and is not safe to press/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_selector');
      assert.ok(typeof details?.hint === 'string');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'offscreen')[1]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(edgeGrazingDrawerSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Explore'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_selector');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenario('occlusion'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(coveredButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(selector('label="Save draft"'), { session: 'default' }),
    /covered by another visible element/,
  );
  assert.deepEqual(taps, []);
});

test(scenario('nonHittable'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(nonHittableButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(taps.length, 1);
  assert.equal(result.kind, 'selector');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
});

test(scenario('verifyEvidence'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'selector');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, false);
  assert.ok(result.evidence?.digest.startsWith('ax1:'));
});

test(scenario('errorTaxonomy'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Missing'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Selector did not match/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.match(String(details?.hint), /snapshot -i/);
      return true;
    },
  );
});

test(scenario('responseIdentity'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label=Continue' });
  assert.equal(result.node?.label, 'Continue');
  assert.ok(Array.isArray(result.selectorChain) && result.selectorChain.length > 0);
});

test(scenario('responseConstruction'), async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTapEntry({ x: 200, y: 322 })],
    async (daemon) => {
      const press = await daemon.callCommand('press', ['label=Continue']);
      const data = assertRpcOk(press);
      // Canonical selector response set from the shared construction site.
      assert.equal(data.x, 200);
      assert.equal(data.y, 322);
      assert.equal(data.selector, 'label=Continue');
      assert.ok(Array.isArray(data.selectorChain));
    },
  );
});
