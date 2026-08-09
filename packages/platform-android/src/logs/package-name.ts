import { AppError } from '@agent-device/kernel/errors';

export function assertAndroidLogPackageSafe(appBundleId: string): void {
  if (!/^[a-zA-Z0-9._:-]+$/.test(appBundleId)) {
    throw new AppError('INVALID_ARGS', `Invalid Android package name for logs: ${appBundleId}`);
  }
}
