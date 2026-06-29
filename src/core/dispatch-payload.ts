import { promises as fs } from 'node:fs';
import { AppError } from '../kernel/errors.ts';
import { resolvePayloadInput } from '../utils/payload-input.ts';

export async function readNotificationPayload(
  payloadArg: string,
): Promise<Record<string, unknown>> {
  const source = resolvePayloadInput(payloadArg, { subject: 'Push payload' });
  const payloadText =
    source.kind === 'inline' ? source.text : await readPushPayloadFile(source.path);
  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('INVALID_ARGS', 'push payload must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_ARGS', `Invalid push payload JSON: ${payloadArg}`);
  }
}

async function readPushPayloadFile(payloadPath: string): Promise<string> {
  try {
    return await fs.readFile(payloadPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new AppError('INVALID_ARGS', `Push payload file not found: ${payloadPath}`);
    }
    if (code === 'EISDIR') {
      throw new AppError('INVALID_ARGS', `Push payload path is not a file: ${payloadPath}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError('INVALID_ARGS', `Push payload file is not readable: ${payloadPath}`);
    }
    throw new AppError('COMMAND_FAILED', `Unable to read push payload file: ${payloadPath}`, {
      cause: String(error),
    });
  }
}
