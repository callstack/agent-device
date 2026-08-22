import { assertCommandCall } from './assertions.ts';
import type { createAndroidSettingsWorld } from './android-world.ts';

type AndroidSettingsWorld = Awaited<ReturnType<typeof createAndroidSettingsWorld>>;

/**
 * The adb evidence the Android settings flow must leave behind: the appearance, location,
 * fingerprint, permission, animation-scale, and network mutations each named with the exact
 * argv the provider saw. Extracted from `android-lifecycle.test.ts`, which sits over the
 * test-file tripwire (`scripts/__tests__/test-file-size-ratchet.test.ts`).
 */
export function assertAndroidSettingsContract(world: AndroidSettingsWorld): void {
  const { adbCalls } = world;
  assertCommandCall(adbCalls, ['shell', 'cmd', 'uimode', 'night', 'yes']);
  assertCommandCall(adbCalls, ['emu', 'geo', 'fix', '-122.009', '37.3349']);
  assertCommandCall(adbCalls, ['shell', 'cmd', 'fingerprint', 'touch', '1']);
  // #1796: the grant names the acting user, because `pm` would otherwise default to user 0
  // rather than the foreground user the session's app runs as.
  assertCommandCall(adbCalls, ['shell', 'am', 'get-current-user']);
  assertCommandCall(adbCalls, [
    'shell',
    'pm',
    'grant',
    '--user',
    '0',
    'com.example.demo',
    'android.permission.CAMERA',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'global',
    'window_animation_scale',
    '0',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'global',
    'transition_animation_scale',
    '0',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'global',
    'animator_duration_scale',
    '0',
  ]);
  assertCommandCall(adbCalls, ['shell', 'echo', 'ok']);
}
