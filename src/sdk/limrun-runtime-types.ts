import type {
  AndroidAdbProvider,
  AndroidKeyboardDismissResult,
  AndroidKeyboardState,
} from '@agent-device/platform-android/mechanics';
import type {
  LimrunAndroidDeviceSession as InternalLimrunAndroidDeviceSession,
  LimrunIosDeviceSession,
} from '@agent-device/provider-limrun';

export type LimrunAndroidDeviceSession = Omit<
  InternalLimrunAndroidDeviceSession,
  'adb' | 'getKeyboardState' | 'dismissKeyboard'
> & {
  readonly adb: AndroidAdbProvider;
  getKeyboardState(): Promise<AndroidKeyboardState>;
  dismissKeyboard(): Promise<AndroidKeyboardDismissResult>;
};

export type LimrunDeviceSession = LimrunAndroidDeviceSession | LimrunIosDeviceSession;
