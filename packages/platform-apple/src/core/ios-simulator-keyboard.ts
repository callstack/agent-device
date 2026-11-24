import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { buildSimctlArgsForDevice, simulatorAddressFor } from './simctl.ts';
import { readHostSimulatorPreferences } from './simulator-host-preferences.ts';
import { hasScopedAppleToolProvider, runXcrun } from './tool-provider.ts';

const KEYBOARD_PREFERENCES_DOMAIN = 'com.apple.keyboard.preferences';
// The keyboard sets each key once its sheet has been shown: the swipe-typing introduction, and the
// "Type English and <language>" tip on a keyboard with a second typing language.
const KEYBOARD_INTRO_KEYS = ['DidShowContinuousPathIntroduction', 'MultilingualKeyboardTip'];
// Longer than the accessibility write's 2 s: right after a first boot, a guest write took 8-12 s,
// and a write that runs out of time leaves the sheet to appear on the first text entry.
const KEYBOARD_INTRO_WRITE_TIMEOUT_MS = 15_000;

// Keys written to simulators this host cannot read (a scoped, remote tool provider), so a later
// open skips them. Only an erase resets them, and agent-device never erases a simulator.
const writtenRemoteKeys = new Map<string, Set<string>>();

/**
 * Before a launch: marks the keyboard's first-use sheets as shown, because on a fresh simulator they
 * cover the keyboard on the first text entry. Writes only the keys this host's copy of the
 * preferences does not already have, and a failure only warns, so it never blocks a launch.
 */
export async function prepareIosSimulatorKeyboardIntros(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  const preferences = await readHostSimulatorPreferences(device, KEYBOARD_PREFERENCES_DOMAIN);
  const { udid, simulatorSetPath } = simulatorAddressFor(device);
  const remoteKey = `${simulatorSetPath ?? ''}/${udid}`;
  const remoteWritten = hasScopedAppleToolProvider()
    ? (writtenRemoteKeys.get(remoteKey) ?? new Set<string>())
    : undefined;
  const missing = KEYBOARD_INTRO_KEYS.filter(
    (key) => !isSet(preferences?.[key]) && !remoteWritten?.has(key),
  );
  await Promise.all(
    missing.map(async (key) => {
      try {
        await runXcrun(
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
        );
        remoteWritten?.add(key);
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'ios_simulator_keyboard_intro_prepare_failed',
          data: { deviceId: device.id, key, error: normalizeError(error) },
        });
      }
    }),
  );
  if (remoteWritten?.size) writtenRemoteKeys.set(remoteKey, remoteWritten);
}

function isSet(value: unknown): boolean {
  return value === true || value === 1;
}
