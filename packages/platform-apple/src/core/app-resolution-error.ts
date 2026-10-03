import { AppError } from '@agent-device/kernel/errors';

export function buildAppNotInstalledError(app: string): AppError {
  return new AppError('APP_NOT_INSTALLED', `No app found matching "${app}"`);
}
