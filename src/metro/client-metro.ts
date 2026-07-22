import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../utils/timeouts.ts';
import { ensureMetroCompanion } from './client-metro-companion.ts';
import type { MetroBridgeScope } from '../client/client-companion-tunnel-contract.ts';
import type {
  MetroBridgeDescriptor,
  MetroBridgeResult,
  MetroBridgeRuntimePayload,
  MetroRuntimeHints,
} from './metro-types.ts';
import { AppError, asAppError } from '../kernel/errors.ts';
import { runCmdSync, runCmdDetached } from '../utils/exec.ts';
import { resolveUserPath } from '../utils/path-resolution.ts';
import { waitForProcessExit } from '../utils/host-process.ts';
import {
  detectProjectRuntimeKindFromPackageJson,
  readProjectPackageJson,
  type PackageJsonShape,
} from '../utils/project-runtime.ts';
import { buildBundleUrl, normalizeBaseUrl } from '../utils/url.ts';
import {
  EXPO_VIRTUAL_ENTRY_BUNDLE_PATH,
  parsePort,
  resolveMetroReloadEndpoints,
} from './metro-reload-endpoints.ts';

const DEV_SERVER_STATUS_READY_TEXT = 'packager-status:running';
const METRO_TERM_TIMEOUT_MS = 1_000;
const METRO_KILL_TIMEOUT_MS = 1_000;

export type MetroPrepareKind = 'auto' | 'react-native' | 'expo' | 'repack';
type ResolvedMetroKind = Exclude<MetroPrepareKind, 'auto'>;
type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;
type RepackBundlerKind = 'rspack' | 'webpack';

export type { MetroBridgeScope } from '../client/client-companion-tunnel-contract.ts';

type PackageManagerConfig = {
  command: string;
  installArgs: string[];
};

type MetroProcessResult = {
  pid: number;
};

type ResolvedMetroPrepareSettings = {
  env: EnvSource;
  projectRoot: string;
  kind: ResolvedMetroKind;
  repackBundler: RepackBundlerKind | null;
  metroPort: number;
  listenHost: string;
  statusHost: string;
  publicBaseUrl: string;
  proxyBaseUrl: string;
  proxyBearerToken: string;
  bridgeScope: MetroBridgeScope | null;
  startupTimeoutMs: number;
  probeTimeoutMs: number;
  reuseExisting: boolean;
  installProjectDeps: boolean;
  runtimeFilePath: string | null;
  logPath: string;
};

type MetroProcessState = {
  started: boolean;
  reused: boolean;
  pid: number;
  statusUrl: string;
};

export type PrepareMetroRuntimeOptions = {
  projectRoot?: string;
  kind?: MetroPrepareKind;
  metroPort?: number | string;
  listenHost?: string;
  statusHost?: string;
  publicBaseUrl?: string;
  proxyBaseUrl?: string;
  proxyBearerToken?: string;
  bridgeScope?: MetroBridgeScope;
  launchUrl?: string;
  companionProfileKey?: string;
  companionConsumerKey?: string;
  startupTimeoutMs?: number | string;
  probeTimeoutMs?: number | string;
  reuseExisting?: boolean;
  installDependenciesIfNeeded?: boolean;
  runtimeFilePath?: string;
  logPath?: string;
  env?: EnvSource;
};

export type PrepareMetroRuntimeResult = {
  projectRoot: string;
  kind: ResolvedMetroKind;
  dependenciesInstalled: boolean;
  packageManager: string | null;
  started: boolean;
  reused: boolean;
  pid: number;
  logPath: string;
  statusUrl: string;
  runtimeFilePath: string | null;
  iosRuntime: MetroRuntimeHints;
  androidRuntime: MetroRuntimeHints;
  bridge: MetroBridgeResult | null;
};

export type ReloadMetroOptions = {
  metroHost?: string;
  metroPort?: number | string;
  bundleUrl?: string;
  runtime?: MetroRuntimeHints;
  timeoutMs?: number | string;
};

/**
 * `transport` says which channel delivered the reload: `http` for the classic GET /reload route,
 * `message-socket` for the /message websocket broadcast used when the server has no HTTP reload
 * route (Expo). `status`/`body` always describe the HTTP probe; on the websocket path `reloadUrl`
 * is the ws(s) message-socket URL.
 */
export type ReloadMetroResult = {
  reloaded: true;
  reloadUrl: string;
  status: number;
  body: string;
  transport: 'http' | 'message-socket';
};

type ProxyBridgeRequestOptions = {
  baseUrl: string;
  bearerToken: string;
  scope: MetroBridgeScope;
  runtime?: MetroBridgeRuntimePayload;
  timeoutMs: number;
};

type MetroBridgeRequestError = Error & {
  retryable?: boolean;
};

function normalizeOptionalBaseUrl(input: unknown): string {
  return typeof input === 'string' && input.trim() ? normalizeBaseUrl(input.trim()) : '';
}

function normalizeOptionalString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function resolvePath(inputPath: string, env: EnvSource, cwd: string): string {
  return resolveUserPath(inputPath, { env, cwd });
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readPackageJson(projectRoot: string): PackageJsonShape {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = readProjectPackageJson(projectRoot);
  if (!packageJson) {
    throw new AppError('INVALID_ARGS', `package.json not found at ${packageJsonPath}`);
  }
  return packageJson;
}

// Nearest lockfile walking up from projectRoot wins (workspace monorepos keep it at the repo
// root); the walk is bounded at the nearest .git entry.
const LOCKFILE_PACKAGE_MANAGERS: ReadonlyArray<{ file: string; command: string }> = [
  { file: 'pnpm-lock.yaml', command: 'pnpm' },
  { file: 'yarn.lock', command: 'yarn' },
  { file: 'bun.lock', command: 'bun' },
  { file: 'bun.lockb', command: 'bun' },
  { file: 'package-lock.json', command: 'npm' },
];

function findLockfilePackageManager(startDir: string): PackageManagerConfig | null {
  let dir = startDir;
  for (;;) {
    for (const { file, command } of LOCKFILE_PACKAGE_MANAGERS) {
      if (fileExists(path.join(dir, file))) {
        return { command, installArgs: ['install'] };
      }
    }
    // .git may be a directory (regular clone) or a file (worktree); either marks the repo root.
    if (fileExists(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function detectPackageManager(projectRoot: string): PackageManagerConfig {
  return findLockfilePackageManager(projectRoot) ?? { command: 'npm', installArgs: ['install'] };
}

function detectMetroKind(
  packageJson: PackageJsonShape,
  requestedKind: MetroPrepareKind,
): ResolvedMetroKind {
  if (requestedKind !== 'auto') {
    return requestedKind;
  }

  const detected = detectProjectRuntimeKindFromPackageJson(packageJson);
  if (detected === 'expo' || detected === 'repack') return detected;
  return 'react-native';
}

function hasPackageDependency(packageJson: PackageJsonShape, dependencyName: string): boolean {
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  return typeof dependencies[dependencyName] === 'string';
}

function hasBundlerConfig(projectRoot: string, basename: RepackBundlerKind): boolean {
  return ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].some((extension) =>
    fileExists(path.join(projectRoot, `${basename}.config.${extension}`)),
  );
}

function detectRepackBundler(
  projectRoot: string,
  packageJson: PackageJsonShape,
): RepackBundlerKind {
  if (hasBundlerConfig(projectRoot, 'rspack')) return 'rspack';
  if (hasBundlerConfig(projectRoot, 'webpack')) return 'webpack';
  if (hasPackageDependency(packageJson, '@rspack/core')) return 'rspack';
  if (hasPackageDependency(packageJson, 'webpack')) return 'webpack';
  return 'rspack';
}

function parseTimeout(
  value: number | string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(parsed, minimum);
}

function metroBundleEntryPath(kind: ResolvedMetroKind): string {
  return kind === 'expo' ? EXPO_VIRTUAL_ENTRY_BUNDLE_PATH : 'index.bundle';
}

function buildMetroRuntimeHints(
  baseUrl: string,
  platform: 'ios' | 'android',
  kind: ResolvedMetroKind,
): MetroRuntimeHints {
  return {
    platform,
    bundleUrl: buildBundleUrl(baseUrl, platform, metroBundleEntryPath(kind)),
  };
}

function normalizeProxyRuntimeHints(
  value: MetroBridgeRuntimePayload | undefined,
  platform: 'ios' | 'android',
): MetroRuntimeHints {
  return {
    platform,
    metroHost: normalizeOptionalString(value?.metro_host),
    metroPort: value?.metro_port,
    bundleUrl: normalizeOptionalString(value?.metro_bundle_url),
    launchUrl: normalizeOptionalString(value?.launch_url),
  };
}

function installDependenciesIfNeeded(
  projectRoot: string,
  env: EnvSource,
): { installed: boolean; packageManager?: string } {
  if (directoryExists(path.join(projectRoot, 'node_modules'))) {
    return { installed: false };
  }

  const packageManager = detectPackageManager(projectRoot);
  try {
    runCmdSync(packageManager.command, packageManager.installArgs, {
      cwd: projectRoot,
      env: env as NodeJS.ProcessEnv,
    });
  } catch (error) {
    throw wrapDependencyInstallError(error, packageManager);
  }
  return { installed: true, packageManager: packageManager.command };
}

function wrapDependencyInstallError(
  error: unknown,
  packageManager: PackageManagerConfig,
): AppError {
  const appErr = asAppError(error);
  const hint =
    `Dependency install failed using detected package manager "${packageManager.command}". ` +
    'If dependencies are already installed (for example via a monorepo root install), pass ' +
    '--no-install-deps to skip this step, or install manually with ' +
    `"${packageManager.command} ${packageManager.installArgs.join(' ')}" from the project root.`;
  return new AppError(
    appErr.code,
    appErr.message,
    { ...(appErr.details ?? {}), hint, packageManager: packageManager.command },
    appErr,
  );
}

async function wait(ms: number): Promise<void> {
  await sleep(ms);
}

async function fetchText(
  url: string,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const response = await fetch(url, {
      headers: extraHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AppError('COMMAND_FAILED', `Timed out fetching ${url} after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function isMetroReady(statusUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchText(statusUrl, timeoutMs);
    return response.ok && response.body.includes(DEV_SERVER_STATUS_READY_TEXT);
  } catch {
    return false;
  }
}

function buildMetroCommand(
  kind: ResolvedMetroKind,
  repackBundler: RepackBundlerKind | null,
  port: number,
  listenHost: string,
): PackageManagerConfig {
  if (kind === 'expo') {
    return {
      command: 'npx',
      installArgs: ['expo', 'start', '--host', 'lan', '--port', String(port)],
    };
  }
  if (kind === 'repack') {
    const commandName = repackBundler === 'webpack' ? 'webpack-start' : 'rspack-start';
    return {
      command: 'npx',
      installArgs: ['react-native', commandName, '--host', listenHost, '--port', String(port)],
    };
  }

  return {
    command: 'npx',
    installArgs: ['react-native', 'start', '--host', listenHost, '--port', String(port)],
  };
}

function startMetroProcess(
  projectRoot: string,
  kind: ResolvedMetroKind,
  repackBundler: RepackBundlerKind | null,
  port: number,
  listenHost: string,
  logPath: string,
  env: EnvSource,
): MetroProcessResult {
  const metro = buildMetroCommand(kind, repackBundler, port, listenHost);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  let pid = 0;
  try {
    // cwd is --project-root; monorepo-root module resolution beyond that is Expo's own behavior.
    pid = runCmdDetached(metro.command, metro.installArgs, {
      cwd: projectRoot,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to start React Native dev server. Expected a detached child PID.',
    );
  }

  return {
    pid,
  };
}

async function stopSpawnedMetroProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw error;
  }
  if (await waitForProcessExit(pid, METRO_TERM_TIMEOUT_MS)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw error;
  }
  await waitForProcessExit(pid, METRO_KILL_TIMEOUT_MS);
}

function createProxyHeaders(baseUrl: string, bearerToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearerToken}`,
    'Content-Type': 'application/json',
    ...(baseUrl.includes('ngrok') ? { 'ngrok-skip-browser-warning': '1' } : {}),
  };
}

function createMetroBridgeRequestError(
  message: string,
  retryable: boolean,
): MetroBridgeRequestError {
  const error = new AppError('COMMAND_FAILED', message) as MetroBridgeRequestError;
  error.retryable = retryable;
  return error;
}

function isRetryableBridgeHttpFailure(statusCode: number, responsePayload: unknown): boolean {
  if (statusCode >= 500 || statusCode === 408 || statusCode === 425 || statusCode === 429) {
    return true;
  }
  const responseText = JSON.stringify(responsePayload);
  if (responseText.includes('Metro companion is not connected')) {
    return true;
  }
  return false;
}

function isRetryableBridgeError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    (error as MetroBridgeRequestError).retryable === true,
  );
}

async function configureMetroBridge(input: ProxyBridgeRequestOptions): Promise<MetroBridgeResult> {
  let response: Response;

  try {
    response = await fetch(`${input.baseUrl}/api/metro/bridge`, {
      method: 'POST',
      headers: createProxyHeaders(input.baseUrl, input.bearerToken),
      body: JSON.stringify({
        ...input.scope,
        ...(input.runtime ? { ios_runtime: input.runtime } : {}),
        timeout_ms: input.timeoutMs,
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw createMetroBridgeRequestError(
        `/api/metro/bridge timed out after ${input.timeoutMs}ms calling ${input.baseUrl}/api/metro/bridge`,
        true,
      );
    }
    throw createMetroBridgeRequestError(
      error instanceof Error ? error.message : String(error),
      true,
    );
  }

  const responseText = await response.text();
  const responsePayload = parseMetroBridgeResponsePayload(
    responseText,
    response.status,
    input.baseUrl,
  );

  if (!response.ok) {
    throw createMetroBridgeRequestError(
      `/api/metro/bridge failed (${response.status}): ${JSON.stringify(responsePayload)}`,
      isRetryableBridgeHttpFailure(response.status, responsePayload),
    );
  }

  return normalizeMetroBridgeResponsePayload(responsePayload);
}

function parseMetroBridgeResponsePayload(
  responseText: string,
  statusCode: number,
  baseUrl: string,
): Record<string, unknown> {
  if (!responseText) return {};
  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const snippet = responseText.slice(0, 200);
    const detail = error instanceof Error ? error.message : String(error);
    throw createMetroBridgeRequestError(
      `/api/metro/bridge returned invalid JSON (${statusCode}) from ${baseUrl}: ${detail}. body=${JSON.stringify(snippet)}`,
      isRetryableBridgeHttpFailure(statusCode, responseText),
    );
  }
}

function normalizeBridgeResponse(response: MetroBridgeDescriptor): MetroBridgeResult {
  return {
    enabled: response.enabled,
    baseUrl: response.base_url,
    statusUrl: response.status_url ?? '',
    bundleUrl: response.bundle_url ?? '',
    iosRuntime: normalizeProxyRuntimeHints(response.ios_runtime, 'ios'),
    androidRuntime: normalizeProxyRuntimeHints(response.android_runtime, 'android'),
    upstream: {
      bundleUrl: response.upstream.bundle_url ?? '',
      host: response.upstream.host ?? '',
      port: response.upstream.port ?? 0,
      statusUrl: response.upstream.status_url ?? '',
    },
    probe: {
      reachable: response.probe.reachable,
      statusCode: response.probe.status_code,
      latencyMs: response.probe.latency_ms,
      detail: response.probe.detail,
    },
  };
}

function normalizeMetroBridgeResponsePayload(
  responsePayload: Record<string, unknown>,
): MetroBridgeResult {
  const descriptor = responsePayload.data ?? responsePayload;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw createMetroBridgeRequestError(
      '/api/metro/bridge returned malformed descriptor: Expected a JSON object.',
      false,
    );
  }
  try {
    return normalizeBridgeResponse(descriptor as MetroBridgeDescriptor);
  } catch (error) {
    throw createMetroBridgeRequestError(
      `/api/metro/bridge returned malformed descriptor: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

function describeBridgeFailure(
  baseUrl: string,
  bridgeError: string | null,
  bridge: MetroBridgeResult | null,
  initialBridgeError?: string | null,
  companionLogPath?: string,
): string {
  const parts = [
    `Metro bridge is required for this run but could not be configured via ${baseUrl}/api/metro/bridge.`,
  ];

  if (bridgeError) {
    parts.push(`bridgeError=${bridgeError}`);
  }
  if (bridge?.probe.reachable === false) {
    parts.push(
      `bridgeProbe=${bridge.probe.detail || `unreachable (status ${bridge.probe.statusCode || 0})`}`,
    );
  }
  if (initialBridgeError && initialBridgeError !== bridgeError) {
    parts.push(`initialBridgeError=${initialBridgeError}`);
  }
  if (companionLogPath) {
    parts.push(`metroCompanionLog=${companionLogPath}`);
  }

  return parts.join(' ');
}

function requireBridgeRuntimeDescriptor(baseUrl: string, bridge: MetroBridgeResult | null): void {
  if (!bridge?.iosRuntime.bundleUrl) {
    throw new AppError(
      'COMMAND_FAILED',
      describeBridgeFailure(
        baseUrl,
        'bridge descriptor is missing ios_runtime.metro_bundle_url',
        bridge,
      ),
    );
  }
}

function resolveProxySettings(
  proxyBaseUrl: string,
  proxyBearerToken: string,
  env: EnvSource,
): {
  proxyEnabled: boolean;
  proxyBaseUrl: string;
  proxyBearerToken: string;
} {
  const proxySpecificBearerToken =
    proxyBearerToken || normalizeOptionalString(env.AGENT_DEVICE_METRO_BEARER_TOKEN) || '';
  const resolvedProxyBearerToken =
    proxySpecificBearerToken ||
    (proxyBaseUrl ? normalizeOptionalString(env.AGENT_DEVICE_DAEMON_AUTH_TOKEN) || '' : '');
  if (proxyBaseUrl && !resolvedProxyBearerToken) {
    throw new AppError(
      'INVALID_ARGS',
      'metro prepare requires proxy auth when --proxy-base-url is provided. Pass --bearer-token or set AGENT_DEVICE_METRO_BEARER_TOKEN or AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    );
  }
  if (!proxyBaseUrl && proxySpecificBearerToken) {
    throw new AppError(
      'INVALID_ARGS',
      'metro prepare requires --proxy-base-url when proxy auth is provided.',
    );
  }
  return {
    proxyEnabled: Boolean(proxyBaseUrl && resolvedProxyBearerToken),
    proxyBaseUrl,
    proxyBearerToken: resolvedProxyBearerToken,
  };
}

function requireBridgeScope(scope: MetroBridgeScope | undefined): MetroBridgeScope {
  if (!scope?.tenantId || !scope.runId || !scope.leaseId) {
    throw new AppError(
      'INVALID_ARGS',
      'metro prepare with proxy requires tenantId, runId, and leaseId bridge scope.',
    );
  }
  return scope;
}

function requireMetroBaseUrl(publicBaseUrl: string, proxyBaseUrl: string): void {
  if (publicBaseUrl || proxyBaseUrl) {
    return;
  }
  throw new AppError(
    'INVALID_ARGS',
    'metro prepare requires --public-base-url <url> or --proxy-base-url <url>.',
  );
}

function resolveMetroRuntimeFilePath(
  input: PrepareMetroRuntimeOptions,
  env: EnvSource,
  cwd: string,
): string | null {
  return input.runtimeFilePath ? resolvePath(input.runtimeFilePath, env, cwd) : null;
}

function resolveMetroLogPath(
  input: PrepareMetroRuntimeOptions,
  env: EnvSource,
  cwd: string,
  projectRoot: string,
): string {
  return resolvePath(
    input.logPath ?? path.join(projectRoot, '.agent-device', 'metro.log'),
    env,
    cwd,
  );
}

function resolveMetroPrepareSettings(
  input: PrepareMetroRuntimeOptions,
): ResolvedMetroPrepareSettings {
  const env = input.env ?? process.env;
  const cwd = process.cwd();
  const projectRoot = resolvePath(input.projectRoot ?? cwd, env, cwd);
  const requestedKind = input.kind ?? 'auto';
  let packageJson: PackageJsonShape | null = null;
  let kind: ResolvedMetroKind;
  if (requestedKind === 'auto') {
    packageJson = readPackageJson(projectRoot);
    kind = detectMetroKind(packageJson, requestedKind);
  } else {
    kind = requestedKind;
  }
  let repackBundler: RepackBundlerKind | null = null;
  if (kind === 'repack') {
    packageJson ??= readPackageJson(projectRoot);
    repackBundler = detectRepackBundler(projectRoot, packageJson);
  }
  const publicBaseUrl = normalizeOptionalBaseUrl(input.publicBaseUrl);
  const proxyBaseUrlInput = normalizeOptionalBaseUrl(input.proxyBaseUrl);
  requireMetroBaseUrl(publicBaseUrl, proxyBaseUrlInput);

  const { proxyEnabled, proxyBaseUrl, proxyBearerToken } = resolveProxySettings(
    proxyBaseUrlInput,
    normalizeOptionalString(input.proxyBearerToken) ?? '',
    env,
  );

  return {
    env,
    projectRoot,
    kind,
    repackBundler,
    metroPort: parsePort(input.metroPort ?? 8081, 8081),
    listenHost: normalizeOptionalString(input.listenHost) ?? '0.0.0.0',
    statusHost: normalizeOptionalString(input.statusHost) ?? '127.0.0.1',
    publicBaseUrl,
    proxyBaseUrl,
    proxyBearerToken,
    bridgeScope: proxyEnabled ? requireBridgeScope(input.bridgeScope) : null,
    startupTimeoutMs: parseTimeout(input.startupTimeoutMs, 180_000, 30_000),
    probeTimeoutMs: parseTimeout(input.probeTimeoutMs, 10_000, 1_000),
    reuseExisting: input.reuseExisting ?? true,
    installProjectDeps: input.installDependenciesIfNeeded ?? true,
    runtimeFilePath: resolveMetroRuntimeFilePath(input, env, cwd),
    logPath: resolveMetroLogPath(input, env, cwd, projectRoot),
  };
}

async function waitForMetroReady(
  statusUrl: string,
  startupTimeoutMs: number,
  probeTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const requestTimeoutMs = Math.min(probeTimeoutMs, Math.max(remainingMs, 1));
    if (await isMetroReady(statusUrl, requestTimeoutMs)) {
      return true;
    }
    const sleepMs = Math.min(500, Math.max(deadline - Date.now(), 0));
    if (sleepMs > 0) {
      await wait(sleepMs);
    }
  }
  return false;
}

async function configureMetroBridgeUntilReady(options: {
  baseUrl: string;
  bearerToken: string;
  scope: MetroBridgeScope;
  runtime?: MetroBridgeRuntimePayload;
  probeTimeoutMs: number;
  startupTimeoutMs: number;
  initialBridgeError?: string | null;
  companionLogPath?: string;
}): Promise<MetroBridgeResult> {
  const deadline = Date.now() + options.startupTimeoutMs;
  let lastBridge: MetroBridgeResult | null = null;
  let lastBridgeError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const bridge = await configureMetroBridge({
        baseUrl: options.baseUrl,
        bearerToken: options.bearerToken,
        scope: options.scope,
        runtime: options.runtime,
        timeoutMs: options.probeTimeoutMs,
      });
      if (bridge.probe.reachable !== false) {
        return bridge;
      }
      lastBridge = bridge;
      lastBridgeError = null;
    } catch (error) {
      lastBridgeError = error instanceof Error ? error.message : String(error);
      if (!isRetryableBridgeError(error)) {
        throw new AppError(
          'COMMAND_FAILED',
          describeBridgeFailure(
            options.baseUrl,
            lastBridgeError,
            lastBridge,
            options.initialBridgeError,
            options.companionLogPath,
          ),
          undefined,
          error,
        );
      }
    }

    const sleepMs = Math.min(1_000, Math.max(deadline - Date.now(), 0));
    if (sleepMs > 0) {
      await wait(sleepMs);
    }
  }

  throw new AppError(
    'COMMAND_FAILED',
    describeBridgeFailure(
      options.baseUrl,
      lastBridgeError,
      lastBridge,
      options.initialBridgeError,
      options.companionLogPath,
    ),
  );
}

async function ensureMetroProcessReady(
  settings: ResolvedMetroPrepareSettings,
): Promise<MetroProcessState> {
  const statusUrl = `http://${settings.statusHost}:${settings.metroPort}/status`;
  if (settings.reuseExisting && (await isMetroReady(statusUrl, settings.probeTimeoutMs))) {
    return { started: false, reused: true, pid: 0, statusUrl };
  }

  const startedProcess = startMetroProcess(
    settings.projectRoot,
    settings.kind,
    settings.repackBundler,
    settings.metroPort,
    settings.listenHost,
    settings.logPath,
    settings.env,
  );

  if (await waitForMetroReady(statusUrl, settings.startupTimeoutMs, settings.probeTimeoutMs)) {
    return { started: true, reused: false, pid: startedProcess.pid, statusUrl };
  }

  await stopSpawnedMetroProcess(startedProcess.pid).catch(() => {});
  throw new AppError(
    'COMMAND_FAILED',
    `React Native dev server did not become ready at ${statusUrl} within ${settings.startupTimeoutMs}ms. Check ${settings.logPath}.`,
    { logPath: settings.logPath },
  );
}

async function configureProxyBridgeForRuntime(
  input: PrepareMetroRuntimeOptions,
  settings: ResolvedMetroPrepareSettings,
): Promise<MetroBridgeResult | null> {
  const bridgeScope = settings.bridgeScope;
  if (!bridgeScope) {
    return null;
  }

  let bridge: MetroBridgeResult | null = null;
  let initialBridgeError: string | null = null;
  try {
    bridge = await configureMetroBridge({
      baseUrl: settings.proxyBaseUrl,
      bearerToken: settings.proxyBearerToken,
      scope: bridgeScope,
      timeoutMs: settings.probeTimeoutMs,
    });
  } catch (error) {
    if (!isRetryableBridgeError(error)) {
      throw error;
    }
    initialBridgeError = error instanceof Error ? error.message : String(error);
  }

  if (!bridge || bridge.probe.reachable === false) {
    bridge = await configureProxyBridgeViaCompanion(
      input,
      settings,
      bridgeScope,
      bridge,
      initialBridgeError,
    );
  }

  requireBridgeRuntimeDescriptor(settings.proxyBaseUrl, bridge);
  return bridge;
}

async function configureProxyBridgeViaCompanion(
  input: PrepareMetroRuntimeOptions,
  settings: ResolvedMetroPrepareSettings,
  bridgeScope: MetroBridgeScope,
  bridge: MetroBridgeResult | null,
  initialBridgeError: string | null,
): Promise<MetroBridgeResult> {
  let companionLogPath: string | undefined;
  try {
    const companion = await ensureMetroCompanion({
      projectRoot: settings.projectRoot,
      serverBaseUrl: settings.proxyBaseUrl,
      bearerToken: settings.proxyBearerToken,
      bridgeScope,
      localBaseUrl: `http://${settings.statusHost}:${settings.metroPort}`,
      launchUrl: normalizeOptionalString(input.launchUrl),
      profileKey: normalizeOptionalString(input.companionProfileKey),
      consumerKey: normalizeOptionalString(input.companionConsumerKey),
      env: settings.env as NodeJS.ProcessEnv,
    });
    companionLogPath = companion.logPath;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      describeBridgeFailure(
        settings.proxyBaseUrl,
        error instanceof Error ? error.message : String(error),
        bridge,
        initialBridgeError,
      ),
      undefined,
      error,
    );
  }

  try {
    return await configureMetroBridgeUntilReady({
      baseUrl: settings.proxyBaseUrl,
      bearerToken: settings.proxyBearerToken,
      scope: bridgeScope,
      probeTimeoutMs: settings.probeTimeoutMs,
      startupTimeoutMs: settings.startupTimeoutMs,
      initialBridgeError,
      companionLogPath,
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function buildBaseRuntimeHints(
  publicBaseUrl: string,
  kind: ResolvedMetroKind,
): {
  baseIosRuntime: MetroRuntimeHints;
  baseAndroidRuntime: MetroRuntimeHints;
} {
  return {
    baseIosRuntime: publicBaseUrl
      ? buildMetroRuntimeHints(publicBaseUrl, 'ios', kind)
      : { platform: 'ios' as const },
    baseAndroidRuntime: publicBaseUrl
      ? buildMetroRuntimeHints(publicBaseUrl, 'android', kind)
      : { platform: 'android' as const },
  };
}

function writeMetroRuntimeFile(
  runtimeFilePath: string | null,
  result: PrepareMetroRuntimeResult,
): void {
  if (!runtimeFilePath) {
    return;
  }
  fs.mkdirSync(path.dirname(runtimeFilePath), { recursive: true });
  fs.writeFileSync(runtimeFilePath, JSON.stringify(result, null, 2));
}

export async function prepareMetroRuntime(
  input: PrepareMetroRuntimeOptions = {},
): Promise<PrepareMetroRuntimeResult> {
  const settings = resolveMetroPrepareSettings(input);
  const dependencyInstall = settings.installProjectDeps
    ? installDependenciesIfNeeded(settings.projectRoot, settings.env)
    : { installed: false as const };
  const processState = await ensureMetroProcessReady(settings);
  const { baseIosRuntime, baseAndroidRuntime } = buildBaseRuntimeHints(
    settings.publicBaseUrl,
    settings.kind,
  );
  const bridge = await configureProxyBridgeForRuntime(input, settings);

  const iosRuntime = bridge?.iosRuntime ?? baseIosRuntime;
  const androidRuntime = bridge?.androidRuntime ?? baseAndroidRuntime;
  const result: PrepareMetroRuntimeResult = {
    projectRoot: settings.projectRoot,
    kind: settings.kind,
    dependenciesInstalled: dependencyInstall.installed,
    packageManager: dependencyInstall.packageManager ?? null,
    started: processState.started,
    reused: processState.reused,
    pid: processState.pid,
    logPath: settings.logPath,
    statusUrl: processState.statusUrl,
    runtimeFilePath: settings.runtimeFilePath,
    iosRuntime,
    androidRuntime,
    bridge,
  };

  writeMetroRuntimeFile(settings.runtimeFilePath, result);
  return result;
}

// An HTML document on a 2xx means the server has no HTTP reload route and answered with the app
// page fallback (Expo does this), so a 200 there must not be reported as a successful reload.
function looksLikeHtmlDocumentBody(body: string): boolean {
  const head = body.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

// {"version":2,"method":"reload"} on the /message websocket is the broadcast the dev-server CLIs
// send for the `r` key; servers without an HTTP /reload route (Expo) only support this channel.
async function broadcastReloadOverMessageSocket(
  messageSocketUrl: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(messageSocketUrl);
    const fail = (message: string): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Socket may already be closed.
      }
      reject(new AppError('COMMAND_FAILED', message));
    };
    const timer = setTimeout(() => {
      fail(`Timed out broadcasting reload to ${messageSocketUrl} after ${timeoutMs}ms`);
    }, timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ version: 2, method: 'reload' }));
      const settle = (): void => {
        if (socket.bufferedAmount === 0) {
          clearTimeout(timer);
          socket.close();
          resolve();
          return;
        }
        setTimeout(settle, 20);
      };
      settle();
    });
    socket.addEventListener('error', () => {
      fail(`Failed to reach the dev server message socket at ${messageSocketUrl}`);
    });
  });
}

export async function reloadMetro(input: ReloadMetroOptions = {}): Promise<ReloadMetroResult> {
  const timeoutMs = parseTimeout(input.timeoutMs, 10_000, 1_000);
  const { reloadUrl, messageSocketUrl } = resolveMetroReloadEndpoints(input);
  const response = await fetchText(reloadUrl, timeoutMs);
  if (response.ok && !looksLikeHtmlDocumentBody(response.body)) {
    return {
      reloaded: true,
      reloadUrl,
      status: response.status,
      body: response.body,
      transport: 'http',
    };
  }
  try {
    await broadcastReloadOverMessageSocket(messageSocketUrl, timeoutMs);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `React Native dev server reload failed (${response.status}).`,
      {
        reloadUrl,
        status: response.status,
        body: response.body.slice(0, 500),
        messageSocketUrl,
        hint: 'Verify Metro or Re.Pack is running and the target React Native app is connected to this dev server instance.',
      },
      error instanceof Error ? error : undefined,
    );
  }
  return {
    reloaded: true,
    reloadUrl: messageSocketUrl,
    status: response.status,
    body: '',
    transport: 'message-socket',
  };
}
