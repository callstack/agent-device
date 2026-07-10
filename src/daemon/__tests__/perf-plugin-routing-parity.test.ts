import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '../../kernel/errors.ts';
import {
  isIosFamily,
  isMacOs,
  DEVICE_TARGETS,
  PLATFORMS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
} from '../../kernel/device.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  makeSession,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/index.ts';
import { getPlugin } from '../../core/platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';
import { buildPerfResponseData, type PerfMetricsSamplerTag } from '../handlers/session-perf.ts';
import { PERF_UNAVAILABLE_REASON } from '../handlers/session-startup-metrics.ts';

// Phase 3 step b.3 (issue #974) parity gate for the daemon perf facet. The
// per-platform gate of `supportsPlatformPerfMetrics` now flows through the
// PlatformPlugin `perf.supportsMetrics` facet instead of a hand disjunction. An
// INDEPENDENT verbatim copy of the former predicate below is the BEFORE oracle: a
// plugin-vs-branch disagreement on any sample device fails this test. (Mirrors the
// verbatim-copy discipline in daemon/__tests__/applog-plugin-routing-parity.test.ts
// and core/__tests__/capability-plugin-routing-parity.test.ts.)

registerBuiltinPlatformPlugins();

// --- INDEPENDENT verbatim copy of the former `supportsPlatformPerfMetrics` branch ---
function supportsPlatformPerfMetricsByHand(device: DeviceInfo): boolean {
  return device.platform === 'android' || isIosFamily(device) || isMacOs(device);
}

// --- INDEPENDENT verbatim copy of the former `buildPerfResponseData` sampling branch ---
// The old body dispatched `session.device.platform === 'android'` -> the Android sampler,
// else -> the Apple sampler, and was reached ONLY after the support gate above admitted
// the platform. So the sampler selection is defined only for supported devices.
function perfMetricsSamplerTagByHand(device: DeviceInfo): 'apple' | 'android' {
  return device.platform === 'android' ? 'android' : 'apple';
}

// --- the exhaustive synthetic device matrix (every platform x kind x target) ---
const DEVICE_KINDS_ALL: DeviceKind[] = ['simulator', 'emulator', 'device'];
const DEVICE_TARGETS_ALL: (DeviceTarget | undefined)[] = [undefined, ...DEVICE_TARGETS];

function buildDeviceMatrix(): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const platform of PLATFORMS) {
    for (const kind of DEVICE_KINDS_ALL) {
      for (const target of DEVICE_TARGETS_ALL) {
        devices.push({
          platform,
          id: `${platform}-${kind}-${target ?? 'none'}`,
          name: `${platform} ${kind} ${target ?? 'none'}`,
          kind,
          ...(target ? { target } : {}),
          booted: true,
        });
      }
    }
  }
  return devices;
}

// The hand-authored fixtures (the real discovery shapes) plus the exhaustive
// synthetic cross-product, so every off-nominal combination is pinned too.
const SAMPLE_DEVICES: DeviceInfo[] = [
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
  ...buildDeviceMatrix(),
];

test('perf.supportsMetrics facet is byte-identical to the former hand predicate', () => {
  for (const device of SAMPLE_DEVICES) {
    assert.equal(
      getPlugin(device.platform).perf?.supportsMetrics(device) ?? false,
      supportsPlatformPerfMetricsByHand(device),
      `supportsMetrics for ${device.id}`,
    );
  }
});

test('only families with perf metrics carry the perf facet', () => {
  // Apple owns ios + macos (SAME plugin instance); Android carries its own.
  assert.equal(getPlugin('apple'), getPlugin('apple'));
  assert.ok(getPlugin('apple').perf, 'apple plugin exposes perf');
  assert.ok(getPlugin('android').perf, 'android plugin exposes perf');
  // linux/web historically returned `false`; they get NO facet, and the daemon
  // lookup preserves that fallthrough (asserted below).
  assert.equal(getPlugin('linux').perf, undefined, 'linux plugin has no perf');
  assert.equal(getPlugin('web').perf, undefined, 'web plugin has no perf');
});

test('perf.metricsSamplerTag facet is byte-identical to the former sampling branch', () => {
  // The sampler selection is only reached on SUPPORTED devices, so compare there; the
  // unsupported families carry no facet (hence no tag), asserted separately below.
  for (const device of SAMPLE_DEVICES.filter((d) => supportsPlatformPerfMetricsByHand(d))) {
    assert.equal(
      getPlugin(device.platform).perf?.metricsSamplerTag(device),
      perfMetricsSamplerTagByHand(device),
      `metricsSamplerTag for ${device.id}`,
    );
  }
});

test('the factless families expose no metricsSamplerTag', () => {
  for (const device of SAMPLE_DEVICES.filter(
    (d) => d.platform === 'linux' || d.platform === 'web',
  )) {
    assert.equal(
      getPlugin(device.platform).perf?.metricsSamplerTag,
      undefined,
      `no sampler tag for ${device.id}`,
    );
  }
});

test('the factless families fall through to the historical `false` default', () => {
  for (const device of SAMPLE_DEVICES.filter(
    (d) => d.platform === 'linux' || d.platform === 'web',
  )) {
    assert.equal(getPlugin(device.platform).perf, undefined);
    assert.equal(
      getPlugin(device.platform).perf?.supportsMetrics(device) ?? false,
      false,
      `fallthrough for ${device.id}`,
    );
  }
});

// End-to-end routing proof: `buildPerfResponseData` consults the perf facet via the
// (private) `supportsPlatformPerfMetrics`. For a session with NO app bundle it does
// no device I/O — an UNSUPPORTED platform returns the default-unavailable base
// response (cpu reason `PERF_UNAVAILABLE_REASON`), while a SUPPORTED platform fills
// the missing-app reason instead. So the routed cpu reason discriminates support,
// and breaking the facet would flip the classification and fail this test.
test('buildPerfResponseData routes the support gate through the perf facet', async () => {
  for (const device of SAMPLE_DEVICES) {
    const data = await buildPerfResponseData(makeSession(`perf-${device.id}`, { device }));
    const cpu = data.metrics.cpu as { reason?: string };
    const routedSupportsMetrics = cpu.reason !== PERF_UNAVAILABLE_REASON;
    assert.equal(
      routedSupportsMetrics,
      supportsPlatformPerfMetricsByHand(device),
      `routed support for ${device.id}`,
    );
  }
});

// Shipped-path routing proof for the sampling body (issue #1188). The support-gate test
// above never reaches sampler selection — it uses no `appBundleId`, so execution returns
// through `applyMissingAppPerfMetrics` before `resolvePerfMetricsSampler`. WITH an app
// bundle, execution clears that guard and hits the sampler selection. The Android sampler
// is the ONLY arm that threads `options.androidAdb`, so a scripted adb executor is invoked
// exactly when the Android sampler was selected AND run through the shipped code path.
const SAMPLED_ADB_REASON = 'scripted adb unavailable';
function makeThrowingAdb(): { adb: AndroidAdbExecutor; calls: () => number } {
  let calls = 0;
  const adb: AndroidAdbExecutor = async () => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', SAMPLED_ADB_REASON);
  };
  return { adb, calls: () => calls };
}

test('buildPerfResponseData dispatches the Android sampler selected by the facet', async () => {
  for (const device of SAMPLE_DEVICES.filter((d) => d.platform === 'android')) {
    const { adb, calls } = makeThrowingAdb();
    const session = makeSession(`perf-routed-${device.id}`, {
      device,
      appBundleId: 'com.example.app',
    });
    const data = await buildPerfResponseData(session, { androidAdb: adb });

    assert.ok(calls() > 0, `Android sampler reached through the shipped path for ${device.id}`);
    for (const metric of ['memory', 'cpu', 'fps'] as const) {
      const entry = data.metrics[metric] as { available?: boolean; reason?: string };
      assert.equal(
        entry.available,
        false,
        `${metric} was sampled (not the base response) for ${device.id}`,
      );
      assert.equal(
        entry.reason,
        SAMPLED_ADB_REASON,
        `${metric} carries the sampler failure for ${device.id}`,
      );
    }
  }
});

// Facet-vs-platform proof (re-review, issue #1188): the test above cannot distinguish the
// facet lookup from the deleted `device.platform === 'android'` branch, because on a real
// Android device both select the same Android sampler with the same options. Here the
// device is an Apple simulator but its plugin's `metricsSamplerTag` is overridden to
// `'android'`, so ONLY a facet-driven selection routes it to the Android sampler (the
// scripted adb fires). The former platform branch keyed on `device.platform`, so restoring
// it keeps the Apple device on the Apple sampler and this assertion fails — pinning the
// shipped selection to `metricsSamplerTag`, not the device platform.
test('buildPerfResponseData selects the sampler by the facet tag, not the device platform', async () => {
  const perf = getPlugin('apple').perf;
  assert.ok(perf, 'apple plugin exposes the perf facet');
  const mutablePerf = perf as { metricsSamplerTag: (device: DeviceInfo) => PerfMetricsSamplerTag };
  const originalTag = mutablePerf.metricsSamplerTag;
  mutablePerf.metricsSamplerTag = () => 'android';
  try {
    const { adb, calls } = makeThrowingAdb();
    const session = makeSession('perf-facet-tag', {
      device: IOS_SIMULATOR,
      appBundleId: 'com.example.app',
    });
    const data = await buildPerfResponseData(session, { androidAdb: adb });

    assert.ok(calls() > 0, 'facet tag routed the Apple device to the Android sampler');
    const cpu = data.metrics.cpu as { available?: boolean; reason?: string };
    assert.equal(cpu.available, false, 'cpu was sampled through the facet-selected sampler');
    assert.equal(cpu.reason, SAMPLED_ADB_REASON, 'cpu carries the scripted adb failure');
  } finally {
    mutablePerf.metricsSamplerTag = originalTag;
  }
});

// The missing-app guard precedes sampler selection, so without an `appBundleId` the facet
// sampler is never consulted and the scripted adb stays untouched.
test('buildPerfResponseData consults the sampler only past the missing-app guard', async () => {
  const { adb, calls } = makeThrowingAdb();
  await buildPerfResponseData(makeSession('perf-no-bundle', { device: ANDROID_EMULATOR }), {
    androidAdb: adb,
  });
  assert.equal(calls(), 0, 'sampler not consulted without an app bundle');
});
