import type { AndroidAdbProvider } from './platforms/android/adb-executor.ts';
import type {
  AndroidKeyboardDismissResult,
  AndroidKeyboardState,
} from './platforms/android/device-input-state.ts';
import type {
  LimrunAndroidDeviceSession as InternalLimrunAndroidDeviceSession,
  LimrunIosDeviceSession,
} from './providers/limrun/device-session.ts';

export type LimrunAndroidDeviceSession = Omit<
  InternalLimrunAndroidDeviceSession,
  'adb' | 'getKeyboardState' | 'dismissKeyboard'
> & {
  readonly adb: AndroidAdbProvider;
  getKeyboardState(): Promise<AndroidKeyboardState>;
  dismissKeyboard(): Promise<AndroidKeyboardDismissResult>;
};

export type LimrunDeviceSession = LimrunAndroidDeviceSession | LimrunIosDeviceSession;
