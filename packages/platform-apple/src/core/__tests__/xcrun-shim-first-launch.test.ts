import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { ExecResult, ExecOptions } from '@agent-device/host-kit/command';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../../runner/apple-runner-platform.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import type { DeadlineClock } from '@agent-device/host-kit/retry';
import {
  probeXcrunShimFirstLaunchHooks,
  XCRUN_SHIM_TOOL_NAMES,
  type XcrunShimProbeOptions,
  type XctestDeviceSetCleanupArming,
} from '../xcrun-shim-first-launch.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import {
  fakeFrameworkInfoPlistPath,
  hookedShimText,
  withFakeXcrunHost,
  writeFakeXcrunShims,
} from './xcrun-shim-fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

async function tempRoot(): Promise<string> {
  return await mkdtempForTest('xcrun-shim-first-launch-');
}

async function probeShims(options?: XcrunShimProbeOptions): Promise<XctestDeviceSetCleanupArming> {
  const probe = await probeXcrunShimFirstLaunchHooks(options);
  if (probe.outcome !== 'read') assert.fail(`the probe read no shim: ${probe.outcome}`);
  return probe.xcrunShims;
}

function phaseClock(remainingMs: number): DeadlineClock {
  return { remainingMs: () => remainingMs, elapsedMs: () => 0, isExpired: () => remainingMs <= 0 };
}

test('only the tools Xcode ships as first-launch shims are probed', async () => {
  const host = writeFakeXcrunShims(await tempRoot(), {});

  const shims = await withFakeXcrunHost(host, () => probeShims());

  assert.deepEqual(XCRUN_SHIM_TOOL_NAMES, ['simctl', 'devicectl']);
  assert.deepEqual(host.finds, XCRUN_SHIM_TOOL_NAMES);
  for (const shim of shims) {
    assert.deepEqual(
      { hook: shim.hook, shimPath: shim.shimPath },
      { hook: 'armed', shimPath: null },
      `${shim.tool} was not found, so it cannot be called safe`,
    );
    assert.equal(shim.hook === 'armed' && shim.armedBy, 'shim_not_located');
  }
});

test('a hooked shim found by xcrun --find is read against the plist its own text names', async () => {
  const root = await tempRoot();
  const otherPlist = path.join(root, 'Other.framework', 'Info.plist');
  const machO = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from(' -runFirstLaunch'),
  ]);
  const host = writeFakeXcrunShims(root, {
    simctl: { text: hookedShimText('1051.17.7', otherPlist) },
    devicectl: { text: machO },
  });
  host.installedVersions.set(otherPlist, '1155.4');

  const [simctl, devicectl] = await withFakeXcrunHost(host, () => probeShims());

  assert.deepEqual(host.plistReads, [otherPlist]);
  assert.deepEqual(simctl, {
    tool: 'simctl',
    shimPath: host.xcrunShimPaths.simctl,
    hook: 'armed',
    armedBy: 'version_mismatch',
    expectedVersion: '1051.17.7',
    frameworkInfoPlistPath: otherPlist,
    installedVersion: '1155.4',
  });
  assert.deepEqual(devicectl, {
    tool: 'devicectl',
    shimPath: host.xcrunShimPaths.devicectl,
    hook: 'none',
  });
});

test('equal versions disarm a hooked shim', async () => {
  const host = writeFakeXcrunShims(await tempRoot(), {
    simctl: { expectedVersion: '1155.4', installedVersion: '1155.4' },
    devicectl: { expectedVersion: '629.3', installedVersion: '629.3' },
  });

  const shims = await withFakeXcrunHost(host, () => probeShims());

  assert.deepEqual(
    shims.map((shim) => [shim.tool, shim.hook]),
    [
      ['simctl', 'disarmed'],
      ['devicectl', 'disarmed'],
    ],
  );
});

test('a shim xcrun found but that cannot be read counts as armed', async () => {
  const root = await tempRoot();
  const host = writeFakeXcrunShims(root, {
    devicectl: { expectedVersion: '629.3', installedVersion: '629.3' },
  });
  const missing = path.join(root, 'xcrun-shims', 'simctl-removed');
  host.xcrunShimPaths.simctl = missing;

  const [simctl] = await withFakeXcrunHost(host, () => probeShims());

  assert.deepEqual(simctl, {
    tool: 'simctl',
    shimPath: missing,
    hook: 'armed',
    armedBy: 'shim_unreadable',
    expectedVersion: null,
    frameworkInfoPlistPath: null,
    installedVersion: null,
  });
});

// Each shape breaks one value and keeps the rest readable and equal, so the verdict is that value's.
const UNREADABLE_VERSION_SHAPES: Record<string, (plistPath: string) => string> = {
  'no EXPECTED_VERSION': (plistPath) =>
    hookedShimText('1', plistPath).replace('EXPECTED_VERSION="1"', 'EXPECTED_VERSION='),
  'no Info.plist path on the CURRENT_VERSION line': (plistPath) =>
    hookedShimText('1', plistPath).replace(`"${plistPath}"`, '"$PLIST"'),
  'an unreadable framework Info.plist': (plistPath) => hookedShimText('1', `${plistPath}.missing`),
};

for (const [shape, text] of Object.entries(UNREADABLE_VERSION_SHAPES)) {
  test(`a hooked shim with ${shape} fails closed`, async () => {
    const root = await tempRoot();
    const plistPath = fakeFrameworkInfoPlistPath(root, 'devicectl');
    const host = writeFakeXcrunShims(root, { devicectl: { text: text(plistPath) } });
    host.installedVersions.set(plistPath, '1');

    const [, devicectl] = await withFakeXcrunHost(host, () => probeShims());

    assert.equal(devicectl?.hook === 'armed' && devicectl.armedBy, 'version_unreadable');
  });
}

function hangingXcrun(onStart: (options: ExecOptions | undefined) => void) {
  return createLocalAppleToolProvider({
    runCommand: async (_cmd, _args, options): Promise<ExecResult> => {
      onStart(options);
      return await new Promise<ExecResult>(() => {});
    },
  });
}

test('the probe spends the cold-toolchain budget on each xcrun --find and reads a timeout as armed', async () => {
  const budget = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
  const findTimeoutsMs: Array<number | undefined> = [];
  const provider = hangingXcrun((options) => {
    findTimeoutsMs.push(options?.timeoutMs);
    if (findTimeoutsMs.length === XCRUN_SHIM_TOOL_NAMES.length) budget.abort();
  });

  const shims = await withAppleToolProvider(provider, () => probeShims());

  assert.deepEqual(timeout.mock.calls, [[COLD_TOOLCHAIN_PROBE_TIMEOUT_MS]]);
  assert.deepEqual(
    findTimeoutsMs,
    XCRUN_SHIM_TOOL_NAMES.map(() => COLD_TOOLCHAIN_PROBE_TIMEOUT_MS),
  );
  assert.deepEqual(
    shims.map((shim) => [shim.tool, shim.hook, shim.hook === 'armed' && shim.armedBy]),
    XCRUN_SHIM_TOOL_NAMES.map((tool) => [tool, 'armed', 'probe_out_of_budget']),
  );
});

test('a phase with less left than the cold budget caps the probe and owns its stop', async () => {
  const budget = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
  let started = 0;
  const provider = hangingXcrun(() => {
    started += 1;
    if (started === XCRUN_SHIM_TOOL_NAMES.length) budget.abort();
  });

  const probe = await withAppleToolProvider(provider, () =>
    probeXcrunShimFirstLaunchHooks({ deadline: phaseClock(5_000) }),
  );

  assert.deepEqual(timeout.mock.calls, [[5_000]]);
  assert.equal(started, XCRUN_SHIM_TOOL_NAMES.length);
  assert.deepEqual(probe, { outcome: 'phase_budget_exhausted' });
});

test('a phase with more left than the cold budget reads a cold-budget stop as armed', async () => {
  const budget = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
  let started = 0;
  const provider = hangingXcrun(() => {
    started += 1;
    if (started === XCRUN_SHIM_TOOL_NAMES.length) budget.abort();
  });

  const shims = await withAppleToolProvider(provider, () =>
    probeShims({ deadline: phaseClock(120_000) }),
  );

  assert.deepEqual(timeout.mock.calls, [[COLD_TOOLCHAIN_PROBE_TIMEOUT_MS]]);
  assert.deepEqual(
    shims.map((shim) => shim.hook === 'armed' && shim.armedBy),
    XCRUN_SHIM_TOOL_NAMES.map(() => 'probe_out_of_budget'),
  );
});

test('a spent phase spawns no xcrun and reads as the phase running out', async () => {
  const host = writeFakeXcrunShims(await tempRoot(), {
    simctl: { expectedVersion: '1155.4', installedVersion: '1155.4' },
    devicectl: { expectedVersion: '629.3', installedVersion: '629.3' },
  });
  const timeout = vi.spyOn(AbortSignal, 'timeout');

  const probe = await withFakeXcrunHost(host, () =>
    probeXcrunShimFirstLaunchHooks({ deadline: phaseClock(0) }),
  );

  assert.deepEqual(probe, { outcome: 'phase_budget_exhausted' });
  assert.deepEqual(host.finds, []);
  assert.equal(timeout.mock.calls.length, 0);
});

test('a request canceled mid-probe reads as canceled, never as an armed shim', async () => {
  const request = new AbortController();
  let started = 0;
  const provider = hangingXcrun((options) => {
    started += 1;
    assert.equal(options?.signal?.aborted, false);
    if (started === XCRUN_SHIM_TOOL_NAMES.length) request.abort();
  });

  const probe = await withAppleToolProvider(provider, () =>
    probeXcrunShimFirstLaunchHooks({ signal: request.signal }),
  );

  assert.equal(started, XCRUN_SHIM_TOOL_NAMES.length);
  assert.deepEqual(probe, { outcome: 'request_canceled' });
});

test('an already-canceled request spawns no xcrun at all', async () => {
  const host = writeFakeXcrunShims(await tempRoot(), {
    simctl: { expectedVersion: '1155.4', installedVersion: '1155.4' },
    devicectl: { expectedVersion: '629.3', installedVersion: '629.3' },
  });

  const probe = await withFakeXcrunHost(host, () =>
    probeXcrunShimFirstLaunchHooks({ signal: AbortSignal.abort() }),
  );

  assert.deepEqual(host.finds, []);
  assert.deepEqual(probe, { outcome: 'request_canceled' });
});
