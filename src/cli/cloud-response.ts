import { AppError } from '@agent-device/kernel/errors';

export async function readCloudJsonResponse<T>(
  response: Response,
  options: {
    invalidJsonMessage: string;
    rejectedMessage: string;
  },
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const status = response.status;
    const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : 'COMMAND_FAILED';
    throw new AppError(code, options.rejectedMessage, {
      status,
      ...(status === 429 || status >= 500
        ? { retriable: true, hint: 'Retry the request later. Do not sign in again.' }
        : {}),
    });
  }
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError('COMMAND_FAILED', options.invalidJsonMessage, { status: response.status });
    }
  }
  return parsed as T;
}
