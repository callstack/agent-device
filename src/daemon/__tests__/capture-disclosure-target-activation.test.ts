import assert from 'node:assert/strict';
import { test } from 'vitest';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import type { IosTargetActivation } from '@agent-device/kernel/snapshot';
import { withCaptureDisclosures, withTargetActivationDisclosure } from '../capture-disclosure.ts';
import type { DaemonResponse } from '../daemon-request.ts';

const FACT: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

function okResponse(data: Record<string, unknown>): DaemonResponse {
  return { ok: true, data };
}

function dataOf(response: DaemonResponse): Record<string, unknown> {
  assert.ok(response.ok);
  assert.ok(response.data);
  return response.data;
}

test('a consumed repair is disclosed on the response without replacing earlier warnings', () => {
  const response = withTargetActivationDisclosure(
    okResponse({ warnings: ['Refs are stale'], targetActivation: undefined }),
    { targetActivation: FACT },
  );
  const data = dataOf(response);
  assert.deepEqual(data.warnings, ['Refs are stale', iosTargetActivationDisclosure(FACT)]);
  assert.deepEqual(data.targetActivation, FACT);
});

test('a capture that already disclosed the identical repair is not told twice', () => {
  const already = okResponse({ warnings: [iosTargetActivationDisclosure(FACT)] });
  const response = withTargetActivationDisclosure(already, { targetActivation: FACT });
  assert.deepEqual(dataOf(response).warnings, [iosTargetActivationDisclosure(FACT)]);
});

test('a failure response appends the repair to its hint and keeps the original details', () => {
  const response = withTargetActivationDisclosure(
    {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'selector missed',
        details: { blockedBy: 'android_foreground_surface' },
      },
    },
    { targetActivation: FACT },
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.message, 'selector missed');
  assert.equal(response.error.code, 'COMMAND_FAILED');
  assert.equal(response.error.details?.blockedBy, 'android_foreground_surface');
  assert.match(String(response.error.details?.hint), /prior state runningBackground/);
});

test('a capture with no repair leaves the response byte-identical', () => {
  const untouched = okResponse({ nodes: [], warnings: ['Refs are stale'] });
  const response = withTargetActivationDisclosure(untouched, { targetActivation: undefined });
  assert.deepEqual(response, untouched);
});

/**
 * A failure carries the sentence in `error.details.hint`. That carrier is exactly where a route could
 * cheaply borrow the previous command's repair off the stored snapshot and blame it on this request,
 * so the repair travels only on the request's own proof (#2682).
 */
test('a failure does not borrow a repair the stored snapshot happens to carry', () => {
  const failed: DaemonResponse = {
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'snapshot failed' } as never,
  };

  const response = withCaptureDisclosures({
    response: failed,
    consumedTree: { targetActivation: FACT },
    activationProof: {},
  });

  assert.equal(response, failed);
});

/**
 * The two carriers are pre-existing: the surface disclosure extends `data.warning`, the capture's
 * own warnings arrive as `data.warnings` (#2438 predates the array). A response can therefore carry
 * both, and each disclosure must survive in the carrier it belongs to.
 */
test('surface and foreground disclosures ride one response together', () => {
  const response = withCaptureDisclosures({
    response: okResponse({ nodes: [] }),
    consumedTree: {
      iosSystemSurfaceBundleId: 'com.apple.SafariViewService',
      targetActivation: FACT,
    },
    activationProof: { state: { targetActivation: FACT } },
  });
  const data = dataOf(response);
  assert.match(String(data.warning), /system web sign-in sheet/);
  assert.deepEqual(data.warnings, [iosTargetActivationDisclosure(FACT)]);
  assert.deepEqual(data.targetActivation, FACT);
});

/**
 * The nested case the gate exists for: a failing selector read inside a repairing interaction passes
 * through the wrapper twice, once in the selector route and once around it. The sentence belongs to
 * the response once, in whichever carrier that response uses (#2682).
 */
test('a repair that passes through two wrappers is named once in the failure hint', () => {
  const missed: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'no node matches label="nope"',
      details: { hint: 'Use snapshot to see the current tree.' },
    },
  };
  const proof = { state: { targetActivation: FACT } };

  const once = withCaptureDisclosures({
    response: missed,
    consumedTree: { targetActivation: FACT },
    activationProof: proof,
  });
  const twice = withCaptureDisclosures({
    response: once,
    consumedTree: { targetActivation: FACT },
    activationProof: proof,
  });

  assert.equal(twice.ok, false);
  if (twice.ok) return;
  const hint = String(twice.error.details?.hint);
  assert.equal(
    hint.split(iosTargetActivationDisclosure(FACT)).length - 1,
    1,
    `disclosure repeated in the hint: ${hint}`,
  );
  assert.match(hint, /Use snapshot to see the current tree\./);
});

/**
 * A capture route can speak the sentence itself before the daemon wrapper runs. The wrapper still
 * owns the typed field — the response is making its own claim — but it must not copy the words.
 */
test('a repair the capture already spoke keeps its typed field without a copied sentence', () => {
  const response = withTargetActivationDisclosure(
    okResponse({ warning: iosTargetActivationDisclosure(FACT) }),
    { targetActivation: FACT },
  );
  const data = dataOf(response);
  assert.equal(data.warnings, undefined);
  assert.deepEqual(data.targetActivation, FACT);
});
