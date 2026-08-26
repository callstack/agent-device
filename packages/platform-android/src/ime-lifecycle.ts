// The `ime-lifecycle` entry surface, kept for the root shim and the transitional #2041
// consumers. The implementation lives in focused owners: `ime-state.ts` (process-lived
// ownership + recovery lock), `ime-settings-record.ts` (on-device restore record),
// `ime-activation.ts` (the activation transaction), and `ime-restore.ts` (restore + startup
// orphan recovery).

import { requireAndroidAdbHost } from './adb-host.ts';

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
  // Resolved outside the try: an unbound host port is a wiring bug and must stay loud, while a
  // failed adb execution legitimately reads as "no devices".
  const host = requireAndroidAdbHost();
  try {
    const result = await host.execHostAdb(['devices'], { timeoutMs: 5_000 });
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
