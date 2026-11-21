import { androidSettingsXml, androidSnapshotHelperOutput } from './android-world.ts';
import {
  androidImeLifecycleAdbResult,
  createAndroidProviderShellState,
} from './android-ime-lifecycle-world.ts';

// Shell states whose Settings app was force-stopped and not started since.
const stoppedSettings = new WeakSet<object>();

export function androidRepairAdbResult(
  args: readonly string[],
  shellState: ReturnType<typeof createAndroidProviderShellState>,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  if (args.join(' ') === 'shell am force-stop com.android.settings') {
    stoppedSettings.add(shellState);
  } else if (args[0] === 'shell' && args[1] === 'am' && args[2]?.startsWith('start')) {
    stoppedSettings.delete(shellState);
  }
  const ime = androidImeLifecycleAdbResult(args.join(' '), args, shellState);
  if (ime) return ime;
  if (args.join(' ') === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (args.join(' ') === 'shell dumpsys window windows') {
    return {
      stdout: stoppedSettings.has(shellState)
        ? 'mCurrentFocus=null\n'
        : 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (args.join(' ').startsWith('shell am instrument ')) {
    return {
      stdout: androidSnapshotHelperOutput(androidSettingsXml('Display')),
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}
