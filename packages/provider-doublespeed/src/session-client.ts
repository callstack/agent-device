import { AppError } from '@agent-device/kernel/errors';
import { boundedSignal } from './api-client.ts';

const REQUEST_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type DoublespeedSessionScreen = { width: number; height: number; scale: number };

export type DoublespeedSessionInfo = {
  device: string;
  udid: string;
  screen: DoublespeedSessionScreen;
  bundleId?: string;
};

export type DoublespeedInstalledApp = {
  bundleId: string;
  name?: string;
  installType: string;
};

export type DoublespeedTreeNode = {
  type?: string;
  label?: string;
  identifier?: string;
  value?: string;
  frame?: { x?: number; y?: number; width?: number; height?: number };
  enabled?: boolean;
  visible?: boolean;
  children?: DoublespeedTreeNode[];
};

export type DoublespeedElementSelector = {
  accessibilityId?: string;
  label?: string;
  value?: string;
};

export type DoublespeedLaunchMode = 'ForegroundIfRunning' | 'RelaunchIfRunning';
export type DoublespeedSessionKey = 'home' | 'enter' | 'backspace' | 'escape';
export type DoublespeedOrientation = 'portrait' | 'landscape';
export type DoublespeedScrollDirection = 'up' | 'down' | 'left' | 'right';

type SessionErrorBody = { error?: { code?: string; message?: string } };

/**
 * One live simulator session's JSON API. The session URL carries the capability token, so no
 * account credential ever travels to the worker that hosts the simulator.
 */
export type DoublespeedSessionClient = Readonly<{
  apiUrl: string;
  info(signal?: AbortSignal): Promise<DoublespeedSessionInfo>;
  listApps(signal?: AbortSignal): Promise<DoublespeedInstalledApp[]>;
  installApp(
    input: { url: string; sha256?: string; launchMode?: DoublespeedLaunchMode },
    signal?: AbortSignal,
  ): Promise<{ bundleId?: string }>;
  launchApp(bundleId: string, signal?: AbortSignal): Promise<void>;
  terminateApp(bundleId: string, signal?: AbortSignal): Promise<void>;
  openUrl(url: string, signal?: AbortSignal): Promise<void>;
  tap(x: number, y: number, signal?: AbortSignal): Promise<void>;
  longPress(x: number, y: number, ms?: number, signal?: AbortSignal): Promise<void>;
  tapElement(selector: DoublespeedElementSelector, signal?: AbortSignal): Promise<void>;
  typeText(text: string, signal?: AbortSignal): Promise<void>;
  scroll(
    direction: DoublespeedScrollDirection,
    pixels: number,
    signal?: AbortSignal,
  ): Promise<void>;
  pressKey(key: DoublespeedSessionKey, signal?: AbortSignal): Promise<void>;
  setOrientation(orientation: DoublespeedOrientation, signal?: AbortSignal): Promise<void>;
  screenshot(signal?: AbortSignal): Promise<{ base64: string }>;
  elementTree(signal?: AbortSignal): Promise<DoublespeedTreeNode[]>;
  appLogTail(bundleId: string, lines: number, signal?: AbortSignal): Promise<string>;
  foregroundApp(signal?: AbortSignal): Promise<{ bundleId?: string }>;
}>;

export function createDoublespeedSessionClient(
  apiUrl: string,
  options?: { fetch?: typeof fetch },
): DoublespeedSessionClient {
  const fetchImpl = options?.fetch ?? fetch;
  const request = async <Result>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Result> => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: boundedSignal(timeoutMs, signal),
    });
    const payload = (await response.json().catch(() => undefined)) as SessionErrorBody | undefined;
    if (!response.ok) throw sessionError(response.status, payload?.error);
    return payload as Result;
  };
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<void> => {
    await request('POST', path, body, signal);
  };

  return Object.freeze({
    apiUrl,
    info: async (signal) => {
      const body = await request<{
        device: string;
        udid: string;
        screen: DoublespeedSessionScreen;
        bundle_id: string | null;
      }>('GET', '/', undefined, signal);
      return {
        device: body.device,
        udid: body.udid,
        screen: body.screen,
        ...(body.bundle_id ? { bundleId: body.bundle_id } : {}),
      };
    },
    listApps: async (signal) => {
      const body = await request<{
        apps: Array<{ bundle_id: string; name: string | null; install_type: string }>;
      }>('GET', '/apps', undefined, signal);
      return body.apps.map((app) => ({
        bundleId: app.bundle_id,
        ...(app.name ? { name: app.name } : {}),
        installType: app.install_type,
      }));
    },
    installApp: async (input, signal) => {
      const body = await request<{ bundle_id?: string }>(
        'POST',
        '/apps/install',
        {
          url: input.url,
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
          ...(input.launchMode ? { launch_mode: input.launchMode } : {}),
        },
        signal,
        INSTALL_TIMEOUT_MS,
      );
      return body.bundle_id ? { bundleId: body.bundle_id } : {};
    },
    launchApp: async (bundleId, signal) =>
      await post(`/apps/${encodeURIComponent(bundleId)}/launch`, {}, signal),
    terminateApp: async (bundleId, signal) =>
      await post(`/apps/${encodeURIComponent(bundleId)}/terminate`, {}, signal),
    openUrl: async (url, signal) => await post('/open-url', { url }, signal),
    tap: async (x, y, signal) => await post('/tap', { x, y }, signal),
    longPress: async (x, y, ms, signal) =>
      await post('/long-press', { x, y, ...(ms ? { ms } : {}) }, signal),
    tapElement: async (selector, signal) => await post('/tap-element', { selector }, signal),
    typeText: async (text, signal) => await post('/type', { text }, signal),
    scroll: async (direction, pixels, signal) =>
      await post('/scroll', { direction, pixels }, signal),
    pressKey: async (key, signal) => await post('/key', { key }, signal),
    setOrientation: async (orientation, signal) =>
      await post('/orientation', { orientation }, signal),
    screenshot: async (signal) => {
      const body = await request<{ base64: string }>('GET', '/screenshot', undefined, signal);
      return { base64: body.base64 };
    },
    elementTree: async (signal) => {
      const body = await request<{ nodes: DoublespeedTreeNode[] }>(
        'GET',
        '/tree',
        undefined,
        signal,
      );
      return body.nodes;
    },
    appLogTail: async (bundleId, lines, signal) => {
      const query = `?bundle_id=${encodeURIComponent(bundleId)}&lines=${Math.max(1, Math.floor(lines))}`;
      const body = await request<{ text: string }>('GET', `/logs${query}`, undefined, signal);
      return body.text;
    },
    foregroundApp: async (signal) => {
      const body = await request<{ bundle_id: string | null }>(
        'GET',
        '/app-state',
        undefined,
        signal,
      );
      return body.bundle_id ? { bundleId: body.bundle_id } : {};
    },
  });
}

function sessionError(status: number, error: SessionErrorBody['error']): AppError {
  const code =
    status === 404 && error?.code === 'ELEMENT_NOT_FOUND' ? 'ELEMENT_NOT_FOUND' : 'COMMAND_FAILED';
  return new AppError(
    code,
    `Doublespeed session request failed: ${error?.message ?? `HTTP ${status}`}`,
    {
      status,
      ...(error?.code ? { providerCode: error.code } : {}),
    },
  );
}
