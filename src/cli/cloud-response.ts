import { AppError } from '@agent-device/kernel/errors';

export async function readCloudJsonResponse<T>(
  response: Response,
  options: {
    invalidJsonMessage: string;
    rejectedMessage: string;
    // Reads a caller's own markers out of a response that is not JSON and answers with its own
    // failure. A rejected HTTP status means nothing until this has run, so a marker the caller
    // classifies outranks the generic status rejection.
    classifyRejectedBody?: (parsed: unknown) => AppError | undefined;
  },
): Promise<T> {
  const text = await response.text();
  const status = response.status;
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Only a body that cannot be read can hold a marker, so a body that is not JSON is read as one
      // that carries none, and the status below still refuses the request.
      if (response.ok) throw new AppError('COMMAND_FAILED', options.invalidJsonMessage, { status });
    }
  }
  if (!response.ok) {
    // A marker the caller recognizes is its answer to this request, so it is read before the status
    // is rejected generically. The failure it raises is the caller's own: no body text is copied.
    const classified = options.classifyRejectedBody?.(parsed);
    if (classified) throw classified;
    const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : 'COMMAND_FAILED';
    throw new AppError(code, options.rejectedMessage, {
      status,
      ...(status === 429 || status >= 500
        ? { retriable: true, hint: 'Retry the request later. Do not sign in again.' }
        : {}),
    });
  }
  return parsed as T;
}

export function asCloudRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isCloudText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isCloudTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isCloudText);
}

export async function fetchCloudApi(
  url: URL,
  init: RequestInit,
  options?: { preserveCause?: boolean },
): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error' });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Could not reach the cloud session API.',
      { hint: 'Verify the cloud API origin and network connection before retrying.' },
      options?.preserveCause ? error : undefined,
    );
  }
}

export function containsCloudCredential(value: unknown, credentials: readonly string[]): boolean {
  const json = JSON.stringify(value);
  return (
    json !== undefined &&
    credentials.some((credential) => json.includes(JSON.stringify(credential).slice(1, -1)))
  );
}

export function cloudUrlContainsCredential(value: string, credentials: readonly string[]): boolean {
  let url = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (containsCloudCredential(url, credentials)) return true;
    if (!/%[0-9a-f]{2}/i.test(url)) return false;
    try {
      url = decodeURIComponent(url);
    } catch {
      return true;
    }
  }
  return true;
}
