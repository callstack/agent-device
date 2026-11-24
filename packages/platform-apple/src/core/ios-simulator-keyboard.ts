import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  enableSimulatorBoolPreference,
  readHostSimulatorPreferences,
} from './simulator-preferences.ts';

const KEYBOARD_PREFERENCES_DOMAIN = 'com.apple.keyboard.preferences';
// The keyboard sets each key once its sheet has been shown: the swipe-typing introduction, and the
// "Type English and <language>" tip on a keyboard with a second typing language.
const KEYBOARD_INTRO_KEYS = ['DidShowContinuousPathIntroduction', 'MultilingualKeyboardTip'];
// Longer than the accessibility write's 2 s: right after a first boot, a guest write took 8-12 s,
// and a write stopped at its timeout does not land, so the sheet would still cover the keyboard.
const KEYBOARD_INTRO_WRITE_TIMEOUT_MS = 15_000;

/**
 * Before a launch: marks the keyboard's first-use sheets as shown, because on a fresh simulator they
 * cover the keyboard on the first text entry. Writes only the keys this host's copy of the
 * preferences does not already have; a simulator this host cannot read gets both on every launch.
 * A failure only warns, so it never blocks a launch.
 */
export async function prepareIosSimulatorKeyboardIntros(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  const preferences = await readHostSimulatorPreferences(device, KEYBOARD_PREFERENCES_DOMAIN);
  const missing = KEYBOARD_INTRO_KEYS.filter((key) => !isSet(preferences?.[key]));
  await Promise.all(
    missing.map(async (key) => {
      try {
        await enableSimulatorBoolPreference(device, {
          domain: KEYBOARD_PREFERENCES_DOMAIN,
          key,
          timeoutMs: KEYBOARD_INTRO_WRITE_TIMEOUT_MS,
        });
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'ios_simulator_keyboard_intro_prepare_failed',
          data: { deviceId: device.id, key, error: normalizeError(error) },
        });
      }
    }),
  );
}

function isSet(value: unknown): boolean {
  return value === true || value === 1;
}
