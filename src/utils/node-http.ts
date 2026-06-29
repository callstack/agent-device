import type { IncomingMessage } from 'node:http';
import { AppError } from '../kernel/errors.ts';

export function readNodeHttpResponseBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

export async function readNodeHttpRequestBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  tooLargeMessage: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > maxBodyBytes) {
      throw new AppError('INVALID_ARGS', tooLargeMessage);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
