import dns from 'node:dns/promises';
import net from 'node:net';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import ipaddr from 'ipaddr.js';

export type ApprovedPublicNetworkAddress = {
  address: string;
  family: 4 | 6;
};

export type PublicNetworkApprovalOptions = {
  signal?: AbortSignal;
  label?: string;
  hint?: string;
};

export async function approvePublicNetworkUrl(
  parsedUrl: URL,
  options: PublicNetworkApprovalOptions = {},
): Promise<ApprovedPublicNetworkAddress> {
  const label = options.label ?? 'URL';
  const displayLabel = capitalizeLabel(label);
  const hint = options.hint ?? 'Use a public URL.';
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', `Unsupported ${label} protocol: ${parsedUrl.protocol}`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new AppError('INVALID_ARGS', `${displayLabel} credentials are not allowed`);
  }
  throwIfAborted(options.signal);
  const hostname = canonicalHostname(parsedUrl.hostname, displayLabel, hint);
  if (isBlockedSourceHostname(hostname)) blockedHost(parsedUrl.hostname, displayLabel, hint);
  const literalFamily = net.isIP(hostname);
  if (literalFamily) return { address: hostname, family: literalFamily as 4 | 6 };

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookupWithSignal(hostname, options.signal);
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    throw new AppError(
      'INVALID_ARGS',
      `${displayLabel} host could not be resolved: ${hostname}`,
      { hint },
      error,
    );
  }
  if (resolved.length === 0) {
    throw new AppError('INVALID_ARGS', `${displayLabel} host could not be resolved: ${hostname}`, {
      hint,
    });
  }
  if (resolved.some((entry) => isBlockedIpAddress(entry.address))) {
    blockedHost(hostname, displayLabel, hint);
  }
  const selected = resolved[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export function isBlockedSourceHostname(hostname: string): boolean {
  let canonical: string;
  try {
    canonical = canonicalHostname(hostname, 'Source URL', 'Use a public artifact URL.');
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
  return createRequestCanceledError(undefined, cause);
}

function canonicalHostname(hostname: string, label: string, hint: string): string {
  const stripped = stripAddressBrackets(hostname).toLowerCase().replace(/\.$/, '');
  if (!stripped || stripped.includes('%')) {
    throw new AppError('INVALID_ARGS', `${label} host is not allowed`, { hint });
  }
  return stripped;
}

function blockedHost(hostname: string, label: string, hint: string): never {
  throw new AppError(
    'INVALID_ARGS',
    `${label} host is not allowed because it resolves to a non-public address: ${hostname}`,
    { hint },
  );
}

function capitalizeLabel(label: string): string {
  return label.length === 0 ? label : `${label[0]!.toUpperCase()}${label.slice(1)}`;
}

function stripAddressBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}
