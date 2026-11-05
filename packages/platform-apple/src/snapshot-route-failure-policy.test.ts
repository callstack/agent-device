import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';
import { bridgeFailureDisposition } from './snapshot-route-failure-policy.ts';

// Each expectation below is written out, never read back from the production table: a test that
// derived the scope from the same table could not detect the table entry moving.

describe('capture-scoped screen refusals', () => {
  // Positives paired with the closest negative: a screen refusal keeps the generation on the bridge
  // path, and the entry beside it in the code space does not (#3874, #3895).
  test.for([
    ['window-coordinate-space-unresolved', 'coordinate-space-unresolved'],
    ['app-window-not-full-screen', 'window-not-full-screen'],
    ['foreground-owner-unverified', 'foreground-ownership'],
    ['foreground-owner-changed', 'foreground-ownership'],
  ] as const)(
    'a %s refusal classifies as capture-scoped with its consequence',
    ([code, consequence]) => {
      expect(bridgeFailureDisposition({ kind: 'unsupported', code })).toEqual({
        scope: 'capture',
        code,
        consequence,
      });
    },
  );

  test('a runner-served read still running classifies as capture-scoped; an abandoned one does not', () => {
    // The refusal says only that another read is running; abandoning a read past its budget is
    // evidence about the app's tree, so that one still retires the generation.
    expect(bridgeFailureDisposition({ kind: 'timeout', code: 'bridge-read-in-flight' })).toEqual({
      scope: 'capture',
      code: 'bridge-read-in-flight',
      consequence: 'bridge-read-busy',
    });
    expect(bridgeFailureDisposition({ kind: 'timeout', code: 'bridge-read-abandoned' })).toEqual({
      scope: 'generation',
      code: 'bridge-read-abandoned',
    });
  });

  test('a bridge still being prepared classifies as capture-scoped preparation', () => {
    // The kind carries this one, not a code: the preparation owner reports a pending attempt, not
    // a screen (#2491).
    expect(
      bridgeFailureDisposition({ kind: 'preparing', code: 'bridge-preparation-pending' }),
    ).toEqual({
      scope: 'capture',
      code: 'bridge-preparation-pending',
      consequence: 'bridge-preparation',
    });
  });
});

describe('surface host refusals', () => {
  // The guest refuses while a registered host process runs for the Simulator (#2751). Both refusals
  // describe the screen, so neither retires the generation, and each names what it found.
  test('a present refusal names the registered host whose executable the guest found', () => {
    const host = IOS_SYSTEM_SURFACE_HOSTS[1]!;
    expect(
      bridgeFailureDisposition({
        kind: 'unsupported',
        code: 'system-surface-host-present',
        details: { surfaceHostExecutable: host.processExecutable },
      }),
    ).toEqual({
      scope: 'capture',
      code: 'system-surface-host-present',
      consequence: 'system-surface-host',
      surfaceHost: host,
    });
  });

  test.for([
    ['an unverified refusal', 'system-surface-host-unverified', undefined],
    ['a present refusal naming no executable', 'system-surface-host-present', undefined],
    [
      'a present refusal naming an unregistered executable',
      'system-surface-host-present',
      { surfaceHostExecutable: 'Other.app/Other' },
    ],
  ] as const)('%s proves no host, so it is unverified', ([_label, code, details]) => {
    expect(
      bridgeFailureDisposition({ kind: 'unsupported', code, ...(details ? { details } : {}) }),
    ).toEqual({
      scope: 'capture',
      code,
      consequence: 'system-surface-host',
      surfaceHost: 'unverified',
    });
  });
});

describe('generation-wide failures', () => {
  test('a transport failure classifies as generation-wide without a consequence', () => {
    expect(
      bridgeFailureDisposition({ kind: 'transport-failure', code: 'bridge-disconnected' }),
    ).toEqual({ scope: 'generation', code: 'bridge-disconnected' });
  });

  test('a stale target classifies as generation-wide', () => {
    expect(
      bridgeFailureDisposition({ kind: 'stale-target', code: 'target-generation-changed' }),
    ).toEqual({ scope: 'generation', code: 'target-generation-changed' });
  });

  test('a presentation failure classifies as generation-wide', () => {
    expect(
      bridgeFailureDisposition({ kind: 'malformed-tree', code: 'presentation-invariant' }),
    ).toEqual({ scope: 'generation', code: 'presentation-invariant' });
  });

  test.for(['future-runtime-refusal', 'toString', 'constructor'] as const)(
    'a code this policy does not know (%s) keeps the conservative generation default',
    (code) => {
      // The guest's `code` is an open string. A refusal unknown here must not quietly keep a
      // generation on a path that just refused it; a new capture-scoped refusal is classified
      // explicitly, never by widening this default. An inherited property name is an unknown code
      // too, so the table's lookup must not answer through a prototype chain.
      expect(bridgeFailureDisposition({ kind: 'unsupported', code })).toEqual({
        scope: 'generation',
        code,
      });
    },
  );
});

// The table is shared with the emitter guard in test/repo-guards/snapshot-bridge-refusals.test.ts.
const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../../contracts/fixtures/ios-snapshot-bridge-refusals.json',
    ),
    'utf8',
  ),
) as { captureScoped: { code: string; consequence: string }[]; generationScoped: string[] };

test('the policy gives each code of the shared refusal table its scope and consequence', () => {
  for (const { code, consequence } of fixture.captureScoped) {
    // A preparation still running is classified by its failure kind, not by its code.
    const kind = consequence === 'bridge-preparation' ? 'preparing' : 'unsupported';
    // A surface-host refusal also names the host it saw; this table fixes only scope and consequence.
    expect(bridgeFailureDisposition({ kind, code }), code).toMatchObject({
      scope: 'capture',
      code,
      consequence,
    });
  }
  for (const code of fixture.generationScoped) {
    expect(bridgeFailureDisposition({ kind: 'unsupported', code }), code).toEqual({
      scope: 'generation',
      code,
    });
  }
});
