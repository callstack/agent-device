import type { PrepareMetroRuntimeResult } from '@agent-device/contracts/remote';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import fs from 'node:fs';
import path from 'node:path';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { resolveMetroServerUrl, type MetroReloadTargetInput } from './metro-reload-endpoints.ts';
import type { MetroAppTarget } from './metro-dev-server-discovery.ts';

/** Reload control, the prepared device addresses that may reuse it, and the app the session opened. */
export type MetroSessionHints = {
  /** Absent when the session opened an app without any dev-server hint to bind. */
  controlBaseUrl?: string;
  deviceBaseUrls?: string[];
  /** The app this session opened, so a reload can ask that app's host about it. */
  app?: MetroAppTarget;
};

export type MetroSessionScope = { stateDir: string; session: string };

export type MetroSessionOptions = {
  stateDir?: string;
  session: string;
  /** The host whose state directory and working directory the session binding is read from. */
  host: HostEnvironment;
};

function resolveMetroSessionScope(options: MetroSessionOptions): MetroSessionScope {
  const { host } = options;
  return {
    stateDir: resolveDaemonPaths(options.stateDir ?? host.env.AGENT_DEVICE_STATE_DIR, {
      env: host.env,
      cwd: host.cwd,
    }).baseDir,
    session: options.session,
  };
}

function metroSessionHintsPath(stateDir: string, session: string): string {
  return path.join(stateDir, 'metro-sessions', `${safeSessionName(session)}.json`);
}

export function writeMetroSessionHints(
  options: MetroSessionScope & { hints: MetroSessionHints },
): void {
  const filePath = metroSessionHintsPath(options.stateDir, options.session);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(options.hints, null, 2)}\n`, 'utf8');
}

/** The stored session record: the control address, the device addresses, and the app it opened. */
type MetroSessionRecord = {
  raw: Record<string, unknown>;
  controlBaseUrl?: string;
  deviceBaseUrls?: string[];
  app?: MetroAppTarget;
};

function readMetroSessionRecord(options: MetroSessionScope): MetroSessionRecord | undefined {
  const filePath = metroSessionHintsPath(options.stateDir, options.session);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const app = readStoredAppTarget(record.app);
  const deviceBaseUrls = Array.isArray(record.deviceBaseUrls)
    ? record.deviceBaseUrls.filter((value): value is string => typeof value === 'string')
    : undefined;
  const controlBaseUrl =
    typeof record.controlBaseUrl === 'string' ? record.controlBaseUrl : undefined;
  return {
    raw: record,
    ...(controlBaseUrl ? { controlBaseUrl } : {}),
    ...(deviceBaseUrls ? { deviceBaseUrls } : {}),
    ...(app ? { app } : {}),
  };
}

function readStoredAppTarget(value: unknown): MetroAppTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const platform =
    record.platform === 'ios' || record.platform === 'android' ? record.platform : undefined;
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId : undefined;
  if (!platform || !deviceId) return undefined;
  const deviceKind =
    record.deviceKind === 'simulator' ||
    record.deviceKind === 'emulator' ||
    record.deviceKind === 'device'
      ? record.deviceKind
      : undefined;
  return {
    platform,
    deviceId,
    ...(deviceKind ? { deviceKind } : {}),
    ...(typeof record.appId === 'string' ? { appId: record.appId } : {}),
    // Only an explicit `true` says the device is hosted here; a record from before this field, or a
    // provider device, reads as not proven local.
    ...(record.hostedLocally === true ? { hostedLocally: true } : {}),
  };
}

/** The app a session opened, even when the session never bound a dev server. */
export function readMetroSessionAppTarget(
  options: MetroSessionOptions,
): MetroAppTarget | undefined {
  let scope: MetroSessionScope;
  try {
    scope = resolveMetroSessionScope(options);
  } catch {
    return undefined;
  }
  return readMetroSessionRecord(scope)?.app;
}

export function readMetroSessionHints(options: MetroSessionScope): MetroSessionHints | undefined {
  const stored = readMetroSessionRecord(options);
  if (!stored) return undefined;
  // An app-only record binds no address: reload discovers the dev server instead of resolving one.
  if (!stored.controlBaseUrl && !hasStoredRuntimeHints(stored.raw)) return undefined;
  try {
    const url = stored.controlBaseUrl
      ? new URL(stored.controlBaseUrl)
      : resolveMetroServerUrl({ runtime: readStoredRuntimeHints(stored.raw) });
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return {
      controlBaseUrl: url.toString(),
      ...(stored.deviceBaseUrls ? { deviceBaseUrls: stored.deviceBaseUrls } : {}),
      ...(stored.app ? { app: stored.app } : {}),
    };
  } catch {
    return undefined;
  }
}

type LegacyRuntimeHintRecord = Record<string, unknown>;

function hasStoredRuntimeHints(record: LegacyRuntimeHintRecord): boolean {
  return Object.values(readStoredRuntimeHints(record)).some((value) => value !== undefined);
}

function readStoredRuntimeHints(record: LegacyRuntimeHintRecord): {
  metroHost?: string;
  metroPort?: number;
  bundleUrl?: string;
} {
  return {
    metroHost: typeof record.metroHost === 'string' ? record.metroHost : undefined,
    metroPort: typeof record.metroPort === 'number' ? record.metroPort : undefined,
    bundleUrl: typeof record.bundleUrl === 'string' ? record.bundleUrl : undefined,
  };
}

export function clearMetroSessionHints(options: MetroSessionScope): void {
  fs.rmSync(metroSessionHintsPath(options.stateDir, options.session), { force: true });
}

/** Resolves a control address; device-facing runtime hints are only an explicit fallback. */
export function resolveSessionMetroServerUrl(
  scope: MetroSessionScope,
  input: MetroReloadTargetInput = {},
): URL {
  const complete =
    input.bundleUrl !== undefined ||
    (input.metroHost !== undefined && input.metroPort !== undefined);
  return resolveMetroServerUrl({
    ...input,
    runtime: (complete ? undefined : readScopedMetroSessionRuntime(scope)) ?? input.runtime,
  });
}

function readScopedMetroSessionRuntime(scope: MetroSessionScope): SessionRuntimeHints | undefined {
  try {
    const controlBaseUrl = readMetroSessionHints(scope)?.controlBaseUrl;
    return controlBaseUrl ? { bundleUrl: controlBaseUrl } : undefined;
  } catch {
    return undefined;
  }
}

export function readMetroSessionRuntime(
  options: MetroSessionOptions,
): SessionRuntimeHints | undefined {
  let scope: MetroSessionScope;
  try {
    scope = resolveMetroSessionScope(options);
  } catch {
    return undefined;
  }
  return readScopedMetroSessionRuntime(scope);
}

function runtimeServerUrl(runtime: SessionRuntimeHints | undefined): string | undefined {
  const { metroHost, metroPort, bundleUrl } = runtime ?? {};
  return metroHost === undefined && metroPort === undefined && bundleUrl === undefined
    ? undefined
    : resolveMetroServerUrl({ runtime }).toString();
}

export function recordPreparedMetroSession(
  options: MetroSessionOptions,
  result: Pick<PrepareMetroRuntimeResult, 'statusUrl' | 'iosRuntime' | 'androidRuntime'>,
): void {
  try {
    const scope = resolveMetroSessionScope(options);
    const deviceBaseUrls = new Set<string>();
    for (const runtime of [result.iosRuntime, result.androidRuntime]) {
      try {
        const url = runtimeServerUrl(runtime);
        if (url) deviceBaseUrls.add(url);
      } catch {}
    }
    writeMetroSessionHints({
      ...scope,
      hints: {
        controlBaseUrl: new URL('.', result.statusUrl).toString(),
        deviceBaseUrls: [...deviceBaseUrls],
      },
    });
  } catch {}
}

export type MetroSessionOpenInput = {
  runtime: SessionRuntimeHints | undefined;
  explicitRuntime: boolean;
  sessionReused: boolean;
  /** The app the open launched, so a later reload can ask its host for the app's own address. */
  app?: MetroAppTarget;
};

/**
 * Records what `open` left behind: the address it bound, or the app it launched when it bound none. An
 * open never drops a record the session still needs, and a fresh session never inherits one.
 */
export function recordOpenedMetroSession(
  options: MetroSessionOptions,
  input: MetroSessionOpenInput,
): void {
  try {
    const scope = resolveMetroSessionScope(options);
    const stored = readMetroSessionRecord(scope);
    const app = input.app ? keepProvenHost(input.app, stored?.app) : undefined;
    const url = runtimeServerUrl(input.runtime);
    if (url) recordOpenedBinding(scope, input, url, app);
    else recordOpenedApp(scope, input.sessionReused, app, stored);
  } catch {}
}

/**
 * Records the dev-server address this open bound. A reused session, or one that re-binds an address one
 * of its devices already uses, keeps the binding it has: the address it published to those devices is
 * the one they are dialling.
 */
function recordOpenedBinding(
  scope: MetroSessionScope,
  input: MetroSessionOpenInput,
  url: string,
  app: MetroAppTarget | undefined,
): void {
  const binding = input.explicitRuntime ? undefined : readMetroSessionHints(scope);
  if (binding && (input.sessionReused || binding.deviceBaseUrls?.includes(url))) {
    if (app) writeMetroSessionHints({ ...scope, hints: { ...binding, app } });
    return;
  }
  writeMetroSessionHints({ ...scope, hints: { controlBaseUrl: url, ...(app ? { app } : {}) } });
}

/**
 * Records an open that bound no address. What is left is the app this open launched: a later reload
 * looks that app's own dev-server address up from it. A reused session can open a different app, so a
 * recorded app always replaces the previous one and keeps the address the session already had. An open
 * that reports no app leaves a reused session's record alone and clears a stale one on a fresh session.
 */
function recordOpenedApp(
  scope: MetroSessionScope,
  sessionReused: boolean,
  app: MetroAppTarget | undefined,
  stored: MetroSessionRecord | undefined,
): void {
  if (!app) {
    if (!sessionReused) clearMetroSessionHints(scope);
    return;
  }
  writeMetroSessionHints({ ...scope, hints: { ...bindingFields(stored), app } });
}

/** The address fields of a stored record, apart from the app recorded beside them. */
function bindingFields(stored: MetroSessionRecord | undefined): MetroSessionHints {
  return {
    ...(stored?.controlBaseUrl ? { controlBaseUrl: stored.controlBaseUrl } : {}),
    ...(stored?.deviceBaseUrls ? { deviceBaseUrls: stored.deviceBaseUrls } : {}),
  };
}

/**
 * Keeps the host trait an earlier open proved for the same device. An open that resolves the device
 * from the session rather than from an inventory reports nothing about where it runs, and that silence
 * must not erase what was already proven about this device.
 */
function keepProvenHost(app: MetroAppTarget, stored: MetroAppTarget | undefined): MetroAppTarget {
  if (app.hostedLocally !== undefined) return app;
  if (!stored || stored.deviceId !== app.deviceId) return app;
  return stored.hostedLocally === undefined ? app : { ...app, hostedLocally: stored.hostedLocally };
}

export function clearMetroSessionHintsQuietly(options: MetroSessionOptions): void {
  try {
    clearMetroSessionHints(resolveMetroSessionScope(options));
  } catch {}
}
