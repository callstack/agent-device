import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { runAndroidAdb } from './adb.ts';

type AndroidBroadcastPayload = {
  action?: string;
  receiver?: string;
  extras?: Record<string, unknown>;
};

export async function pushAndroidNotification(
  device: DeviceInfo,
  packageName: string,
  payload: AndroidBroadcastPayload,
): Promise<{ action: string; extrasCount: number }> {
  const action =
    typeof payload.action === 'string' && payload.action.trim()
      ? payload.action.trim()
      : `${packageName}.TEST_PUSH`;
  const args = ['shell', 'am', 'broadcast', '-a', action, '-p', packageName];
  const receiver = typeof payload.receiver === 'string' ? payload.receiver.trim() : '';
  if (receiver) {
    args.push('-n', receiver);
  }
  const rawExtras = payload.extras;
  if (
    rawExtras !== undefined &&
    (typeof rawExtras !== 'object' || rawExtras === null || Array.isArray(rawExtras))
  ) {
    throw new AppError('INVALID_ARGS', 'Android push payload extras must be an object');
  }
  const extras = rawExtras ?? {};
  let extrasCount = 0;
  for (const [key, rawValue] of Object.entries(extras)) {
    if (!key) continue;
    appendBroadcastExtra(args, key, rawValue);
    extrasCount += 1;
  }
  await runAndroidAdb(device, args);
  return { action, extrasCount };
}

function appendBroadcastExtra(args: string[], key: string, value: unknown): void {
  if (typeof value === 'string') {
    args.push('--es', key, value);
    return;
  }
  if (typeof value === 'boolean') {
    args.push('--ez', key, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      args.push('--ei', key, String(value));
      return;
    }
    args.push('--ef', key, String(value));
    return;
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported Android broadcast extra type for "${key}". Use string, boolean, or number.`,
  );
}
