import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '@agent-device/contracts/interaction-guarantees';
import { keyboardCoveredTabBarSnapshot } from '@agent-device/test-kit';
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
  scenario('responseConstruction'),
  async () => {
    await withIosContractDaemon(
      [runnerSnapshotEntry(KEYBOARD_TREE), runnerTapEntry({})],
      async (daemon) => {
        const data = assertRpcOk(await daemon.callCommand('find', ['label', 'space', 'focus']));
        // The focus runtime's own payload: the point it dispatched plus its success text, with nothing
        // hand-rolled on top — and no `refsGeneration`, which is what would make the ref pinnable
        // (ADR 0014).
        assert.equal(data.message, 'Focused (202, 779)');
        assert.equal(data.refsGeneration, undefined);
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  scenario('errorTaxonomy'),
  async () => {
    await withIosContractDaemon([runnerSnapshotEntry(KEYBOARD_TREE)], async (daemon) => {
      assertRpcError(
        await daemon.callCommand('find', ['label', 'Nowhere', 'focus']),
        500,
        'COMMAND_FAILED',
        /find did not match any element/,
      );
    });
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

/** The wire's error envelope keeps the typed refusal details one level below its code and hint. */
function readErrorDetails(error: Record<string, unknown>): Record<string, unknown> {
  const details = error.details;
  assert.ok(details && typeof details === 'object', 'the error carries typed details');
  return details as Record<string, unknown>;
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
