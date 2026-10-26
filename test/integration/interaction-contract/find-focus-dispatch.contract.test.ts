import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '@agent-device/contracts/interaction-guarantees';
import { KEYBOARD_COVERED_BAND_RECT, keyboardCoveredTabBarSnapshot } from '@agent-device/test-kit';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from '../provider-scenarios/test-timeouts.ts';
import { scenarioName, scenarioNames } from './coverage-manifest.ts';
import { FIND_FOCUS_DISPATCH_COVERAGE } from './find-focus-dispatch.coverage.ts';
import { runnerSnapshotEntry, runnerTapEntry, withIosContractDaemon } from './daemon-harness.ts';

// ADR 0011 Layer 3, find-focus-dispatch path: mutating `find <locator> focus` and the focus leg of
// `find <locator> type`. These run over the daemon harness because the seam lives in the daemon's
// find handler — it captures its own tree and dispatches the point itself, so no in-process device
// harness can reach it. The transcript is the proof: a refusal that dispatched anyway would either
// consume an unscripted tap entry or leave a scripted one behind.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(FIND_FOCUS_DISPATCH_COVERAGE, guarantee);

const KEYBOARD_TREE = keyboardCoveredTabBarSnapshot().nodes;

test(
  scenario('keyboardOcclusion'),
  async () => {
    // One scripted capture and no tap entry: `assertComplete` is what proves the refusal stopped the
    // dispatch, which is #2622's whole point.
    await withIosContractDaemon([runnerSnapshotEntry(KEYBOARD_TREE)], async (daemon) => {
      const error = assertRpcError(
        await daemon.callCommand('find', ['label', 'Form', 'focus']),
        500,
        'COMMAND_FAILED',
        /Ref @e2 is behind the visible keyboard and cannot be focused safely/,
      );
      const details = readErrorDetails(error);
      assert.equal(details.reason, 'tap_keyboard_occludes_target');
      assert.equal(details.ref, '@e2');
      assert.deepEqual(details.rect, { x: 148, y: 791, width: 104, height: 83 });
      assert.deepEqual(details.keyboardFrame, { x: 0, y: 583, width: 402, height: 291 });
      assert.equal(details.dispatched, 'no');
    });
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenarioNames(FIND_FOCUS_DISPATCH_COVERAGE, 'keyboardOcclusion')[1]!,
  async () => {
    // The closest negative: the same tree with the app's button lifted above the band.
    const aboveBand = KEYBOARD_TREE.map((node) =>
      node.index === 1 ? { ...node, rect: { x: 148, y: 470, width: 104, height: 110 } } : node,
    );

    await withIosContractDaemon(
      [runnerSnapshotEntry(aboveBand), runnerTapEntry({})],
      async (daemon) => {
        const data = assertRpcOk(await daemon.callCommand('find', ['label', 'Form', 'focus']));
        assert.deepEqual({ x: data.x, y: data.y }, { x: 200, y: 525 });
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenarioNames(FIND_FOCUS_DISPATCH_COVERAGE, 'keyboardOcclusion')[2]!,
  async () => {
    // The producer's band, scripted onto the capture, over a tree the tree-derived rule refuses to
    // measure (the keys are hoisted off the docking edge, which is what the iOS runner's projected
    // tree reports when the band comes from the runner's own keyboard probe). So the only source of
    // the refusal below is `match.keyboard` reaching the guard — delete the seam's forwarding and
    // this scenario dispatches into a transcript with no tap entry, which `assertComplete` fails.
    const liftedTree = keyboardCoveredTabBarSnapshot({ keyboardLifted: true }).nodes;

    await withIosContractDaemon(
      [
        runnerSnapshotEntry(liftedTree, {
          keyboard: { kind: 'visible', frame: KEYBOARD_COVERED_BAND_RECT },
        }),
      ],
      async (daemon) => {
        const error = assertRpcError(
          await daemon.callCommand('find', ['label', 'Form', 'focus']),
          500,
          'COMMAND_FAILED',
          /Ref @e2 is behind the visible keyboard and cannot be focused safely/,
        );
        const details = readErrorDetails(error);
        assert.equal(details.reason, 'tap_keyboard_occludes_target');
        assert.deepEqual(details.keyboardFrame, KEYBOARD_COVERED_BAND_RECT);
        assert.equal(details.dispatched, 'no');
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenario('occlusion'),
  async () => {
    await withIosContractDaemon([runnerSnapshotEntry(coveredFormTree())], async (daemon) => {
      const error = assertRpcError(
        await daemon.callCommand('find', ['label', 'Form', 'focus']),
        500,
        'COMMAND_FAILED',
        /Matched element @e2 is covered by another visible element and cannot be focused safely/,
      );
      assert.equal(readErrorDetails(error).reason, 'target_covered');
    });
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenario('disambiguation'),
  async () => {
    await withIosContractDaemon(
      [
        runnerSnapshotEntry(twinFormTree()),
        runnerSnapshotEntry(twinFormTree()),
        runnerTapEntry({}),
      ],
      async (daemon) => {
        const ambiguous = assertRpcError(
          await daemon.callCommand('find', ['label', 'Form', 'focus']),
          500,
          'AMBIGUOUS_MATCH',
          /find matched 2 elements for label "Form"/,
        );
        assert.deepEqual(readErrorDetails(ambiguous).candidates, [
          '@e2 [button] "Form"',
          '@e3 [button] "Form"',
        ]);

        // --first is the only narrowing find offers, and the narrowed match goes through this seam.
        assertRpcOk(
          await daemon.callCommand('find', ['label', 'Form', 'focus'], { findFirst: true }),
        );
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  'find-focus-dispatch promotion: a non-hittable label retargets the dispatch to the hittable ancestor row',
  async () => {
    // Discriminating, not decorative: the label's own center is (140,195), the row's is (200,200).
    // Retargeting `findAct.promotion` away from `hittable-ancestor-below-root` dispatches at the
    // label and this fails. Title deliberately outside the coverage manifest: the promotion half runs
    // while the annotation half stays the `nonHittable` waiver's debt, and the gate forbids a
    // manifest entry on a waived cell.
    await withIosContractDaemon(
      [runnerSnapshotEntry(nonHittableRowTree()), runnerTapEntry({})],
      async (daemon) => {
        const data = assertRpcOk(
          await daemon.callCommand('find', ['label', 'Notifications', 'focus']),
        );
        assert.deepEqual({ x: data.x, y: data.y }, { x: 200, y: 200 });
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenario('responseConstruction'),
  async () => {
    await withIosContractDaemon(
      [runnerSnapshotEntry(KEYBOARD_TREE), runnerTapEntry({})],
      async (daemon) => {
        const data = assertRpcOk(await daemon.callCommand('find', ['label', 'space', 'focus']));
        // The focus runtime's own payload, exactly: the point it dispatched plus its success text,
        // nothing hand-rolled on top and nothing pinnable — no `ref`/`refsGeneration` half of an
        // identity (ADR 0014 keeps mutating find's ref diagnostic-only, and the deleted fallback
        // means there is no `data.ref` at all to pin).
        assert.equal(data.message, 'Focused (202, 779)');
        assert.deepEqual(Object.keys(data).sort(), ['message', 'x', 'y']);
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenario('errorTaxonomy'),
  async () => {
    // Both arms of this route's failure taxonomy, refusing on one transcript with no tap entry:
    // the ambiguous refusal produced by the builder the `errorTaxonomy` cell names, and the
    // no-match refusal. A candidate-disclosure or message change here fails this scenario, which
    // is the cell's own evidence rather than the `disambiguation` scenario's.
    await withIosContractDaemon(
      [runnerSnapshotEntry(twinFormTree()), runnerSnapshotEntry(KEYBOARD_TREE)],
      async (daemon) => {
        const ambiguous = assertRpcError(
          await daemon.callCommand('find', ['label', 'Form', 'focus']),
          500,
          'AMBIGUOUS_MATCH',
          /find matched 2 elements for label "Form"/,
        );
        assert.deepEqual(readErrorDetails(ambiguous).candidates, [
          '@e2 [button] "Form"',
          '@e3 [button] "Form"',
        ]);

        assertRpcError(
          await daemon.callCommand('find', ['label', 'Nowhere', 'focus']),
          500,
          'COMMAND_FAILED',
          /find did not match any element/,
        );
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  'find-focus-dispatch keyboardOcclusion forwarding: find click hands the same band to the acting leaf',
  async () => {
    // `find click`/`fill` are not this row's path — they pre-resolve the node to `runtime-ref` — but
    // `preresolvedTarget`'s forwarding carries this capture's band to the leaf's guard, and the
    // comment there claims "the band this capture measured, not one it re-derives". Over a lifted
    // tree the refusal below can only come from that forwarded fact.
    const liftedTree = keyboardCoveredTabBarSnapshot({ keyboardLifted: true }).nodes;

    await withIosContractDaemon(
      [
        runnerSnapshotEntry(liftedTree, {
          keyboard: { kind: 'visible', frame: KEYBOARD_COVERED_BAND_RECT },
        }),
      ],
      async (daemon) => {
        const error = assertRpcError(
          await daemon.callCommand('find', ['label', 'Form', 'click']),
          500,
          'COMMAND_FAILED',
          /Ref @e2 is behind the visible keyboard and cannot be tapped safely/,
        );
        const details = readErrorDetails(error);
        assert.equal(details.reason, 'tap_keyboard_occludes_target');
        assert.deepEqual(details.keyboardFrame, KEYBOARD_COVERED_BAND_RECT);
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

/** The wire's error envelope keeps the typed refusal details one level below its code and hint. */
function readErrorDetails(error: Record<string, unknown>): Record<string, unknown> {
  const details = error.details;
  assert.ok(details && typeof details === 'object', 'the error carries typed details');
  return details as Record<string, unknown>;
}

function nonHittableRowTree(): unknown[] {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Cell',
      rect: { x: 40, y: 160, width: 320, height: 80 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Notifications',
      rect: { x: 60, y: 180, width: 160, height: 30 },
      hittable: false,
    },
  ];
}

function coveredFormTree(): unknown[] {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'TabBar',
      rect: { x: 0, y: 760, width: 390, height: 84 },
      hittable: true,
    },
  ];
}

function twinFormTree(): unknown[] {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 40, y: 200, width: 120, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 240, y: 200, width: 120, height: 44 },
      hittable: true,
    },
  ];
}
