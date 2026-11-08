import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { iosSnapshotComparisonIdentityKey } from '@agent-device/capture-kit/ios-snapshot-planning';
import { mkdtempForTest } from './__tests__/tmp-dir.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from './core/tool-provider.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { createAppleSnapshotRoute } from './snapshot-route.ts';
import { createSimulatorSnapshotTargetResolver } from './snapshot-target.ts';
import type { SnapshotSourceOutcome } from '@agent-device/capture-kit/snapshot-source-channel';
import type { SimulatorSnapshotSource } from './snapshot-source-facade.ts';
import {
  bridgeAcquisition,
  bridgePresentingHost,
  input,
  ios,
  presentSurface,
  runnerResult,
  signal,
  simctlReadFor,
  sourceReturning,
  surfaceHostExecutables,
  surfaceHostPresent,
  surfaceHostUnverified,
  surfaceRunnerResult,
  target,
  targetsResolvedBy,
} from './snapshot-route.fixtures.ts';

test.for([
  ['an iPhone Simulator', 'simulator-ax-bridge', ios],
  ['an iPad Simulator', 'simulator-ax-bridge', { ...ios, appleOs: 'ipados', name: 'iPad' }],
  ['a physical iPad', 'apple-runner', { ...ios, appleOs: 'ipados', kind: 'device' }],
] as const)('a capture on %s is served by %s', async ([_name, producer, device]) => {
  const acquired = bridgeAcquisition();
  const source = sourceReturning(acquired);
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const route = createAppleSnapshotRoute(
    {
      ...platformRuntimeHostFixture(),
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    { source, targets: targetsResolvedBy(vi.fn(async () => target)) },
  );

  const captured = route.capture(device, input, signal(), async () => runnerResult());
  await expect(captured).resolves.toMatchObject({ producer });
  const presented = producer === 'apple-runner' ? [] : [[acquired, input.options]];
  expect(presentIosAcquisition.mock.calls).toEqual(presented);
});

test.for([surfaceHostPresent, surfaceHostUnverified] as const)(
  'a bridge refusal over a surface host ($failure.code) routes the capture to the runner',
  async (refusal) => {
    const source = sourceReturning(refusal);
    const fallback = vi.fn(async () => runnerResult());
    const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
      source,
      targets: targetsResolvedBy(vi.fn(async () => target)),
    });

    await route.capture(ios, input, signal(), fallback);
    await route.capture(ios, input, signal(), fallback);

    // The host AX bridge cannot see the sheet, so with no runner to read the hosts' foreground
    // state the bridge checks for a host process itself, and the runner (fallback) serves the
    // capture. A host the bridge could not place takes the same path: an unproven check must not
    // fall through to the occluded app tree (#2438). The refusal describes the screen, so the next
    // capture asks the bridge again instead of finding its circuit open.
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(source.acquire).toHaveBeenCalledTimes(2);
    expect(source.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceHostExecutables }),
    );
  },
);

// #2751: a warm capture served by the bridge used to spawn two `pgrep -f` scans before every
// acquire, about 45ms of a 75ms snapshot, because a bridge-served session has no runner to ask.
// The surface decision now rides on the bridge request. On the production resolver, a warm
// capture spawns only the cached target's `ps` identity read; the source's own two identity
// reads are pinned beside it in `snapshot-source/adapter.test.ts`.
test('a warm bridge capture with no runner spawns one ps and no pgrep before the bridge', async () => {
  const run = vi.fn(async (args: readonly string[]) => simctlReadFor(args));
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const source = sourceReturning(bridgeAcquisition());
  const route = createAppleSnapshotRoute(bridgePresentingHost(), {
    source,
    targets: createSimulatorSnapshotTargetResolver(),
  });

  const warm = await withAppleToolProvider(
    createLocalAppleToolProvider({ simctl: { run }, runCommand }),
    async () => {
      await route.capture(ios, input, signal(), async () => runnerResult());
      run.mockClear();
      runCommand.mockClear();
      return await route.capture(ios, input, signal(), async () => runnerResult());
    },
  );

  expect(warm.producer).toBe('simulator-ax-bridge');
  expect(run).not.toHaveBeenCalled();
  expect(runCommand.mock.calls).toEqual([['ps', ['-p', '42', '-o', 'lstart='], expect.anything()]]);
  expect(source.acquire).toHaveBeenLastCalledWith(
    expect.objectContaining({ surfaceHostExecutables }),
  );
});

// A ready runner reads every registered host's foreground state before the bridge checks host
// processes: a host process outlives what it presented (password AutoFill at sign-in leaves
// SafariViewService running), so only a runner that cannot answer hands the check to the bridge.
test.for([
  { runner: 'background', host: 'absent', acquired: true, checked: false, served: 'bridge' },
  { runner: 'foreground', host: 'absent', acquired: false, checked: false, served: 'runner' },
  { runner: 'unknown', host: 'absent', acquired: true, checked: true, served: 'bridge' },
  { runner: 'unknown', host: 'present', acquired: true, checked: true, served: 'runner' },
] as const)(
  'runner reads $runner, bridge finds host $host: checked $checked, served by $served',
  async ({ runner, host, acquired, checked, served }) => {
    const source = sourceReturning(host === 'present' ? surfaceHostPresent : bridgeAcquisition());
    const fallback = vi.fn(async () => runnerResult());
    const systemSurfaceForeground = vi.fn(async () => ({
      foreground:
        runner === 'foreground'
          ? ({ kind: 'foreground', host: presentSurface.host } as const)
          : runner,
    }));
    const route = createAppleSnapshotRoute(bridgePresentingHost(), {
      source,
      targets: targetsResolvedBy(vi.fn(async () => target)),
      systemSurfaceForeground,
    });

    await route.capture(ios, { ...input, execution: { requestId: 'req-1' } }, signal(), fallback);

    expect(systemSurfaceForeground).toHaveBeenCalledWith(
      ios,
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(source.acquire).toHaveBeenCalledTimes(acquired ? 1 : 0);
    const requests = vi.mocked(source.acquire).mock.calls.map(([request]) => request);
    expect(requests.map((request) => 'surfaceHostExecutables' in request)).toEqual(
      acquired ? [checked] : [],
    );
    expect(fallback).toHaveBeenCalledTimes(served === 'runner' ? 1 : 0);
  },
);

// The structural guarantee every comparison site downstream relies on (#2438): a surface capture is
// lineaged to the HOST, not to the app (`target.targetId` here), so its comparison key cannot equal
// an app capture's and no comparison site needs its own surface check.
test('a presented system surface captures under the host lineage, never the app lineage', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning(surfaceHostPresent),
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const first = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());
  const second = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());

  expect(first.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { targetId: `${ios.id}:${presentSurface.host.bundleId}` },
    // No `unknown-generation` residue: the surface is not an app generation, and a per-capture
    // residue id would make two captures of the same sheet incomparable with each other too.
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
  expect(
    iosSnapshotComparisonIdentityKey(first.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(second.comparisonIdentity!),
  ).toBe(true);
  // The bridge is healthy here and simply cannot see the surface, so the app's wording would lie.
  expect(first.warnings).toEqual([
    'Simulator AX snapshot inapplicable (system-surface-presented); used XCTest to read the system surface presented over the app.',
  ]);
});

// The bridge's process check answers about a host PROCESS, which stays positive while a dismissed
// host lingers — a documented false positive. Only the runner answers about the screen, and it stamps
// the surface it served on the capture. Reading the check for identity instead would lineage the app
// capture to the host, make it compare EQUAL to the preceding sheet capture, and let a post-gesture
// poll read the dismissal as a stable surface (#2438).
test('a lingering surface host cannot make a sheet capture and an app capture compare equal', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning(surfaceHostPresent),
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const sheet = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());
  const app = await route.capture(ios, input, signal(), async () => runnerResult());
  const stillApp = await route.capture(ios, input, signal(), async () => runnerResult());

  expect(sheet.comparisonIdentity?.lineage).toEqual({
    targetId: `${ios.id}:${presentSurface.host.bundleId}`,
  });
  expect(app.comparisonIdentity?.lineage).toEqual({ targetId: target.targetId });
  expect(
    iosSnapshotComparisonIdentityKey(sheet.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(app.comparisonIdentity!),
  ).toBe(false);
  // Two app captures taken in the same lingering window still compare equal, so a poll can settle on
  // app content: the capture decides the lineage, and nothing here carries a per-capture residue.
  expect(
    iosSnapshotComparisonIdentityKey(app.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(stillApp.comparisonIdentity!),
  ).toBe(true);
  expect(app.warnings).toEqual([
    'Simulator AX snapshot inapplicable (system-surface-host-lingering); used XCTest, which read app content: the system surface host process was still running but no longer presenting.',
  ]);
});

// With the bridge circuit already disabled for this generation, the bridge never runs its surface
// check, so a sheet can appear with nothing to report it. The route takes the plain
// fallback, which used to stamp the planned app lineage onto whatever came back — so the sheet
// capture carried the app generation and could corroborate a tap against an app capture (#2438).
test('a sheet behind a disabled bridge circuit is identified by the surface, not the app', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning({
      stage: 'failed',
      failure: { kind: 'transport-failure', code: 'bridge-disconnected' },
    }),
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  // The first capture disables the circuit for this generation; both later captures take the
  // `circuit-disabled` path, where the route plans nothing about a surface.
  const app = await route.capture(ios, input, signal(), async () => runnerResult());
  const sheet = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());
  const sheetAgain = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());

  expect(sheet.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { targetId: `${ios.id}:${presentSurface.host.bundleId}` },
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
  expect(app.comparisonIdentity?.lineage).toEqual({
    targetId: target.targetId,
    generation: target.generation,
  });
  expect(
    iosSnapshotComparisonIdentityKey(app.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(sheet.comparisonIdentity!),
  ).toBe(false);
  // Two captures of the same sheet still compare equal, so a poll can settle on the sheet.
  expect(
    iosSnapshotComparisonIdentityKey(sheet.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(sheetAgain.comparisonIdentity!),
  ).toBe(true);
  // The reason the bridge was skipped survives — it is independent of what the runner found — but
  // the sentence cannot claim an app generation this capture did not read.
  expect(sheet.warnings).toEqual([
    'Simulator AX snapshot unavailable (circuit-disabled); used XCTest, which read the system surface presented over the app.',
  ]);
});

// Same gap, reached through the probe-unavailable arm: that arm plans the app generation it
// resolved, and app-generation evidence must not ride along on a capture of a surface — the sheet
// would carry the app generation and could compare equal to an app capture.
test('a surface capture drops the app generation of the arm that reached it', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning(surfaceHostUnverified),
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const sheet = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());
  const sheetAgain = await route.capture(ios, input, signal(), async () => surfaceRunnerResult());

  expect(sheet.comparisonIdentity).toMatchObject({
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
  expect(sheet.comparisonIdentity?.lineage).toEqual({
    targetId: `${ios.id}:${presentSurface.host.bundleId}`,
  });
  expect(
    iosSnapshotComparisonIdentityKey(sheet.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(sheetAgain.comparisonIdentity!),
  ).toBe(true);
});

// A pinned backend and a custom-actions read bypass the route's planning, but they still reach the
// runner, and the runner serves the sheet there too. Without an identity that pair falls back to
// legacy presentation matching, where a sheet and app content read as one presentation and could
// corroborate a tap across the two (#2438).
test.each([
  ['a pinned backend', { preferredBackend: 'private-ax' }],
  ['a custom-actions read', { customActions: true }],
] as const)(
  'a route-bypassing capture of a system surface is incomparable (%s)',
  async (_label, bypass) => {
    const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
      source: sourceReturning(bridgeAcquisition()),
      targets: targetsResolvedBy(vi.fn(async () => target)),
    });
    const bypassInput = { options: { ...input.options, ...bypass } };

    const sheet = await route.capture(ios, bypassInput, signal(), async () =>
      surfaceRunnerResult(),
    );
    const app = await route.capture(ios, bypassInput, signal(), async () => runnerResult());

    expect(sheet.comparisonIdentity).toMatchObject({
      producer: 'apple-runner',
      lineage: { targetId: `${ios.id}:${presentSurface.host.bundleId}` },
      // Nothing fell back here: the runner is the requested producer, not a replacement for the bridge.
      residue: [],
    });
    // An app capture off the route is untouched — identity included, as before.
    expect(app).toEqual(runnerResult());
  },
);

// Losing the bridge fast path must never be silent: an unprovable check still owes the caller a
// warning and an identity that cannot be compared against a bridge publication.
test('a bridge that cannot place a host process discloses the skipped bridge', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning(surfaceHostUnverified),
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const result = await route.capture(ios, input, signal(), async () => runnerResult());

  expect(result.warnings).toEqual([
    'Simulator AX snapshot unavailable (system-surface-host-unverified); used XCTest for this app generation.',
  ]);
  expect(result.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { targetId: target.targetId, generation: target.generation },
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
});

test('typed bridge failure falls back once and disables retries for that app generation', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'transport-failure', code: 'bridge-disconnected' },
  });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const logPath = path.join(await mkdtempForTest('ios-route-'), 'request.ndjson');
  const [first, second] = await withDiagnosticsScope(
    { command: 'snapshot', debug: true, logPath },
    async () => {
      const first = await route.capture(ios, input, signal(), fallback);
      const second = await route.capture(ios, input, signal(), fallback);
      return [first, second] as const;
    },
  );

  expect(
    fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.phase === 'ios_snapshot_route_fallback')
      .map((event) => event.data),
  ).toEqual([
    { reason: 'bridge-disconnected', deviceId: ios.id, generation: target.generation },
    { reason: 'circuit-disabled', deviceId: ios.id, generation: target.generation },
  ]);

  expect(source.acquire).toHaveBeenCalledOnce();
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(first.warnings).toEqual([
    'Simulator AX snapshot unavailable (bridge-disconnected); used XCTest for this app generation.',
  ]);
  expect(first.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { generation: target.generation },
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
  expect(second.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { generation: target.generation },
  });
});

// The local guest channel reads through no runner session, so its circuit lives as long as the
// route. A runner restart that the surface proof reports must not reopen a retired generation.
test('a runner session change leaves the local bridge circuit open for the retired generation', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'transport-failure', code: 'bridge-disconnected' },
  });
  let sessionId = 'runner-session-1';
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(vi.fn(async () => target)),
    systemSurfaceForeground: async () => ({ foreground: 'background', sessionId }),
  });
  const fallback = vi.fn(async () => runnerResult());

  await route.capture(ios, input, signal(), fallback);
  sessionId = 'runner-session-2';
  const second = await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).toHaveBeenCalledOnce();
  expect(second.warnings).toEqual([
    'Simulator AX snapshot unavailable (circuit-disabled); used XCTest for this app generation.',
  ]);
});

test('a bridge still being prepared sends only that capture to the runner', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'preparing', code: 'bridge-preparation-pending' },
  });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const first = await route.capture(ios, input, signal(), fallback);
  const second = await route.capture(ios, input, signal(), fallback);

  // An attempt in flight says nothing about this app generation, so unlike a failed bridge it must
  // not close the circuit: a stable screen would never use the finished preparation.
  expect(source.acquire).toHaveBeenCalledTimes(2);
  expect(fallback).toHaveBeenCalledTimes(2);
  const pending = [
    'Simulator AX snapshot unavailable (bridge-preparation-pending); used XCTest for this capture while the bridge is still being prepared.',
  ];
  expect(first.warnings).toEqual(pending);
  // The circuit-disabled sentence would mean the route gave up on the bridge for this generation,
  // and the app-generation sentence would mean the same; only this capture moved to the runner.
  expect(second.warnings).toEqual(pending);
});

// Each refusal below is evidence about the screen, not the app generation: a rotated system surface
// (#2612), a permission alert over the app, or an app window that does not fill the screen (#3844).
// It is gone after the next keystroke, tap, or resize, so retiring the generation would move every
// later capture of a healthy app to the runner; it must cost only the captures it covers.
test.for([
  [
    'window-coordinate-space-unresolved',
    "which reports captured geometry in the app's own orientation space",
  ],
  ['foreground-owner-unverified', 'while another surface owned the foreground'],
  ['foreground-owner-changed', 'while another surface owned the foreground'],
  ['snapshot-tree-changed', 'while the screen changed during the bridge read'],
  [
    'app-window-not-full-screen',
    'while the app window did not fill the screen; the runner republishes a windowed capture in screen space',
  ],
] as const)('a %s refusal sends only that capture to the runner', async ([code, consequence]) => {
  const source = sourceReturning({ stage: 'failed', failure: { kind: 'unsupported', code } });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  const first = await route.capture(ios, input, signal(), fallback);
  const second = await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).toHaveBeenCalledTimes(2);
  expect(fallback).toHaveBeenCalledTimes(2);
  const refused = [
    `Simulator AX snapshot unavailable (${code}); used XCTest for this capture, ${consequence}.`,
  ];
  expect(first.warnings).toEqual(refused);
  expect(second.warnings).toEqual(refused);
});

test('a new app generation re-enables the bridge', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'transport-failure', code: 'bridge-disconnected' },
  });
  const resolveTarget = vi
    .fn()
    .mockResolvedValueOnce(target)
    .mockResolvedValueOnce(target)
    .mockResolvedValueOnce({ ...target, pid: 84, generation: '84:launch-b' });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(resolveTarget),
  });

  await route.capture(ios, input, signal(), fallback);
  await route.capture(ios, input, signal(), fallback);
  await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).toHaveBeenCalledTimes(2);
});

test('stale bridge acquisition resolves the current generation before XCTest fallback', async () => {
  const currentTarget = { ...target, pid: 84, generation: '84:launch-b' };
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'stale-target', code: 'target-generation-changed' },
  });
  const resolveTarget = vi.fn().mockResolvedValueOnce(target);
  const refreshTarget = vi.fn().mockResolvedValueOnce(currentTarget);
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(resolveTarget, refreshTarget),
  });

  const result = await route.capture(ios, input, signal(), async () => runnerResult());

  expect(resolveTarget).toHaveBeenCalledOnce();
  expect(refreshTarget).toHaveBeenCalledOnce();
  expect(refreshTarget).toHaveBeenLastCalledWith(
    ios,
    input.options.appBundleId,
    expect.any(AbortSignal),
  );
  expect(result.comparisonIdentity?.lineage).toEqual({
    targetId: currentTarget.targetId,
    generation: currentTarget.generation,
  });
});

// The bridge saw a newer generation while the app process kept its pid and start time, so the
// local resolver's identity check would still accept its cached target. The fallback must force a
// rediscovery and name what it found, not republish the generation the bridge refused.
test('a stale-target fallback on the local resolver stamps the rediscovered generation', async () => {
  let launch = 'launch-a';
  const run = vi.fn(async (args: readonly string[]) => simctlReadFor(args, launch));
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const source: SimulatorSnapshotSource = {
    acquire: vi.fn(async () => {
      launch = 'launch-b';
      return {
        stage: 'failed',
        failure: { kind: 'stale-target', code: 'target-generation-changed' },
      } as const;
    }),
    close: vi.fn(async () => {}),
  };
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: createSimulatorSnapshotTargetResolver(),
  });

  const result = await withAppleToolProvider(
    createLocalAppleToolProvider({ simctl: { run }, runCommand }),
    async () => await route.capture(ios, input, signal(), async () => runnerResult()),
  );

  expect(source.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({
        generation: `42:UIKitApplication:${input.options.appBundleId}[launch-a][rb-legacy]:start-a`,
      }),
    }),
  );
  expect(run.mock.calls.filter(([args]) => args[0] === 'spawn')).toHaveLength(2);
  expect(result.comparisonIdentity?.lineage).toEqual({
    targetId: `${ios.id}:${input.options.appBundleId}`,
    generation: `42:UIKitApplication:${input.options.appBundleId}[launch-b][rb-legacy]:start-a`,
  });
  expect(result.warnings).toEqual([
    'Simulator AX snapshot unavailable (target-generation-changed); used XCTest for this app generation.',
  ]);
});

test('target-resolution fallback remains incomparable with a bridge publication', async () => {
  const source = sourceReturning(bridgeAcquisition());
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(
      vi.fn(async () => {
        throw new Error('launch job unavailable');
      }),
    ),
  });

  const result = await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).not.toHaveBeenCalled();
  expect(result.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { targetId: target.targetId },
    residue: [
      { kind: 'unknown-generation', captureId: expect.any(String) },
      { kind: 'fallback-source', producer: 'apple-runner' },
    ],
  });
});

test('two target-resolution fallbacks cannot share comparison identity', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning(bridgeAcquisition()),
    targets: targetsResolvedBy(
      vi.fn(async () => {
        throw new Error('launch job unavailable');
      }),
    ),
  });

  const first = await route.capture(ios, input, signal(), async () => runnerResult());
  const second = await route.capture(ios, input, signal(), async () => runnerResult());

  expect(first.comparisonIdentity).toBeDefined();
  expect(second.comparisonIdentity).toBeDefined();
  expect(
    iosSnapshotComparisonIdentityKey(first.comparisonIdentity!) ===
      iosSnapshotComparisonIdentityKey(second.comparisonIdentity!),
  ).toBe(false);
});

test('runtime shutdown closes the process-owned bridge source', async () => {
  const source = sourceReturning(bridgeAcquisition());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), { source });

  await route.shutdown();

  expect(source.close).toHaveBeenCalledOnce();
});

test('cancelled acquisition does not start a fallback after the request aborts', async () => {
  const controller = new AbortController();
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'cancelled', code: 'abort-signal' },
  });
  vi.mocked(source.acquire).mockImplementation(async () => {
    controller.abort(new DOMException('request ended', 'AbortError'));
    return { stage: 'failed', failure: { kind: 'cancelled', code: 'abort-signal' } };
  });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    targets: targetsResolvedBy(vi.fn(async () => target)),
  });

  await expect(route.capture(ios, input, controller.signal, fallback)).rejects.toThrow(
    'request ended',
  );
  expect(fallback).not.toHaveBeenCalled();
});

test('a slow app discovery yields to a live runner within its wait slice, then serves the bridge', async () => {
  // The production resolver over a simctl whose `launchctl list` answers only when released,
  // the shape of a loaded CI host: with a runner that can answer at once, the first capture
  // must not sit on that probe.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'spawn') await released;
    return simctlReadFor(args);
  });
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const fallback = vi.fn(async () => runnerResult());
  const source = sourceReturning(bridgeAcquisition());
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const baseHost = platformRuntimeHostFixture();
  const route = createAppleSnapshotRoute(
    {
      ...baseHost,
      appleApplications: { ...baseHost.appleApplications, hasLiveRunnerSession: async () => true },
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    { source, targets: createSimulatorSnapshotTargetResolver() },
  );
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(
      createLocalAppleToolProvider({ simctl: { run }, runCommand }),
      async () => {
        const first = route.capture(ios, input, signal(), fallback);
        await vi.advanceTimersByTimeAsync(1_500);
        const result = await first;
        expect(fallback).toHaveBeenCalledOnce();
        expect(result.warnings).toEqual([
          'Simulator AX snapshot unavailable (target-resolution-failed); used XCTest for an unverified app generation.',
        ]);
        expect(source.acquire).not.toHaveBeenCalled();

        release();
        await vi.advanceTimersByTimeAsync(0);
        const second = await route.capture(ios, input, signal(), fallback);
        expect(second.producer).toBe('simulator-ax-bridge');
        expect(fallback).toHaveBeenCalledOnce();
        expect(run.mock.calls.filter(([args]) => args[0] === 'spawn')).toHaveLength(1);
      },
    );
  } finally {
    vi.useRealTimers();
  }
});

test('an open waits out a slow app discovery, so the first capture after it starts warm', async () => {
  // iOS smoke `wait for Agent Device Tester` right after `open --relaunch`: `launchctl list`
  // outlasted one discovery slice on CI, the open read that as an unobservable app and returned,
  // and the wait's first poll paid the discovery, the bridge preparation and the first bridge
  // connection behind a runner findText until its 10 s budget ran out.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'spawn') await released;
    return simctlReadFor(args);
  });
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const fallback = vi.fn(async () => runnerResult());
  const source = sourceReturning(bridgeAcquisition());
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const baseHost = platformRuntimeHostFixture();
  const route = createAppleSnapshotRoute(
    {
      ...baseHost,
      appleApplications: { ...baseHost.appleApplications, hasLiveRunnerSession: async () => true },
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    { source, targets: createSimulatorSnapshotTargetResolver() },
  );
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(
      createLocalAppleToolProvider({ simctl: { run }, runCommand }),
      async () => {
        let verdict: string | undefined;
        const observed = route
          .awaitObservable(ios, input.options.appBundleId, signal())
          .then((value) => (verdict = value.observation));
        await vi.advanceTimersByTimeAsync(4_500);
        expect(verdict).toBeUndefined();
        expect(source.acquire).not.toHaveBeenCalled();

        release();
        await vi.advanceTimersByTimeAsync(0);
        await expect(observed).resolves.toBe('observable');
        expect(source.acquire).toHaveBeenCalledOnce();

        const first = await route.capture(ios, input, signal(), fallback);
        expect(first.producer).toBe('simulator-ax-bridge');
        expect(fallback).not.toHaveBeenCalled();
        expect(run.mock.calls.filter(([args]) => args[0] === 'spawn')).toHaveLength(1);
      },
    );
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  'application-server-unavailable',
  'continuation-budget-exhausted',
  'snapshot-tree-malformed',
])('an open whose generation failed with %s skips the launch-observation poll', async (code) => {
  // #2199: `application-server-unavailable` is a launch-transition code, so an ungated probe would
  // re-read the bridge every 150 ms for its whole 5 s window on a generation the circuit already
  // gave up on — ~33 acquisitions per `open`, each a fresh connect.
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'transport-failure', code },
  });
  const route = createAppleSnapshotRoute(
    { ...platformRuntimeHostFixture(), clock: steppingClock() },
    { source, targets: targetsResolvedBy(vi.fn(async () => target)) },
  );

  await route.capture(ios, input, signal(), async () => runnerResult());
  expect(source.acquire).toHaveBeenCalledOnce();

  await expect(route.awaitObservable(ios, input.options.appBundleId, signal())).resolves.toEqual({
    observation: 'probe-failed',
    failure: { source: 'circuit' },
  });
  expect(source.acquire).toHaveBeenCalledOnce();
});

test('a relaunched generation rebaselines the circuit and observes the launch', async () => {
  const outcomes: SnapshotSourceOutcome[] = [
    { stage: 'failed', failure: { kind: 'transport-failure', code: 'bridge-disconnected' } },
    bridgeAcquisition(),
  ];
  let acquisitions = 0;
  const source = {
    acquire: vi.fn(async () => outcomes[Math.min(acquisitions++, outcomes.length - 1)]!),
    close: vi.fn(async () => {}),
  };
  const relaunched = { ...target, pid: 84, generation: '84:launch-b' };
  const resolveTarget = vi.fn().mockResolvedValueOnce(target).mockResolvedValue(relaunched);
  const route = createAppleSnapshotRoute(
    { ...platformRuntimeHostFixture(), clock: steppingClock() },
    { source, targets: targetsResolvedBy(resolveTarget) },
  );

  await route.capture(ios, input, signal(), async () => runnerResult());

  await expect(route.awaitObservable(ios, input.options.appBundleId, signal())).resolves.toEqual({
    observation: 'observable',
  });
  expect(source.acquire).toHaveBeenCalledTimes(2);
});

/** A clock the launch-observation loop can run to its deadline instead of spinning forever. */
function steppingClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

test('a slow app discovery keeps observation on the bridge while no runner can answer', async () => {
  // #2198: the open no longer awaits the runner, so right after a relaunch the fallback would
  // wait for a cold runner start. A capture with no live runner rides the single-flight
  // discovery instead, however many wait slices that takes.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'spawn') await released;
    return simctlReadFor(args);
  });
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const fallback = vi.fn(async () => runnerResult());
  const source = sourceReturning(bridgeAcquisition());
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const hasLiveRunnerSession = vi.fn(async () => false);
  const baseHost = platformRuntimeHostFixture();
  const route = createAppleSnapshotRoute(
    {
      ...baseHost,
      appleApplications: { ...baseHost.appleApplications, hasLiveRunnerSession },
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    { source, targets: createSimulatorSnapshotTargetResolver() },
  );
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(
      createLocalAppleToolProvider({ simctl: { run }, runCommand }),
      async () => {
        const capture = route.capture(ios, input, signal(), fallback);
        await vi.advanceTimersByTimeAsync(4_500);
        expect(fallback).not.toHaveBeenCalled();
        expect(hasLiveRunnerSession).toHaveBeenCalled();

        release();
        await vi.advanceTimersByTimeAsync(0);
        const result = await capture;
        expect(result.producer).toBe('simulator-ax-bridge');
        expect(fallback).not.toHaveBeenCalled();
        expect(run.mock.calls.filter(([args]) => args[0] === 'spawn')).toHaveLength(1);
      },
    );
  } finally {
    vi.useRealTimers();
  }
});

test.for(['rejects', 'exits'] as const)(
  'a deadline during the cached target re-check is not readiness work (ps %s)',
  async (psOnAbort) => {
    // A known target is re-checked with one `ps` per capture; no discovery runs. A deadline that
    // lands there must stay a plain cancellation, or a wait would report readiness exhaustion over
    // evidence its earlier polls already gathered (#2343 review).
    const run = vi.fn(async (args: readonly string[]) => simctlReadFor(args));
    let recheckStarted!: () => void;
    const recheck = new Promise<void>((resolve) => {
      recheckStarted = resolve;
    });
    let psCalls = 0;
    const runCommand = vi.fn(
      async (cmd: string, args: readonly string[], options?: { signal?: AbortSignal }) => {
        if (cmd !== 'ps' || ++psCalls === 1) return { stdout: 'start-a', stderr: '', exitCode: 0 };
        recheckStarted();
        return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
          (resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () =>
                psOnAbort === 'rejects'
                  ? reject(createRequestCanceledError({ cmd, args }))
                  : resolve({ stdout: '', stderr: '', exitCode: 1 }),
              { once: true },
            );
          },
        );
      },
    );
    const fallback = vi.fn(async () => runnerResult());
    const baseHost = platformRuntimeHostFixture();
    const route = createAppleSnapshotRoute(
      {
        ...baseHost,
        appleApplications: {
          ...baseHost.appleApplications,
          hasLiveRunnerSession: async () => false,
        },
        snapshot: {
          captureSurface: vi.fn(),
          presentIosAcquisition: vi.fn(async () => ({
            backend: 'xctest' as const,
            producer: 'simulator-ax-bridge' as const,
            nodes: [{ index: 0, type: 'Application' }],
          })),
        },
      },
      {
        source: sourceReturning(bridgeAcquisition()),
        targets: createSimulatorSnapshotTargetResolver(),
      },
    );
    await withAppleToolProvider(
      createLocalAppleToolProvider({ simctl: { run }, runCommand }),
      async () => {
        await route.capture(ios, input, signal(), fallback);
        const deadline = new AbortController();
        const capture = route.capture(ios, input, deadline.signal, fallback);
        await recheck;
        deadline.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));

        await expect(capture).rejects.not.toHaveProperty('details.readinessPhase');
        expect(run.mock.calls.filter(([args]) => args[0] === 'spawn')).toHaveLength(1);
        expect(fallback).not.toHaveBeenCalled();
      },
    );
  },
);

test('a deadline during a slow app discovery names the discovery as the readiness phase', async () => {
  // The capture never reached the bridge or the runner: its whole cost was finding the target, so
  // the cancellation says so instead of reading as a capture that produced nothing (#2343).
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'spawn') await new Promise<never>(() => {});
    return {
      stdout: JSON.stringify({
        devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: ios.id }] },
      }),
      stderr: '',
      exitCode: 0,
    };
  });
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const fallback = vi.fn(async () => runnerResult());
  const baseHost = platformRuntimeHostFixture();
  const route = createAppleSnapshotRoute(
    {
      ...baseHost,
      appleApplications: { ...baseHost.appleApplications, hasLiveRunnerSession: async () => false },
    },
    {
      source: sourceReturning(bridgeAcquisition()),
      targets: createSimulatorSnapshotTargetResolver(),
    },
  );
  const deadline = new AbortController();
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(
      createLocalAppleToolProvider({ simctl: { run }, runCommand }),
      async () => {
        const capture = route.capture(ios, input, deadline.signal, fallback);
        const settled = expect(capture).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { reason: 'request_canceled', readinessPhase: 'target-discovery' },
        });
        await vi.advanceTimersByTimeAsync(3_000);
        deadline.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
        await settled;
        expect(fallback).not.toHaveBeenCalled();
      },
    );
  } finally {
    vi.useRealTimers();
  }
});
