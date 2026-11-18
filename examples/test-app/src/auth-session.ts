import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

// The callback scheme the fixture registers in app.config.js. A real IdP redirect lands here, so
// the sheet closing with a callback to this scheme is the observable end of the flow.
export const AUTH_SESSION_CALLBACK_SCHEME = 'agent-device-test-app';

type AuthSessionLabModule = {
  startSignInAsync(url: string, callbackScheme: string): Promise<string>;
};

const authSessionLab =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<AuthSessionLabModule>('AuthSessionLab')
    : null;

export function isAuthSessionLabAvailable(): boolean {
  return authSessionLab !== null;
}

/**
 * Opens the system sign-in sheet for `url` and resolves with the callback URL the fixture IdP
 * redirected to. Rejects when the sheet is canceled or fails.
 */
export async function startFixtureSignInSession(url: string): Promise<string> {
  if (!authSessionLab) {
    throw new Error('Rebuild the iOS development client to include AuthSessionLab.');
  }

  return authSessionLab.startSignInAsync(url, AUTH_SESSION_CALLBACK_SCHEME);
}
