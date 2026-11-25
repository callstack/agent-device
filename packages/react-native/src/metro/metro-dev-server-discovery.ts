import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  DEFAULT_METRO_HOST,
  DEFAULT_METRO_PORT,
  isMetroTargetBound,
  resolveMetroServerUrl,
  type MetroReloadTargetInput,
} from './metro-reload-endpoints.ts';

/**
 * The session's app, as `open` recorded it: the one thing a sessionless reload can still ask about
 * on the machine that hosts the device.
 */
export type MetroAppTarget = Readonly<{
  platform: 'ios' | 'android';
  deviceKind?: 'simulator' | 'emulator' | 'device';
  deviceId: string;
  appId?: string;
}>;

/** How a reload reached the dev server it is about to call. */
export type MetroServerResolutionSource =
  | 'binding'
  | 'app-reported'
  | 'local-project-root'
  | 'default';

/** A running local dev server, with the project root it reports. */
export type LocalMetroServer = Readonly<{
  serverUrl: URL;
  projectRoot?: string;
}>;

export type ResolvedMetroReloadServer = Readonly<{
  serverUrl: URL;
  resolvedBy: MetroServerResolutionSource;
}>;

export const METRO_RELOAD_REASONS = {
  // No dev server is bound to the session and none was found for its app; nothing was reloaded.
  devServerUnresolved: { reason: 'metro_dev_server_unresolved' },
} as const satisfies ReasonTable<'metro reload'>;

const IOS_JS_LOCATION_KEY = 'RCT_jsLocation';
const IOS_PACKAGER_SCHEME_KEY = 'RCT_packager_scheme';
const SIMULATOR_DEVICES_ROOT = 'Library/Developer/CoreSimulator/Devices';
const METRO_STATUS_READY_TEXT = 'packager-status:running';
const METRO_PROJECT_ROOT_HEADER = 'x-react-native-project-root';
const HOST_READ_TIMEOUT_MS = 1_500;
const STATUS_PROBE_TIMEOUT_MS = 800;
const MAX_CONCURRENT_STATUS_PROBES = 32;

/** The host reads a reload can make, injectable so the resolution order is testable without a host. */
export type MetroDevServerProbe = Readonly<{
  /** Ports a local process is listening on. */
  listListeningPorts?: () => Promise<number[]>;
  /** The dev server at an address, when one answers there. */
  probeServer?: (serverUrl: URL, timeoutMs: number) => Promise<LocalMetroServer | undefined>;
  /** What the session's app itself stored as its dev-server address. */
  readAppReportedServerUrl?: (
    app: MetroAppTarget,
    host: HostEnvironment,
  ) => Promise<URL | undefined>;
}>;

export type ResolveMetroReloadServerInput = MetroReloadTargetInput &
  Readonly<{
    app?: MetroAppTarget;
    host: HostEnvironment;
    projectRoot?: string;
    probe?: MetroDevServerProbe;
  }>;

/**
 * Resolves the dev server a reload should call, in this order:
 *
 * 1. The binding: `--metro-host`/`--metro-port`/`--bundle-url`, or the address the session bound
 *    through `metro prepare` or `open`'s Metro hint flags. The caller's answer is never second-guessed.
 * 2. What the app itself reports — on an iOS simulator, the dev-server address React Native keeps in
 *    the app's preferences. The app cannot be wrong about the server it loads its bundle from.
 * 3. A local dev server that serves the current project.
 *
 * Only a session whose app runs on a local simulator or emulator reaches steps 2 and 3: a remote
 * device's host is not this machine, so its sessions keep their existing behavior, including the
 * default address. With no signal at all, this fails typed rather than calling `localhost:8081`,
 * which in an unbound session belongs to whichever project happens to own that port.
 */
export async function resolveMetroReloadServerUrl(
  input: ResolveMetroReloadServerInput,
): Promise<ResolvedMetroReloadServer> {
  if (isMetroTargetBound(input)) {
    return { serverUrl: resolveMetroServerUrl(input), resolvedBy: 'binding' };
  }

  const app = input.app;
  if (!app || !canDiscoverForDeviceKind(app.deviceKind)) {
    // Nothing to discover from: no recorded app, or a device this machine does not host. The
    // address the caller's hints resolve to, default included, stays what it always was.
    return { serverUrl: resolveMetroServerUrl(input), resolvedBy: 'default' };
  }

  const host = input.host;
  const probe = input.probe ?? {};
  const projectRoot = input.projectRoot ?? host.cwd;
  const reported = await (probe.readAppReportedServerUrl ?? readAppReportedMetroServerUrl)(
    app,
    host,
  ).catch(() => undefined);
  if (reported) {
    // The app cannot be wrong about the server it loads from, but its stored address can outlive that
    // server. On loopback, where this host can answer for it, one bounded probe settles it.
    if (!isLoopbackUrl(reported) || (await probeIsRunningDevServer(reported, probe))) {
      return { serverUrl: reported, resolvedBy: 'app-reported' };
    }
  }

  const discovered = await discoverLocalMetroServer({
    projectRoots: [projectRoot, host.cwd],
    listListeningPorts: probe.listListeningPorts ?? listLocalListeningPorts,
    probeServer: probe.probeServer ?? probeLocalMetroServer,
  });
  if (discovered) {
    return { serverUrl: discovered.serverUrl, resolvedBy: 'local-project-root' };
  }

  throw metroDevServerUnresolvedError();
}

/**
 * Whether reload may look for a dev server on this machine for a session's device. A physical or
 * provider-hosted device runs somewhere else: its dev server is not a local port, so probing here
 * would answer a question nobody asked.
 */
export function canDiscoverForDeviceKind(kind: MetroAppTarget['deviceKind']): boolean {
  return kind === 'simulator' || kind === 'emulator';
}

/**
 * What the app itself reports: React Native keeps `RCT_jsLocation` in the app's own preferences
 * plist — the same key `open --metro-host/--metro-port` writes — and the simulator host reads that
 * file from the device container without a device round-trip. A physical device, an Android app, or
 * an app that never stored an address reports nothing.
 */
async function readAppReportedMetroServerUrl(
  app: MetroAppTarget,
  host: HostEnvironment,
): Promise<URL | undefined> {
  if (app.platform !== 'ios' || app.deviceKind !== 'simulator' || !app.appId) return undefined;
  const home = host.env.HOME;
  if (!home) return undefined;
  const plist = path.join(
    home,
    SIMULATOR_DEVICES_ROOT,
    app.deviceId,
    'data',
    'Library',
    'Preferences',
    `${app.appId}.plist`,
  );
  if (!fileExists(plist)) return undefined;
  const result = await runCmd('plutil', ['-convert', 'json', '-o', '-', plist], {
    allowFailure: true,
    timeoutMs: HOST_READ_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return undefined;
  const settings = parseJsonObject(result.stdout);
  const reported = asNonEmptyString(settings?.[IOS_JS_LOCATION_KEY]);
  if (!reported) return undefined;
  const scheme = settings?.[IOS_PACKAGER_SCHEME_KEY] === 'https' ? 'https' : 'http';
  return parseHostAndPort(reported, scheme);
}

/**
 * The local dev server that serves this project: a listening port whose `/status` answers
 * `packager-status:running` and whose `X-React-Native-Project-Root` contains or is contained by one
 * of the project roots (a monorepo server serves from the repo root). Ports come from what a local
 * process actually listens on, each probe is short, and they run concurrently, so a miss costs one
 * bounded sweep rather than a reload timeout. A project-root match always wins, and a server that
 * names a different project never counts, so another project's Metro is not reloaded by accident.
 */
export async function discoverLocalMetroServer(
  input: Readonly<{
    projectRoots: string[];
    listListeningPorts: () => Promise<number[]>;
    probeServer: (serverUrl: URL, timeoutMs: number) => Promise<LocalMetroServer | undefined>;
    probeTimeoutMs?: number;
  }>,
): Promise<LocalMetroServer | undefined> {
  const ports = await input.listListeningPorts().catch(() => [] as number[]);
  const timeoutMs = input.probeTimeoutMs ?? STATUS_PROBE_TIMEOUT_MS;
  const probes = ports
    .slice(0, MAX_CONCURRENT_STATUS_PROBES)
    .map((port) => input.probeServer(new URL(`http://127.0.0.1:${port}`), timeoutMs));
  const candidates = (await Promise.allSettled(probes))
    .filter(
      (settled): settled is PromiseFulfilledResult<LocalMetroServer | undefined> =>
        settled.status === 'fulfilled',
    )
    .map((settled) => settled.value)
    .filter((candidate): candidate is LocalMetroServer => candidate !== undefined);
  if (candidates.length === 0) return undefined;

  const roots = candidateProjectRoots(input.projectRoots);
  // Only a server that names one of these projects (or one of their parents or children, as a
  // monorepo server reports the repo root) counts. A running server for another project, or one that
  // reports no root at all, is not this session's dev server, and reloading it would act on the
  // wrong app.
  return candidates.find((candidate) =>
    candidate.projectRoot
      ? roots.some((root) => projectRootsOverlap(root, normalizeRealPath(candidate.projectRoot!)))
      : false,
  );
}

async function probeIsRunningDevServer(
  serverUrl: URL,
  probe: MetroDevServerProbe,
): Promise<boolean> {
  const probeServer = probe.probeServer ?? probeLocalMetroServer;
  const confirmed = await probeServer(serverUrl, STATUS_PROBE_TIMEOUT_MS).catch(() => undefined);
  return confirmed !== undefined;
}

async function listLocalListeningPorts(): Promise<number[]> {
  const result = await runCmd('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], {
    allowFailure: true,
    timeoutMs: HOST_READ_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return [];
  const ports = new Set<number>();
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('n')) continue;
    const port = readPortFromSocketName(line.slice(1));
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/** One bounded `/status` read of a loopback address: running dev server, plus its project root. */
async function probeLocalMetroServer(
  serverUrl: URL,
  timeoutMs: number,
): Promise<LocalMetroServer | undefined> {
  try {
    const response = await fetch(new URL('status', serverUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (!body.includes(METRO_STATUS_READY_TEXT)) return undefined;
    const projectRoot = response.headers.get(METRO_PROJECT_ROOT_HEADER);
    return { serverUrl, ...(projectRoot ? { projectRoot } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The typed answer for the case the silent fallback used to swallow: nothing binds this session to a
 * dev server, so the address the fallback would have reached belongs to somebody else.
 */
export function metroDevServerUnresolvedError(): AppError {
  const triedUrl = new URL(`http://${DEFAULT_METRO_HOST}:${DEFAULT_METRO_PORT}`);
  return new AppError(
    'COMMAND_FAILED',
    `React Native dev server is not bound to this session and none was found for its app, so nothing was reloaded. The address the fallback would have used is ${triedUrl.origin}.`,
    {
      reason: METRO_RELOAD_REASONS.devServerUnresolved.reason,
      triedUrl: triedUrl.toString(),
      hint:
        'Pass --metro-port <port> (with --metro-host <host> when it is not localhost) for one call, ' +
        'or run metro prepare, or open with --metro-host/--metro-port so the session keeps the binding.',
    },
  );
}

function readPortFromSocketName(name: string): number | undefined {
  const separator = name.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const port = Number.parseInt(name.slice(separator + 1), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function isLoopbackUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(url.hostname);
}

function projectRootsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function candidateProjectRoots(projectRoots: string[]): string[] {
  const resolved = projectRoots.map((root) => normalizeRealPath(root));
  return [...new Set(resolved)];
}

function normalizeRealPath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseHostAndPort(value: string, scheme: 'http' | 'https'): URL | undefined {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const host = value.slice(0, separator);
  const port = Number.parseInt(value.slice(separator + 1), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  try {
    return new URL(`${scheme}://${host}:${port}`);
  } catch {
    return undefined;
  }
}
