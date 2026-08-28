import { requireAndroidAdbHost, runAndroidHostAdb } from './adb-host.ts';

export { activateAndroidTestIme } from './ime-activation.ts';
export {
  restoreAndroidTestIme,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
} from './ime-restore.ts';
export {
  ANDROID_TEST_IME_SETTINGS_KEYS,
  readAndroidDefaultInputMethod,
} from './ime-settings-record.ts';
export {
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from './ime-state.ts';

// Serials only, with no full-inventory name, boot-state, or target probes.
export async function listAndroidAdbSerialsQuick(): Promise<string[]> {
  requireAndroidAdbHost();
  try {
    const result = await runAndroidHostAdb(['devices'], { timeoutMs: 5_000 });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('List of devices'))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts[1] === 'device')
      .map((parts) => parts[0] as string);
  } catch {
    return [];
  }
}
