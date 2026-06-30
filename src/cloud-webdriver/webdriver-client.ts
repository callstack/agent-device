import fs from 'node:fs/promises';
import { AppError } from '../kernel/errors.ts';
import { agentDeviceRequestHeaders } from './request-headers.ts';

export type WebDriverAuth = {
  username: string;
  accessKey: string;
};

export type WebDriverClientOptions = {
  endpoint: string | URL;
  auth?: WebDriverAuth;
  headers?: Record<string, string>;
  requestPolicy?: WebDriverRequestPolicy;
};

export type WebDriverRequestPolicy = {
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
};

export type WebDriverSession = {
  sessionId: string;
  capabilities: Record<string, unknown>;
};

export type W3CActionSequence = {
  type: 'pointer' | 'key' | 'wheel';
  id: string;
  parameters?: Record<string, unknown>;
  actions: Record<string, unknown>[];
};

type WebDriverResponse = {
  value?: unknown;
  sessionId?: string;
};

type WebDriverRequestOverrides = {
  retryAttempts?: number;
};

export class WebDriverClient {
  private readonly endpoint: URL;
  private readonly headers: Record<string, string>;
  private readonly requestPolicy: Required<WebDriverRequestPolicy>;
  private sessionId: string | undefined;

  constructor(options: WebDriverClientOptions) {
    this.endpoint = withTrailingSlash(new URL(options.endpoint));
    this.headers = {
      ...agentDeviceRequestHeaders(),
      ...(options.auth ? { Authorization: basicAuth(options.auth) } : {}),
      ...options.headers,
    };
    this.requestPolicy = {
      timeoutMs: options.requestPolicy?.timeoutMs ?? 30_000,
      retryAttempts: options.requestPolicy?.retryAttempts ?? 1,
      retryDelayMs: options.requestPolicy?.retryDelayMs ?? 250,
    };
  }

  async createSession(capabilities: Record<string, unknown>): Promise<WebDriverSession> {
    const value = await this.requestValue('POST', '/session', {
      capabilities: normalizeCapabilities(capabilities),
    });
    const session = readSession(value);
    this.sessionId = session.sessionId;
    return session;
  }

  // fallow-ignore-next-line unused-class-member
  async deleteSession(): Promise<void> {
    const sessionId = this.requireSessionId();
    await this.requestValue('DELETE', `/session/${sessionId}`);
    this.sessionId = undefined;
  }

  // fallow-ignore-next-line unused-class-member
  async installApp(appPath: string): Promise<void> {
    await this.sessionRequest('POST', '/appium/device/install_app', { appPath });
  }

  async activateApp(appId: string): Promise<void> {
    await this.executeScript('mobile: activateApp', [{ appId, bundleId: appId }]);
  }

  async terminateApp(appId: string): Promise<void> {
    await this.executeScript('mobile: terminateApp', [{ appId, bundleId: appId }]);
  }

  async performActions(actions: W3CActionSequence[]): Promise<void> {
    await this.sessionRequest('POST', '/actions', { actions });
  }

  async releaseActions(): Promise<void> {
    await this.sessionRequest('DELETE', '/actions', undefined, { retryAttempts: 0 });
  }

  async sendKeys(text: string): Promise<void> {
    await this.sessionRequest('POST', '/keys', {
      text,
      value: Array.from(text),
    });
  }

  async back(): Promise<void> {
    await this.sessionRequest('POST', '/back');
  }

  async source(): Promise<string> {
    const value = await this.sessionRequest('GET', '/source');
    if (typeof value !== 'string') {
      throw new AppError('COMMAND_FAILED', 'WebDriver source response was not a string', {
        valueType: typeof value,
      });
    }
    return value;
  }

  async screenshot(outPath: string): Promise<void> {
    const value = await this.sessionRequest('GET', '/screenshot');
    if (typeof value !== 'string') {
      throw new AppError('COMMAND_FAILED', 'WebDriver screenshot response was not base64 text', {
        valueType: typeof value,
      });
    }
    await fs.writeFile(outPath, Buffer.from(value, 'base64'));
  }

  async executeScript(script: string, args: unknown[] = []): Promise<unknown> {
    return await this.sessionRequest('POST', '/execute/sync', { script, args });
  }

  private async sessionRequest(
    method: string,
    pathSuffix: string,
    body?: unknown,
    overrides?: WebDriverRequestOverrides,
  ): Promise<unknown> {
    const sessionId = this.requireSessionId();
    return await this.requestValue(method, `/session/${sessionId}${pathSuffix}`, body, overrides);
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new AppError('SESSION_NOT_FOUND', 'WebDriver session has not been created yet.');
    }
    return this.sessionId;
  }

  private async requestValue(
    method: string,
    path: string,
    body?: unknown,
    overrides?: WebDriverRequestOverrides,
  ): Promise<unknown> {
    let lastError: unknown;
    const retryAttempts = overrides?.retryAttempts ?? this.requestPolicy.retryAttempts;
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      try {
        return await this.requestValueOnce(method, path, body);
      } catch (error) {
        lastError = error;
        if (!isRetriableWebDriverError(error) || attempt >= retryAttempts) {
          throw error;
        }
        await delay(this.requestPolicy.retryDelayMs);
      }
    }
    throw lastError;
  }

  private async requestValueOnce(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(trimLeadingSlash(path), this.endpoint), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...this.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestPolicy.timeoutMs),
    });
    const text = await response.text();
    const payload = text ? parseJsonResponse(text) : {};
    if (!response.ok) {
      throw webdriverError(response.status, payload);
    }
    return readWebDriverValue(payload);
  }
}

function normalizeCapabilities(capabilities: Record<string, unknown>): Record<string, unknown> {
  if ('alwaysMatch' in capabilities || 'firstMatch' in capabilities) return capabilities;
  return { alwaysMatch: capabilities };
}

function readSession(value: unknown): WebDriverSession {
  if (!value || typeof value !== 'object') {
    throw new AppError('COMMAND_FAILED', 'WebDriver create-session response was empty.');
  }
  const record = value as Record<string, unknown>;
  const sessionId =
    typeof record.sessionId === 'string'
      ? record.sessionId
      : typeof record.session_id === 'string'
        ? record.session_id
        : undefined;
  if (!sessionId) {
    throw new AppError('COMMAND_FAILED', 'WebDriver create-session response missed sessionId.', {
      response: record,
    });
  }
  const capabilities =
    record.capabilities && typeof record.capabilities === 'object'
      ? (record.capabilities as Record<string, unknown>)
      : {};
  return { sessionId, capabilities };
}

function readWebDriverValue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const response = payload as WebDriverResponse;
  if ('value' in response) return response.value;
  return payload;
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'WebDriver response was not valid JSON.', { text }, error);
  }
}

function webdriverError(status: number, payload: unknown): AppError {
  const value =
    payload && typeof payload === 'object' && 'value' in payload
      ? (payload as { value?: unknown }).value
      : payload;
  const message =
    value &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
      ? (value as { message: string }).message
      : `WebDriver request failed with HTTP ${status}.`;
  return new AppError('COMMAND_FAILED', message, { status, response: payload });
}

function isRetriableWebDriverError(error: unknown): boolean {
  if (error instanceof AppError) {
    const status = error.details?.status;
    return typeof status === 'number' && status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '');
}

function withTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  const copy = new URL(url);
  copy.pathname = `${copy.pathname}/`;
  return copy;
}

function basicAuth(auth: WebDriverAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.accessKey}`).toString('base64')}`;
}
