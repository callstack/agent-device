import { AppError } from '@agent-device/kernel/errors';
import { resolveProxyForUrl } from '@agent-device/provision-kit/install-source-network-transport';
import net from 'node:net';
import { Agent, Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';
import { approveDownloadSourceUrl } from '@agent-device/provision-kit/install-source-network';

export const MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;

export type RunScriptHttpRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  publicNetworkOnly: boolean;
};

export type RunScriptHttpResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export async function executeRunScriptHttpRequest(
  input: RunScriptHttpRequest,
): Promise<RunScriptHttpResponse> {
  if (!input.publicNetworkOnly) return await executeLocalRequest(input);
  return await executePublicRequest(input);
}

async function executeLocalRequest(input: RunScriptHttpRequest): Promise<RunScriptHttpResponse> {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is required for Maestro runScript http helpers');
  }
  const response = await fetch(input.url, fetchInit(input));
  return await serializeResponse(response);
}

async function executePublicRequest(input: RunScriptHttpRequest): Promise<RunScriptHttpResponse> {
  const initialUrl = parsePublicUrl(input.url);
  const signal = AbortSignal.timeout(30_000);
  const dispatcher = new PublicFetchDispatcher(initialUrl.protocol === 'https:', signal);
  try {
    const response = await undiciFetch(initialUrl, {
      ...fetchInit(input),
      dispatcher,
      signal,
    });
    return await serializeResponse(
      response as unknown as Response,
      MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES,
    );
  } catch (error) {
    if (error instanceof TypeError && error.cause instanceof AppError) throw error.cause;
    throw error;
  } finally {
    await dispatcher.dispose();
  }
}

function fetchInit(input: RunScriptHttpRequest) {
  return {
    method: input.method,
    headers: input.headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
}

export class PublicFetchDispatcher extends Dispatcher {
  readonly #dispatchers = new Set<Dispatcher>();
  #httpsRequired: boolean;
  readonly #signal: AbortSignal;

  constructor(httpsRequired: boolean, signal: AbortSignal) {
    super();
    this.#httpsRequired = httpsRequired;
    this.#signal = signal;
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    void this.dispatchApproved(options, handler).catch((error: unknown) => {
      handler.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    return true;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#dispatchers].map(async (dispatcher) => await dispatcher.close()));
  }

  private async dispatchApproved(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): Promise<void> {
    const url = dispatchUrl(options);
    if (this.#httpsRequired && url.protocol !== 'https:') {
      throw new AppError('COMMAND_FAILED', 'Maestro runScript HTTP redirect downgraded HTTPS');
    }
    if (url.protocol === 'https:') this.#httpsRequired = true;
    const approved = await approveDownloadSourceUrl(url, this.#signal);
    const proxyUrl = resolveProxyForUrl(url);
    const dispatcher = proxyUrl
      ? proxyDispatcher(proxyUrl, url)
      : directDispatcher(approved.address, approved.family);
    this.#dispatchers.add(dispatcher);
    dispatcher.dispatch(
      proxyUrl ? proxyDispatchOptions(options, url, approved.address, approved.family) : options,
      handler,
    );
  }
}

function directDispatcher(address: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    },
  });
}

function proxyDispatcher(proxyUrl: string, destination: URL): ProxyAgent {
  const hostname = stripAddressBrackets(destination.hostname);
  return new ProxyAgent({
    uri: proxyUrl,
    proxyTunnel: true,
    requestTls:
      destination.protocol === 'https:' && net.isIP(hostname) === 0
        ? { servername: hostname }
        : undefined,
  });
}

function proxyDispatchOptions(
  options: Dispatcher.DispatchOptions,
  originalUrl: URL,
  address: string,
  family: 4 | 6,
): Dispatcher.DispatchOptions {
  const approved = new URL(originalUrl);
  approved.hostname = family === 6 ? `[${stripAddressBrackets(address)}]` : address;
  const headers = Array.isArray(options.headers)
    ? [...options.headers, 'host', originalUrl.host]
    : { ...options.headers, host: originalUrl.host };
  return { ...options, origin: approved.origin, headers };
}

function stripAddressBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function dispatchUrl(options: Dispatcher.DispatchOptions): URL {
  if (!options.origin) throw new AppError('INVALID_ARGS', 'Invalid Maestro runScript HTTP URL');
  return new URL(options.path, options.origin);
}

function parsePublicUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new AppError('INVALID_ARGS', 'Invalid Maestro runScript HTTP URL');
  }
}

async function serializeResponse(
  response: Response,
  maxBodyBytes?: number,
): Promise<RunScriptHttpResponse> {
  return {
    status: response.status,
    body: await readResponseBody(response, maxBodyBytes),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function readResponseBody(response: Response, maxBodyBytes?: number): Promise<string> {
  if (maxBodyBytes === undefined) return await response.text();
  const chunks: Uint8Array[] = [];
  let bytesSeen = 0;
  const reader = response.body?.getReader();
  if (!reader) return '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesSeen += value.byteLength;
    if (bytesSeen > maxBodyBytes) {
      await reader.cancel();
      throw new AppError(
        'COMMAND_FAILED',
        `Maestro runScript HTTP response exceeded ${maxBodyBytes} bytes`,
        { limitBytes: maxBodyBytes, status: response.status },
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytesSeen).toString('utf8');
}
