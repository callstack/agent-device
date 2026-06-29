import { URL } from 'node:url';
import type { SessionRuntimeHints } from '../contracts.ts';
import { AppError } from '../kernel/errors.ts';

export type ResolvedRuntimeTransport = {
  host: string;
  port: number;
  scheme: 'http' | 'https';
};

export function resolveRuntimeTransportHints(
  runtime: SessionRuntimeHints | undefined,
): ResolvedRuntimeTransport | undefined {
  if (!runtime) return undefined;

  let host = trimRuntimeValue(runtime.metroHost);
  let port = normalizePort(runtime.metroPort);
  let scheme: 'http' | 'https' = 'http';
  const bundleUrl = trimRuntimeValue(runtime.bundleUrl);
  if (bundleUrl) {
    let parsed: URL;
    try {
      parsed = new URL(bundleUrl);
    } catch (error) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid runtime bundle URL: ${bundleUrl}`,
        {},
        error as Error,
      );
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      host ??= trimRuntimeValue(parsed.hostname);
      port ??= normalizePort(
        parsed.port.length > 0 ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol),
      );
      scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    }
  }

  if (!host || !port) return undefined;
  return { host, port, scheme };
}

export function trimRuntimeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizePort(value: number | undefined): number | undefined {
  if (!Number.isInteger(value)) return undefined;
  if ((value as number) <= 0 || (value as number) > 65_535) return undefined;
  return value;
}

function defaultPortForProtocol(protocol: string): number | undefined {
  if (protocol === 'https:') return 443;
  if (protocol === 'http:') return 80;
  return undefined;
}
