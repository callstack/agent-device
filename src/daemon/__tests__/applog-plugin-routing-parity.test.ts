import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isIosFamily,
  isMacOs,
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
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/index.ts';
import { getPlugin } from '../../core/platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';
import { resolveLogBackend } from '../app-log.ts';
import type { LogBackend } from '../network-log.ts';

// Phase 3 step b.3 (issue #974) parity gate for the daemon app-log facet. The
// per-platform branch of `resolveLogBackend` now flows through the PlatformPlugin
// `appLog.resolveBackend` facet instead of a hand switch. An INDEPENDENT verbatim
// copy of the former branch below is the BEFORE oracle: a plugin-vs-branch
// disagreement on any sample device fails this test. (Mirrors the verbatim-copy
// discipline in core/__tests__/capability-plugin-routing-parity.test.ts.)

registerBuiltinPlatformPlugins();

// --- INDEPENDENT verbatim copy of the former `resolveLogBackend` hand branch ---
function resolveLogBackendByHand(device: DeviceInfo): LogBackend {
  if (isMacOs(device)) return 'macos';
  if (isIosFamily(device)) {
    return device.kind === 'device' ? 'ios-device' : 'ios-simulator';
  }
  return 'android';
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

test('resolveLogBackend routed through the plugin is byte-identical to the former hand branch', () => {
  for (const device of SAMPLE_DEVICES) {
    assert.equal(
      resolveLogBackend(device),
      resolveLogBackendByHand(device),
      `backend for ${device.id}`,
    );
  }
});

test('only families with an app-log backend carry the appLog facet', () => {
  // Apple owns ios + macos (SAME plugin instance); Android carries its own.
  assert.equal(getPlugin('apple'), getPlugin('apple'));
  assert.ok(getPlugin('apple').appLog, 'apple plugin exposes appLog');
  assert.ok(getPlugin('android').appLog, 'android plugin exposes appLog');
  // linux/web historically fell through to the `'android'` default; they get NO
  // facet, and the daemon lookup preserves that fallthrough (asserted below).
  assert.equal(getPlugin('linux').appLog, undefined, 'linux plugin has no appLog');
  assert.equal(getPlugin('web').appLog, undefined, 'web plugin has no appLog');
});

test('each populated appLog facet resolves the backend its family owns', () => {
  for (const device of SAMPLE_DEVICES.filter(
    (d) => isIosFamily(d) || isMacOs(d) || d.platform === 'android',
  )) {
    assert.equal(
      getPlugin(device.platform).appLog?.resolveBackend(device),
      resolveLogBackendByHand(device),
      `facet backend for ${device.id}`,
    );
  }
});

test('the factless families fall through to the historical default', () => {
  for (const device of SAMPLE_DEVICES.filter(
    (d) => d.platform === 'linux' || d.platform === 'web',
  )) {
    assert.equal(getPlugin(device.platform).appLog, undefined);
    assert.equal(resolveLogBackend(device), 'android', `fallthrough for ${device.id}`);
  }
});
