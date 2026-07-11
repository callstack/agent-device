import { requireNativeModule } from 'expo-modules-core';

type DevMenuPreferencesModule = {
  setPreferencesAsync(settings: {
    motionGestureEnabled: boolean;
    touchGestureEnabled: boolean;
  }): Promise<void>;
};

/** Keep development-shell shortcuts from intercepting the gesture canary's pointer streams. */
export async function disableDevelopmentGestureInterceptors(): Promise<void> {
  if (!__DEV__) {
    return;
  }

  const preferences = requireNativeModule<DevMenuPreferencesModule>('DevMenuPreferences');
  await preferences.setPreferencesAsync({
    motionGestureEnabled: false,
    touchGestureEnabled: false,
  });
}
