import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackHostname } from '@agent-device/daemon-contracts/daemon-resolution';
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
import {
  isMetroStatusBody,
  parseAppReportedServerUrl,
  parseLsofListeningPorts,
  parseMetroProjectRootHeader,
  parseNetstatListeningPorts,
  projectRootsOverlap,
} from './metro-dev-server-parsing.ts';

/**
 * The session's app, as `open` recorded it. `hostedLocally` is the trait `open` observed — the
 * session's device runs on the machine that hosts the record — so a reload knows whether it may read
 * this machine's simulator containers and listening ports at all.
 */
export type MetroAppTarget = Readonly<{
  platform: 'ios' | 'android';
  deviceKind?: 'simulator' | 'emulator' | 'device';
  deviceId: string;
  appId?: string;
  hostedLocally?: boolean;
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

const SIMULATOR_DEVICES_ROOT = 'Library/Developer/CoreSimulator/Devices';
const METRO_PROJECT_ROOT_HEADER = 'x-react-native-project-root';
// A live machine answers these reads slowly: `lsof` walks every process's descriptors and took over
// 1.5 s on a developer Mac with simulators running. The budget has to be the slow machine's, because
// a timeout here is indistinguishable from "this machine listens on nothing".
const HOST_READ_TIMEOUT_MS = 4_000;
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
 *    the app's preferences. The app cannot be wrong about the server it loads its bundle from, but a
 *    live server at that address still has to serve this project to count.
 * 3. A local dev server that serves the current project.
 *
 * Only a session whose device `open` proved is this daemon's own local device reaches steps 2 and 3:
 * a provider device's host is not this machine, so its sessions keep their existing behavior, the
 * default address included. With no signal at all, this fails typed rather than calling
 * `localhost:8081`, which in an unbound session belongs to whichever project owns that port.
 */
export async function resolveMetroReloadServerUrl(
  input: ResolveMetroReloadServerInput,
): Promise<ResolvedMetroReloadServer> {
  if (isMetroTargetBound(input)) {
    return { serverUrl: resolveMetroServerUrl(input), resolvedBy: 'binding' };
  }

  const app = input.app;
  if (!app || !canDiscoverForApp(app)) {
    // Nothing to discover from: no recorded app, or an app whose host this machine cannot prove. The
    // address the caller's hints resolve to, default included, stays what it always was.
    return { serverUrl: resolveMetroServerUrl(input), resolvedBy: 'default' };
  }

  const host = input.host;
  const probe = input.probe ?? {};
  const projectRoots = candidateProjectRoots([input.projectRoot ?? host.cwd, host.cwd]);
  const reported = await (probe.readAppReportedServerUrl ?? readAppReportedMetroServerUrl)(
    app,
    host,
  ).catch(() => undefined);
  if (reported && (await servesProjectRoot(reported, projectRoots, probe))) {
    // The app cannot be wrong about the server it loads from, but its stored address can outlive
    // that server, and somebody else's Metro can take the port. On loopback, where this host can
    // answer for it, one bounded probe settles both questions.
    return { serverUrl: reported, resolvedBy: 'app-reported' };
  }

  const discovered = await discoverLocalMetroServer({
    projectRoots,
    listListeningPorts: probe.listListeningPorts ?? listLocalListeningPorts,
    probeServer: probe.probeServer ?? probeLocalMetroServer,
  });
  if (discovered) {
    return { serverUrl: discovered.serverUrl, resolvedBy: 'local-project-root' };
  }

  throw metroDevServerUnresolvedError();
}

/**
 * Whether reload may look for a dev server on this machine for a session's app. It may, only when
 * `open` recorded the app's device as this daemon's own local device. A provider device runs somewhere
 * else, so its dev server is not one of this machine's ports, and probing here would answer a question
 * nobody asked.
 */
export function canDiscoverForApp(app: MetroAppTarget | undefined): boolean {
  return app?.hostedLocally === true;
}

/**
 * Confirms an app-reported address against the project it must serve. A server that is not running,
 * or one that names a project unrelated to this session, is refused. A server that reports no root at
 * all is accepted: the app named this address itself, and older dev servers send no root header.
 */
async function servesProjectRoot(
  serverUrl: URL,
  projectRoots: string[],
  probe: MetroDevServerProbe,
): Promise<boolean> {
  if (!isLoopbackHostname(serverUrl.hostname)) return true;
  const probeServer = probe.probeServer ?? probeLocalMetroServer;
  const running = await probeServer(serverUrl, STATUS_PROBE_TIMEOUT_MS).catch(() => undefined);
  // The app named this address itself, so a server that answers and names no root stays what it
  // reported. Only a root that names a different project refuses it.
  if (!running) return false;
  return running.projectRoot === undefined || matchesProjectRoot(running, projectRoots);
}

/**
 * What the app itself reports: React Native keeps `RCT_jsLocation` in the app's own preferences
 * plist — the same key `open --metro-host/--metro-port` writes — and the simulator host reads that
 * file from the device container without a device round-trip. A physical device, an Android app, or
 * an app that never stored an address reports nothing.
 */
export async function readAppReportedMetroServerUrl(
  app: MetroAppTarget,
  host: HostEnvironment,
): Promise<URL | undefined> {
  if (app.platform !== 'ios' || app.deviceKind !== 'simulator' || !app.appId) return undefined;
  const home = host.env.HOME;
  if (!home) return undefined;
  const settingsJson = await readSimulatorAppPreferences(app, home);
  return settingsJson === undefined ? undefined : parseAppReportedServerUrl(settingsJson);
}

/** The app's preferences plist as JSON, or undefined when the host cannot answer for it. */
async function readSimulatorAppPreferences(
  app: MetroAppTarget,
  home: string,
): Promise<string | undefined> {
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
  }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  return result.stdout;
}

/**
 * The local dev server that serves this project: a listening port whose `/status` answers
 * `packager-status:running` and whose `X-React-Native-Project-Root` is one of the project roots or a
 * parent or child of one (a monorepo server serves from the repo root). Ports come from what a local
 * process actually listens on, each probe is short, and they run bounded in parallel, so a miss costs
 * one bounded sweep rather than a reload timeout. A project-root match always wins, and a server that
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
  const servers = await probePorts(ports, input.probeServer, timeoutMs);
  const roots = candidateProjectRoots(input.projectRoots);
  return servers.find((candidate) => matchesProjectRoot(candidate, roots));
}

/** Probes every port, at most MAX_CONCURRENT_STATUS_PROBES at a time, keeping probe failures quiet. */
async function probePorts(
  ports: number[],
  probeServer: (serverUrl: URL, timeoutMs: number) => Promise<LocalMetroServer | undefined>,
  timeoutMs: number,
): Promise<LocalMetroServer[]> {
  const servers: LocalMetroServer[] = [];
  for (let start = 0; start < ports.length; start += MAX_CONCURRENT_STATUS_PROBES) {
    const batch = ports
      .slice(start, start + MAX_CONCURRENT_STATUS_PROBES)
      .map((port) => probeServer(new URL(`http://127.0.0.1:${port}`), timeoutMs));
    for (const settled of await Promise.allSettled(batch)) {
      if (settled.status === 'fulfilled' && settled.value) servers.push(settled.value);
    }
  }
  return servers;
}

function matchesProjectRoot(candidate: LocalMetroServer, projectRoots: string[]): boolean {
  if (!candidate.projectRoot) return false;
  const serverRoot = normalizeRealPath(candidate.projectRoot);
  return projectRoots.some((root) => projectRootsOverlap(root, serverRoot));
}

function normalizeRealPath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

/**
 * The ports this host's processes listen on: what `lsof` reports, or, where `lsof` is not installed,
 * what `netstat` reports. A host with neither tool yields no ports, and reload answers with the typed
 * failure rather than a crash or a guess.
 */
export async function listLocalListeningPorts(): Promise<number[]> {
  const lsof = await runHostCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']);
  if (lsof !== undefined) {
    const ports = parseLsofListeningPorts(lsof);
    if (ports.length > 0) return ports;
  }
  const netstat = await runHostCommand('netstat', ['-an', '-p', 'tcp']);
  return netstat === undefined ? [] : parseNetstatListeningPorts(netstat);
}

/** A host command's stdout, or undefined when it is missing, fails, or times out. */
async function runHostCommand(command: string, args: string[]): Promise<string | undefined> {
  const result = await runCmd(command, args, {
    allowFailure: true,
    timeoutMs: HOST_READ_TIMEOUT_MS,
  }).catch(() => undefined);
  return result && result.exitCode === 0 ? result.stdout : undefined;
}

/** One bounded `/status` read of a loopback address: running dev server, plus its project root. */
export async function probeLocalMetroServer(
  serverUrl: URL,
  timeoutMs: number,
): Promise<LocalMetroServer | undefined> {
  try {
    const response = await fetch(new URL('status', serverUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (!isMetroStatusBody(body)) return undefined;
    const projectRoot = parseMetroProjectRootHeader(
      response.headers.get(METRO_PROJECT_ROOT_HEADER),
    );
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

function candidateProjectRoots(projectRoots: string[]): string[] {
  const resolved = projectRoots.map((root) => normalizeRealPath(root));
  return [...new Set(resolved)];
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
