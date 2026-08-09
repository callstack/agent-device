import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import ipaddr from 'ipaddr.js';

export async function approveDownloadSourceUrl(
  parsedUrl: URL,
  signal?: AbortSignal,
): Promise<{
  address: string;
  family: 4 | 6;
}> {
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', `Unsupported source URL protocol: ${parsedUrl.protocol}`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new AppError('INVALID_ARGS', 'Source URL credentials are not allowed');
  }
  throwIfAborted(signal);
  const hostname = canonicalHostname(parsedUrl.hostname);
  if (isBlockedSourceHostname(hostname)) blockedHost(parsedUrl.hostname);
  const literalFamily = net.isIP(hostname);
  if (literalFamily) return { address: hostname, family: literalFamily as 4 | 6 };

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookupWithSignal(hostname, signal);
  } catch (error) {
    if (error instanceof AppError && error.details?.reason === 'request_canceled') throw error;
    throw new AppError(
      'INVALID_ARGS',
      `Source URL host could not be resolved: ${hostname}`,
      { hint: 'Use a public artifact URL.' },
      error,
    );
  }
  if (resolved.length === 0) {
    throw new AppError('INVALID_ARGS', `Source URL host could not be resolved: ${hostname}`, {
      hint: 'Use a public artifact URL.',
    });
  }
  if (resolved.some((entry) => isBlockedIpAddress(entry.address))) blockedHost(hostname);
  const selected = resolved[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

async function lookupWithSignal(
  hostname: string,
  signal: AbortSignal | undefined,
): Promise<Array<{ address: string; family: number }>> {
  const lookup = dns.lookup(hostname, { all: true, verbatim: true });
  if (!signal) return await lookup;
  return await new Promise((resolve, reject) => {
    const abort = () => reject(canceledError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    void lookup.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw canceledError(signal.reason);
}

function canceledError(cause: unknown): AppError {
  return new AppError('COMMAND_FAILED', 'request canceled', { reason: 'request_canceled' }, cause);
}

export function isBlockedSourceHostname(hostname: string): boolean {
  let canonical: string;
  try {
    canonical = canonicalHostname(hostname);
  } catch {
    return true;
  }
  if (!canonical || canonical === 'localhost' || canonical.endsWith('.localhost')) return true;
  return net.isIP(canonical) !== 0 && isBlockedIpAddress(canonical);
}

export function isBlockedIpAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(stripAddressBrackets(address));
    return parsed.range() !== 'unicast';
  } catch {
    return true;
  }
}

function canonicalHostname(hostname: string): string {
  const stripped = stripAddressBrackets(hostname).toLowerCase().replace(/\.$/, '');
  if (!stripped || stripped.includes('%')) {
    throw new AppError('INVALID_ARGS', 'Source URL host is not allowed', {
      hint: 'Use a public artifact URL.',
    });
  }
  return stripped;
}

function stripAddressBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function blockedHost(hostname: string): never {
  throw new AppError(
    'INVALID_ARGS',
    `Source URL host is not allowed because it resolves to a non-public address: ${hostname}`,
    { hint: 'Use a public artifact URL.' },
  );
}
