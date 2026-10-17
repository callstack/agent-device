import { androidSettingsXml, androidSnapshotHelperOutput } from './android-world.ts';
import {
  androidImeLifecycleAdbResult,
  createAndroidProviderShellState,
} from './android-ime-lifecycle-world.ts';

export function androidRepairAdbResult(
  args: readonly string[],
  shellState: ReturnType<typeof createAndroidProviderShellState>,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const ime = androidImeLifecycleAdbResult(args.join(' '), args, shellState);
  if (ime) return ime;
  if (args.join(' ') === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (args.join(' ') === 'shell dumpsys window windows') {
    return {
      stdout: 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
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
