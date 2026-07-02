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
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/index.ts';
import { getPlugin, tryGetPlugin } from '../../core/platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';
import {
  resolveRecordingBackendForDevice,
  type RecordingBackendTag,
} from '../handlers/record-trace-recording-backends.ts';

// Phase 3 step b.3 (issue #974) parity gate for the daemon recording facet. The
// per-platform branch of `resolveRecordingBackendForDevice` now flows through the
// PlatformPlugin `recording.resolveBackendTag` facet (mapped daemon-side back to the
// concrete backend instance) instead of a hand branch. An INDEPENDENT verbatim copy
// of the former branch below is the BEFORE oracle: a plugin-vs-branch disagreement on
// any sample device fails this test. (Mirrors the verbatim-copy discipline in
// daemon/__tests__/applog-plugin-routing-parity.test.ts.)

registerBuiltinPlatformPlugins();

// --- INDEPENDENT verbatim copy of the former `resolveRecordingBackendForDevice`
// branch, expressed as the backend TAG each arm returned ---
function recordingBackendTagByHand(device: DeviceInfo): RecordingBackendTag {
  if (device.platform === 'web') return 'web';
  if (device.platform === 'android') return 'android';
  if (isMacOs(device)) return 'macos';
  if (isIosFamily(device) && device.kind === 'device') return 'ios-device';
  if (isIosFamily(device)) return 'ios-simulator';
  return 'unsupported';
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

// The hand-authored fixtures (the real discovery shapes, incl. macOS / iOS-device /
// iOS-sim / tvOS / iPadOS / visionOS / android / web / linux) plus the exhaustive
// synthetic cross-product, so every off-nominal combination is pinned too.
const SAMPLE_DEVICES: DeviceInfo[] = [
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
  ...buildDeviceMatrix(),
];

test('recording.resolveBackendTag facet is byte-identical to the former hand branch tag', () => {
  for (const device of SAMPLE_DEVICES) {
    const facet = tryGetPlugin(device.platform)?.recording;
    if (!facet) continue; // linux carries no facet; the fallthrough is asserted below
    assert.equal(
      facet.resolveBackendTag(device),
      recordingBackendTagByHand(device),
      `facet tag for ${device.id}`,
    );
  }
});

test('resolveRecordingBackendForDevice partitions devices identically to the former hand branch', () => {
  // Table-equivalence WITHOUT exporting the module-private backend instances: two
  // devices that hand-resolve to the SAME tag must route to the SAME backend instance,
  // and distinct tags must route to distinct instances. Combined with the facet-tag
  // parity above and the daemon's exhaustive tag->backend map, this pins the routed
  // instance per device byte-for-byte.
  const instanceByTag = new Map<
    RecordingBackendTag,
    ReturnType<typeof resolveRecordingBackendForDevice>
  >();
  for (const device of SAMPLE_DEVICES) {
    const tag = recordingBackendTagByHand(device);
    const backend = resolveRecordingBackendForDevice(device);
    const seen = instanceByTag.get(tag);
    if (seen) {
      assert.equal(backend, seen, `same backend instance for tag '${tag}' (${device.id})`);
    } else {
      instanceByTag.set(tag, backend);
    }
  }
  const instances = [...instanceByTag.values()];
  assert.equal(
    new Set(instances).size,
    instances.length,
    'each distinct tag maps to a distinct backend instance',
  );
});

test('only families with a recording backend carry the recording facet', () => {
  // Apple owns ios + macos (SAME plugin instance); Android + web carry their own.
  assert.equal(getPlugin('apple'), getPlugin('apple'));
  assert.ok(getPlugin('apple').recording, 'apple plugin exposes recording');
  assert.ok(getPlugin('android').recording, 'android plugin exposes recording');
  assert.ok(getPlugin('web').recording, 'web plugin exposes recording');
  // linux historically fell through to the unsupported backend; it gets NO facet, and
  // the daemon lookup preserves that fallthrough (asserted below).
  assert.equal(getPlugin('linux').recording, undefined, 'linux plugin has no recording');
});

test('the factless family (linux) falls through to the unsupported backend', () => {
  assert.equal(tryGetPlugin('linux')?.recording, undefined);
  assert.equal(recordingBackendTagByHand(LINUX_DEVICE), 'unsupported');
  const linuxBackend = resolveRecordingBackendForDevice(LINUX_DEVICE);
  // The routed linux backend is distinct from every family-owned backend; since the
  // daemon's tag->backend map is exhaustive over the 6 tags and the other 5 are proven
  // above, the remaining distinct instance is necessarily `unsupportedRecordingBackend`.
  for (const device of [
    WEB_DESKTOP_DEVICE,
    ANDROID_EMULATOR,
    MACOS_DEVICE,
    IOS_DEVICE,
    IOS_SIMULATOR,
  ]) {
    assert.notEqual(
      linuxBackend,
      resolveRecordingBackendForDevice(device),
      `linux (unsupported) backend must differ from ${device.id}`,
    );
  }
});
