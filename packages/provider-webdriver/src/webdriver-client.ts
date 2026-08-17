import fs from 'node:fs/promises';
import { AppError } from '@agent-device/kernel/errors';
import {
  WebDriverTransport,
  type WebDriverAuth,
  type WebDriverRequestOverrides,
  type WebDriverRequestPolicy,
} from './webdriver-transport.ts';

export type { WebDriverAuth, WebDriverRequestPolicy } from './webdriver-transport.ts';

/**
 * Default budget for `POST /session`. Cloud providers allocate a physical
 * device inside that one request — BrowserStack iOS real devices routinely
 * take 45–90s (#1774) — so it is far above the per-request default that
 * suits a settled session's round trips.
 */
const DEFAULT_SESSION_CREATE_TIMEOUT_MS = 180_000;

export type WebDriverClientOptions = {
  clientVersion: string;
  endpoint: string | URL;
  auth?: WebDriverAuth;
  headers?: Record<string, string>;
  requestPolicy?: WebDriverRequestPolicy;
};

export type WebDriverSession = {
  sessionId: string;
  capabilities: Record<string, unknown>;
};

export type WebDriverWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WebDriverActiveElement = {
  /** Opaque W3C element reference; only ever compared for equality. */
  id: string;
  rect: WebDriverWindowRect;
};

export type W3CPointerAction =
  | {
      type: 'pointerMove';
      duration: number;
      x: number;
      y: number;
    }
  | {
      type: 'pointerDown' | 'pointerUp';
      button: number;
    }
  | {
      type: 'pause';
      duration: number;
    };

export type W3CActionSequence = {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: W3CPointerAction[];
};

export class WebDriverClient {
  private readonly transport: WebDriverTransport;
  private readonly sessionCreateTimeoutMs: number;
  private sessionId: string | undefined;

  constructor(options: WebDriverClientOptions) {
    this.transport = new WebDriverTransport(options);
    this.sessionCreateTimeoutMs =
      options.requestPolicy?.sessionCreateTimeoutMs ?? DEFAULT_SESSION_CREATE_TIMEOUT_MS;
  }

  /**
   * `POST /session` is non-idempotent and its outcome after a client-side abort
   * is indeterminate (the hub finishes allocating whether or not anyone is
   * listening), so it takes no cancellation signal and never retries: a retry
   * is a second billed session, an abort loses the id of the first (#1774).
   * `deadline` (epoch ms) can only shorten the create budget, never extend it.
   */
  async createSession(
    capabilities: Record<string, unknown>,
    options?: { deadline?: number },
  ): Promise<WebDriverSession> {
    const value = await this.requestValue(
      'POST',
      '/session',
      { capabilities: normalizeCapabilities(capabilities) },
      {
        retryAttempts: 0,
        timeoutMs: budgetWithin(this.sessionCreateTimeoutMs, options?.deadline),
      },
    );
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

  async installApp(appPath: string, signal?: AbortSignal): Promise<void> {
    await this.sessionRequest('POST', '/appium/device/install_app', { appPath }, { signal });
  }

  async activateApp(appId: string): Promise<void> {
    try {
      await this.sessionRequest('POST', '/appium/device/activate_app', { appId });
    } catch {
      await this.executeScript('mobile: activateApp', [{ appId, bundleId: appId }]);
    }
  }

  async terminateApp(appId: string): Promise<void> {
    try {
      await this.sessionRequest('POST', '/appium/device/terminate_app', { appId });
    } catch {
      await this.executeScript('mobile: terminateApp', [{ appId, bundleId: appId }]);
    }
  }

  async performActions(actions: W3CActionSequence[]): Promise<void> {
    await this.sessionRequest('POST', '/actions', { actions });
  }

  async releaseActions(): Promise<void> {
    await this.sessionRequest('DELETE', '/actions', undefined, { retryAttempts: 0 });
  }

  async sendKeys(text: string): Promise<void> {
    await this.sessionRequest('POST', '/keys', { value: Array.from(text) });
  }

  async hideKeyboard(): Promise<void> {
    await this.sessionRequest('POST', '/appium/device/hide_keyboard', undefined, {
      retryAttempts: 0,
    });
  }

  /**
   * Whether the software keyboard is up, or `unsupported` when this driver has
   * no such route. Polled between a text field tap and the keys it should
   * receive, so it stays one cheap round trip — no retries, and `timeoutMs`
   * lets the caller bound it by its own budget rather than the client default.
   *
   * The unsupported/failed split matters: a caller that treats every error as
   * "this driver cannot answer" would silently degrade a dead session, an auth
   * rejection, or a grid outage into a blind text entry. Only a route the
   * driver does not implement — or one that answers with a non-boolean — is
   * reported as unsupported; everything else throws.
   */
  async isKeyboardShown(timeoutMs?: number): Promise<boolean | 'unsupported'> {
    let value: unknown;
    try {
      value = await this.sessionRequest('GET', '/appium/device/is_keyboard_shown', undefined, {
        retryAttempts: 0,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      if (isUnimplementedWebDriverRoute(error)) return 'unsupported';
      throw error;
    }
    return typeof value === 'boolean' ? value : 'unsupported';
  }

  /**
   * Which element holds text-entry focus and where it sits, `none` when nothing
   * does, or `unsupported` when this driver has no active-element route.
   *
   * Keyboard visibility can only witness that *a* field took focus; it says
   * nothing about *which*, which is why a second fill into an already-open form
   * could send its keys to the field the first one focused (#1658). The focused
   * element's identity answers that. Its rect comes along because identity
   * alone cannot distinguish a deliberate re-fill of the already-focused field
   * from a tap that moved nothing.
   *
   * `no such element` is a real, expected answer here (a form with nothing
   * focused yet), so it maps to `none` and leaves the caller polling. A route
   * that answers 200 with something that is not an element reference is not
   * implementing this at all — the spec reports "nothing focused" as that
   * error, never as an empty value — so it degrades to `unsupported` alongside
   * a genuinely unimplemented route, the same way a non-boolean keyboard answer
   * does. Reading it as `none` would fail every fill on such a grid.
   */
  async activeElement(
    timeoutMs?: number,
  ): Promise<WebDriverActiveElement | 'none' | 'unsupported'> {
    // `timeoutMs` bounds this OPERATION, not each request in it. Two sequential
    // round trips each handed the full budget would together take twice it — a
    // probe given the 1.5s left of a 2s readiness deadline could run 3s and
    // overrun the deadline it was derived from. One deadline, and the second
    // request gets only what the first left.
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let elementId: string | undefined;
    try {
      elementId = readW3CElementId(
        await this.sessionRequest('GET', '/element/active', undefined, requestBudget(deadline)),
      );
    } catch (error) {
      if (isUnimplementedWebDriverRoute(error)) return 'unsupported';
      if (isNoSuchElementError(error)) return 'none';
      throw error;
    }
    if (elementId === undefined) return 'unsupported';
    try {
      const value = await this.sessionRequest(
        'GET',
        `/element/${encodeURIComponent(elementId)}/rect`,
        undefined,
        requestBudget(deadline),
      );
      return { id: elementId, rect: readWindowRect(value) };
    } catch (error) {
      if (isUnimplementedWebDriverRoute(error)) return 'unsupported';
      // The focused element went away between the two calls — a stale answer,
      // not a broken driver. Report it as "nothing focused" so the caller polls
      // again rather than failing on a race it can simply retry out of.
      if (isNoSuchElementError(error)) return 'none';
      throw error;
    }
  }

  async back(): Promise<void> {
    await this.sessionRequest('POST', '/back');
  }

  /** Exact four-way display rotation. `z` is degrees: 0, 90, 180, or 270. */
  async setRotation(degrees: number): Promise<void> {
    await this.sessionRequest('POST', '/rotation', { x: 0, y: 0, z: degrees });
  }

  /** Two-way orientation. Values are uppercase per the WebDriver protocol. */
  async setOrientation(orientation: 'PORTRAIT' | 'LANDSCAPE'): Promise<void> {
    await this.sessionRequest('POST', '/orientation', { orientation });
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

  async windowRect(): Promise<WebDriverWindowRect> {
    return readWindowRect(await this.sessionRequest('GET', '/window/rect'));
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
    return await this.transport.requestValue(method, path, body, overrides);
  }
}

function readWindowRect(value: unknown): WebDriverWindowRect {
  if (!value || typeof value !== 'object') {
    throw new AppError('COMMAND_FAILED', 'WebDriver window rect response was empty.');
  }
  const record = value as Record<string, unknown>;
  const rect = {
    x: readFiniteNumber(record, 'x'),
    y: readFiniteNumber(record, 'y'),
    width: readFiniteNumber(record, 'width'),
    height: readFiniteNumber(record, 'height'),
  };
  if (
    rect.x === undefined ||
    rect.y === undefined ||
    rect.width === undefined ||
    rect.height === undefined
  ) {
    throw new AppError('COMMAND_FAILED', 'WebDriver window rect response was invalid.', {
      response: record,
    });
  }
  return rect as WebDriverWindowRect;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

/**
 * A route this driver does not implement, as opposed to one that failed.
 *
 * Classified from the W3C error code, NOT from the HTTP status: `unknown
 * command` and `invalid session id` are both 404, so a status test would read a
 * dead session as a missing feature — exactly the confusion that turns a broken
 * session into a blind text entry. Only 405/501 are unambiguous enough to stand
 * on their own. A 5xx, an auth rejection, or a timeout is a real failure.
 */
const UNIMPLEMENTED_WEBDRIVER_STATUSES = new Set([405, 501]);
const UNIMPLEMENTED_WEBDRIVER_ERRORS = new Set(['unknown command', 'unknown method']);

/**
 * The W3C element identifier, whose key is the spec's fixed UUID rather than a
 * readable name. Appium also echoes the legacy `ELEMENT` key; accept either so
 * the caller works across grid versions.
 */
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function readW3CElementId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = record[W3C_ELEMENT_KEY] ?? record.ELEMENT;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * One request's share of a multi-request operation's budget: whatever is left
 * of it. Floored at zero rather than omitted, so an already-spent budget aborts
 * the request immediately instead of silently falling back to the client
 * default and outliving the deadline entirely.
 */
function requestBudget(deadline: number | undefined): WebDriverRequestOverrides {
  if (deadline === undefined) return { retryAttempts: 0 };
  return { retryAttempts: 0, timeoutMs: remainingMs(deadline) };
}

/** A phase's own budget, capped by the operation deadline it runs under, if any. */
function budgetWithin(budgetMs: number, deadline: number | undefined): number {
  return deadline === undefined ? budgetMs : Math.min(budgetMs, remainingMs(deadline));
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** Nothing is focused right now — an expected state, not a driver defect. */
function isNoSuchElementError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return readWebDriverErrorCode(error).toLowerCase() === 'no such element';
}

function isUnimplementedWebDriverRoute(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const status = error.details?.status;
  if (typeof status === 'number' && UNIMPLEMENTED_WEBDRIVER_STATUSES.has(status)) return true;
  return UNIMPLEMENTED_WEBDRIVER_ERRORS.has(readWebDriverErrorCode(error).toLowerCase());
}

function readWebDriverErrorCode(error: AppError): string {
  const response = error.details?.response;
  const value =
    response && typeof response === 'object' ? (response as { value?: unknown }).value : undefined;
  const code =
    value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
  return typeof code === 'string' ? code : '';
}
