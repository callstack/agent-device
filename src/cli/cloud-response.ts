import { AppError } from '../kernel/errors.ts';

export async function readCloudJsonResponse<T>(
  response: Response,
  options: {
    invalidJsonMessage: string;
    rejectedMessage: string;
  },
): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AppError(
        'COMMAND_FAILED',
        options.invalidJsonMessage,
        { status: response.status },
        error instanceof Error ? error : undefined,
      );
    }
  }
  if (!response.ok) {
    throw new AppError('UNAUTHORIZED', options.rejectedMessage, {
      status: response.status,
      response: parsed,
    });
  }
  return parsed as T;
}
