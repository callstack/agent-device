import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { readHostSimulatorPreferences } from './simulator-host-preferences.ts';
import { runXcrun } from './tool-provider.ts';

const KEYBOARD_PREFERENCES_DOMAIN = 'com.apple.keyboard.preferences';
// The keyboard sets each key once its sheet has been shown: the swipe-typing introduction, and the
// "Type English and <language>" tip on a keyboard with a second typing language.
const KEYBOARD_INTRO_KEYS = ['DidShowContinuousPathIntroduction', 'MultilingualKeyboardTip'];
const KEYBOARD_INTRO_WRITE_TIMEOUT_MS = 5_000;

/**
 * Before a launch: marks the keyboard's first-use sheets as shown, because on a fresh simulator they
 * cover the keyboard on the first text input. Writes only the keys this host's copy of the
 * preferences does not already have, and a failure only warns, so it never blocks a launch.
 */
export async function prepareIosSimulatorKeyboardIntros(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  const preferences = await readHostSimulatorPreferences(device, KEYBOARD_PREFERENCES_DOMAIN);
  const missing = KEYBOARD_INTRO_KEYS.filter((key) => preferences?.[key] !== true);
  const results = await Promise.allSettled(
    missing.map((key) =>
      runXcrun(
        buildSimctlArgsForDevice(device, [
          'spawn',
          device.id,
          'defaults',
          'write',
          KEYBOARD_PREFERENCES_DOMAIN,
          key,
          '-bool',
          'YES',
        ]),
        { timeoutMs: KEYBOARD_INTRO_WRITE_TIMEOUT_MS },
      ),
    ),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_simulator_keyboard_intro_prepare_failed',
      data: { deviceId: device.id, error: normalizeError(result.reason) },
    });
  }
}
