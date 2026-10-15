import type { PrepareMetroRuntimeResult } from '@agent-device/contracts/remote';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import fs from 'node:fs';
import path from 'node:path';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { resolveMetroServerUrl, type MetroReloadTargetInput } from './metro-reload-endpoints.ts';

/** Reload control and the prepared device addresses that may reuse it on a fresh open. */
export type MetroSessionHints = {
  controlBaseUrl: string;
  deviceBaseUrls?: string[];
};

export type MetroSessionScope = { stateDir: string; session: string };

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

export function readMetroSessionHints(options: MetroSessionScope): MetroSessionHints | undefined {
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
  try {
    const runtime = {
      metroHost: typeof record.metroHost === 'string' ? record.metroHost : undefined,
      metroPort: typeof record.metroPort === 'number' ? record.metroPort : undefined,
      bundleUrl: typeof record.bundleUrl === 'string' ? record.bundleUrl : undefined,
    };
    if (
      typeof record.controlBaseUrl !== 'string' &&
      Object.values(runtime).every((value) => value === undefined)
    )
      return undefined;
    const url =
      typeof record.controlBaseUrl === 'string'
        ? new URL(record.controlBaseUrl)
        : resolveMetroServerUrl({ runtime });
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? {
          controlBaseUrl: url.toString(),
          ...(Array.isArray(record.deviceBaseUrls)
            ? {
                deviceBaseUrls: record.deviceBaseUrls.filter(
                  (value): value is string => typeof value === 'string',
                ),
              }
            : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
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
    runtime: (complete ? undefined : readMetroSessionRuntime(scope)) ?? input.runtime,
  });
}

export function readMetroSessionRuntime(scope: MetroSessionScope): SessionRuntimeHints | undefined {
  const binding = readMetroSessionHints(scope);
  return binding ? { bundleUrl: binding.controlBaseUrl } : undefined;
}

function runtimeServerUrl(runtime: SessionRuntimeHints | undefined): string | undefined {
  const { metroHost, metroPort, bundleUrl } = runtime ?? {};
  return metroHost === undefined && metroPort === undefined && bundleUrl === undefined
    ? undefined
    : resolveMetroServerUrl({ runtime }).toString();
}

export function recordPreparedMetroSession(
  scope: MetroSessionScope,
  result: Pick<PrepareMetroRuntimeResult, 'statusUrl' | 'iosRuntime' | 'androidRuntime'>,
): void {
  try {
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

export function recordOpenedMetroSession(
  scope: MetroSessionScope,
  input: {
    runtime: SessionRuntimeHints | undefined;
    explicitRuntime: boolean;
    sessionReused: boolean;
  },
): void {
  try {
    const url = runtimeServerUrl(input.runtime);
    if (url) {
      const binding = input.explicitRuntime ? undefined : readMetroSessionHints(scope);
      if (binding && (input.sessionReused || binding.deviceBaseUrls?.includes(url))) return;
      writeMetroSessionHints({ ...scope, hints: { controlBaseUrl: url } });
    } else if (!input.sessionReused) clearMetroSessionHints(scope);
  } catch {}
}

export function clearMetroSessionHintsQuietly(scope: MetroSessionScope): void {
  try {
    clearMetroSessionHints(scope);
  } catch {}
}
