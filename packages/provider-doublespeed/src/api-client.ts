import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';

export const DOUBLESPEED_DEFAULT_API_URL = 'https://api.mac.doublespeed.ai';
export const DOUBLESPEED_CLIENT_HEADER = 'agent-device-cli';

const REQUEST_TIMEOUT_MS = 90_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const SIMULATOR_READY_TIMEOUT_MS = 10 * 60_000;
const SIMULATORS_PATH = '/v1/xcode/simulators';
const ASSETS_PATH = '/v1/xcode/assets';

export type DoublespeedSimulatorStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type DoublespeedSimulator = {
  id: string;
  status: DoublespeedSimulatorStatus;
  ready: boolean;
  device: string;
  labels: Record<string, string>;
  api_url: string | null;
  token: string | null;
  viewer_url: string | null;
  screen: { width: number; height: number; scale: number } | null;
  expires_at: string | null;
  error: { code: string; message: string } | null;
};

export type DoublespeedAssetRegistration = {
  sha256: string;
  exists: boolean;
  upload_url: string | null;
  download_url: string | null;
};

export type DoublespeedClientOptions = {
  apiKey: string;
  apiUrl?: string;
  clientVersion: string;
  fetch?: typeof fetch;
};

function doublespeedClientHeaders(options: {
  apiKey: string;
  clientVersion: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    'x-agent-device-client': DOUBLESPEED_CLIENT_HEADER,
    'x-agent-device-version': options.clientVersion,
  };
}

function resolveDoublespeedApiUrl(apiUrl: string | undefined): string {
  return (apiUrl?.trim() || DOUBLESPEED_DEFAULT_API_URL).replace(/\/+$/, '');
}

/** The control-plane half of the provider: simulator sessions and content-addressed app assets. */
export class DoublespeedApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DoublespeedClientOptions) {
    this.baseUrl = resolveDoublespeedApiUrl(options.apiUrl);
    this.headers = doublespeedClientHeaders(options);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createSimulator(
    input: { device?: string; labels: Record<string, string>; idleTimeoutSeconds?: number },
    signal?: AbortSignal,
  ): Promise<DoublespeedSimulator> {
    const created = await this.request<DoublespeedSimulator>(
      'POST',
      SIMULATORS_PATH,
      {
        ...(input.device ? { device: input.device } : {}),
        labels: input.labels,
        ...(input.idleTimeoutSeconds ? { idle_timeout_seconds: input.idleTimeoutSeconds } : {}),
        wait: true,
      },
      signal,
    );
    return await this.awaitReady(created, signal);
  }

  async getSimulator(
    id: string,
    options?: { wait?: boolean; signal?: AbortSignal },
  ): Promise<DoublespeedSimulator> {
    const suffix = options?.wait ? '?wait=1' : '';
    return await this.request<DoublespeedSimulator>(
      'GET',
      `${SIMULATORS_PATH}/${encodeURIComponent(id)}${suffix}`,
      undefined,
      options?.signal,
    );
  }

  async listSimulators(
    labels: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<DoublespeedSimulator[]> {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const query = selector ? `?label_selector=${encodeURIComponent(selector)}` : '';
    const page = await this.request<{ simulators: DoublespeedSimulator[] }>(
      'GET',
      `${SIMULATORS_PATH}${query}`,
      undefined,
      signal,
    );
    return page.simulators;
  }

  async deleteSimulator(id: string, signal?: AbortSignal): Promise<void> {
    await this.request('DELETE', `${SIMULATORS_PATH}/${encodeURIComponent(id)}`, undefined, signal);
  }

  async registerAsset(
    input: { sha256: string; size: number; name: string },
    signal?: AbortSignal,
  ): Promise<DoublespeedAssetRegistration> {
    return await this.request<DoublespeedAssetRegistration>('POST', ASSETS_PATH, input, signal);
  }

  async completeAsset(
    sha256: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<DoublespeedAssetRegistration> {
    return await this.request<DoublespeedAssetRegistration>(
      'POST',
      `${ASSETS_PATH}/${sha256}/complete`,
      { size },
      signal,
    );
  }

  /** The signed upload URL is the capability; it carries no account credential. */
  async uploadAsset(uploadUrl: string, filePath: string, signal?: AbortSignal): Promise<void> {
    const body = await fs.promises.readFile(filePath);
    const response = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body,
      signal: boundedSignal(UPLOAD_TIMEOUT_MS, signal),
    });
    if (!response.ok) {
      throw new AppError('COMMAND_FAILED', 'Doublespeed asset upload was rejected.', {
        status: response.status,
      });
    }
  }

  private async awaitReady(
    simulator: DoublespeedSimulator,
    signal?: AbortSignal,
  ): Promise<DoublespeedSimulator> {
    const deadline = Date.now() + SIMULATOR_READY_TIMEOUT_MS;
    let current = simulator;
    while (!current.ready) {
      if (!isLiveSimulatorStatus(current.status)) {
        throw new AppError('COMMAND_FAILED', 'Doublespeed simulator did not become ready.', {
          simulatorId: current.id,
          status: current.status,
          ...(current.error ? { providerError: current.error } : {}),
        });
      }
      if (Date.now() > deadline) {
        throw new AppError('COMMAND_FAILED', 'Timed out waiting for a Doublespeed simulator.', {
          simulatorId: current.id,
          status: current.status,
        });
      }
      current = await this.getSimulator(current.id, { wait: true, signal });
    }
    return current;
  }

  private async request<Result>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: boundedSignal(REQUEST_TIMEOUT_MS, signal),
    });
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string } }
      | undefined;
    if (!response.ok) throw doublespeedApiError(response.status, payload?.error);
    return payload as Result;
  }
}

function isLiveSimulatorStatus(status: DoublespeedSimulatorStatus): boolean {
  return status === 'queued' || status === 'preparing' || status === 'running';
}

function doublespeedApiError(
  status: number,
  error: { code?: string; message?: string } | undefined,
): AppError {
  const details = { status, ...(error?.code ? { providerCode: error.code } : {}) };
  if (status === 401 || status === 403) {
    return new AppError('UNAUTHORIZED', 'Doublespeed rejected the API key.', {
      ...details,
      hint: 'Check DOUBLESPEED_API_KEY and its organization access.',
    });
  }
  if (status === 402) {
    return new AppError(
      'COMMAND_FAILED',
      'Doublespeed refused the request: insufficient credits.',
      {
        ...details,
        hint: 'Add credits at https://mac.doublespeed.ai/dashboard/billing and retry.',
      },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Doublespeed request failed: ${error?.message ?? `HTTP ${status}`}`,
    details,
  );
}

export function boundedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
