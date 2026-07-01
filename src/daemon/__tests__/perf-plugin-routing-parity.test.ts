import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEVICE_TARGETS,
  PLATFORMS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
} from '../../kernel/device.ts';
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
import { registerBuiltinPlatformPlugins } from '../../core/platform-plugin/register-builtins.ts';
import { buildPerfResponseData } from '../handlers/session-perf.ts';
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
  return device.platform === 'android' || device.platform === 'ios' || device.platform === 'macos';
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
  assert.equal(getPlugin('ios'), getPlugin('macos'));
  assert.ok(getPlugin('ios').perf, 'apple plugin exposes perf');
  assert.ok(getPlugin('android').perf, 'android plugin exposes perf');
  // linux/web historically returned `false`; they get NO facet, and the daemon
  // lookup preserves that fallthrough (asserted below).
  assert.equal(getPlugin('linux').perf, undefined, 'linux plugin has no perf');
  assert.equal(getPlugin('web').perf, undefined, 'web plugin has no perf');
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
