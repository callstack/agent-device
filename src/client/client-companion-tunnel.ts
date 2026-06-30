import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENV_COMPANION_TUNNEL_BEARER_TOKEN,
  ENV_COMPANION_TUNNEL_DEVICE_PORT,
  ENV_COMPANION_TUNNEL_LAUNCH_URL,
  ENV_COMPANION_TUNNEL_LOCAL_BASE_URL,
  ENV_COMPANION_TUNNEL_REGISTER_PATH,
  ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID,
  ENV_COMPANION_TUNNEL_SCOPE_RUN_ID,
  ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID,
  ENV_COMPANION_TUNNEL_SERVER_BASE_URL,
  ENV_COMPANION_TUNNEL_SESSION,
  ENV_COMPANION_TUNNEL_STATE_PATH,
  ENV_COMPANION_TUNNEL_UNREGISTER_PATH,
} from './client-companion-tunnel-contract.ts';
import type { CompanionTunnelScope } from './client-companion-tunnel-contract.ts';
import { normalizeBaseUrl } from '../utils/url.ts';
import { runCmdDetached } from '../utils/exec.ts';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '../utils/process-identity.ts';

const COMPANION_TUNNEL_TERM_TIMEOUT_MS = 1_000;
const COMPANION_TUNNEL_KILL_TIMEOUT_MS = 1_000;
const COMPANION_TUNNEL_ENTRYPOINT = 'companion-tunnel';

export type CompanionTunnelDefinition = {
  slug: string;
  runArg: string;
  displayName: string;
};

type CompanionTunnelState = {
  pid: number;
  startTime?: string;
  command?: string;
  serverBaseUrl: string;
  localBaseUrl: string;
  launchUrl?: string;
  registerPath?: string;
  unregisterPath?: string;
  devicePort?: number;
  session?: string;
  bridgeScope?: CompanionTunnelScope;
  tokenHash: string;
  consumers: string[];
};

export type EnsureCompanionTunnelOptions = {
  projectRoot: string;
  serverBaseUrl: string;
  bearerToken: string;
  localBaseUrl: string;
  bridgeScope: CompanionTunnelScope;
  definition: CompanionTunnelDefinition;
  launchUrl?: string;
  registerPath?: string;
  unregisterPath?: string;
  devicePort?: number;
  session?: string;
  profileKey?: string;
  consumerKey?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type EnsureCompanionTunnelResult = {
  pid: number;
  spawned: boolean;
  statePath: string;
  logPath: string;
};

export type StopCompanionTunnelOptions = {
  projectRoot: string;
  definition: CompanionTunnelDefinition;
  stateDir?: string;
  profileKey?: string;
  consumerKey?: string;
};

function hashString(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeOptionalString(input: string | undefined): string | undefined {
  return input?.trim() ? input.trim() : undefined;
}

function readCompanionScope(input: unknown): CompanionTunnelScope | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Partial<CompanionTunnelScope>;
  if (
    typeof record.tenantId !== 'string' ||
    typeof record.runId !== 'string' ||
    typeof record.leaseId !== 'string'
  ) {
    return undefined;
  }
  return {
    tenantId: record.tenantId,
    runId: record.runId,
    leaseId: record.leaseId,
  };
}

function areCompanionScopesEqual(a: CompanionTunnelScope, b: CompanionTunnelScope): boolean {
  return a.tenantId === b.tenantId && a.runId === b.runId && a.leaseId === b.leaseId;
}

function resolveCompanionTunnelPaths(
  projectRoot: string,
  definition: CompanionTunnelDefinition,
  profileKey?: string,
  stateDir?: string,
): { statePath: string; logPath: string } {
  const dir = stateDir ?? path.join(projectRoot, '.agent-device');
  if (!profileKey) {
    return {
      statePath: path.join(dir, `${definition.slug}.json`),
      logPath: path.join(dir, `${definition.slug}.log`),
    };
  }
  const profileHash = hashString(profileKey).slice(0, 12);
  const profileDir = path.join(dir, definition.slug);
  return {
    statePath: path.join(profileDir, `${definition.slug}-${profileHash}.json`),
    logPath: path.join(profileDir, `${definition.slug}-${profileHash}.log`),
  };
}

function readCompanionState(statePath: string): CompanionTunnelState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<CompanionTunnelState>;
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return null;
    if (typeof parsed.serverBaseUrl !== 'string' || typeof parsed.localBaseUrl !== 'string') {
      return null;
    }
    if (typeof parsed.tokenHash !== 'string' || parsed.tokenHash.length === 0) return null;
    const consumers = Array.isArray(parsed.consumers)
      ? parsed.consumers.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
      : [];
    return {
      pid: Number(parsed.pid),
      startTime: typeof parsed.startTime === 'string' ? parsed.startTime : undefined,
      command: typeof parsed.command === 'string' ? parsed.command : undefined,
      serverBaseUrl: parsed.serverBaseUrl,
      localBaseUrl: parsed.localBaseUrl,
      launchUrl: normalizeOptionalString(
        typeof parsed.launchUrl === 'string' ? parsed.launchUrl : undefined,
      ),
      registerPath: normalizeOptionalString(
        typeof parsed.registerPath === 'string' ? parsed.registerPath : undefined,
      ),
      unregisterPath: normalizeOptionalString(
        typeof parsed.unregisterPath === 'string' ? parsed.unregisterPath : undefined,
      ),
      devicePort: Number.isInteger(parsed.devicePort) ? Number(parsed.devicePort) : undefined,
      session: normalizeOptionalString(
        typeof parsed.session === 'string' ? parsed.session : undefined,
      ),
      bridgeScope: readCompanionScope(parsed.bridgeScope),
      tokenHash: parsed.tokenHash,
      consumers,
    };
  } catch {
    return null;
  }
}

function writeCompanionState(statePath: string, state: CompanionTunnelState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function touchCompanionState(statePath: string): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.closeSync(fs.openSync(statePath, 'a'));
}

function clearCompanionState(statePath: string): void {
  try {
    fs.unlinkSync(statePath);
  } catch {
    // best effort cleanup
  }
}

function clearCompanionLog(logPath: string): void {
  try {
    fs.unlinkSync(logPath);
  } catch {
    // best effort cleanup
  }
}

function removeDirectoryIfEmpty(dirPath: string): void {
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {
    // best effort cleanup
  }
}

function clearCompanionArtifacts(
  paths: { statePath: string; logPath: string },
  definition: CompanionTunnelDefinition,
): void {
  const stateDir = path.dirname(paths.statePath);
  const logDir = path.dirname(paths.logPath);
  clearCompanionState(paths.statePath);
  clearCompanionLog(paths.logPath);
  removeDirectoryIfEmpty(stateDir);
  if (logDir !== stateDir) {
    removeDirectoryIfEmpty(logDir);
  }
  if (path.basename(stateDir) === definition.slug) {
    removeDirectoryIfEmpty(path.dirname(stateDir));
  }
}

function isCompanionTunnelCommand(command: string, definition: CompanionTunnelDefinition): boolean {
  return command.includes(definition.runArg);
}

function shouldReuseCompanion(
  state: CompanionTunnelState,
  options: EnsureCompanionTunnelOptions,
): boolean {
  if (!isProcessAlive(state.pid)) return false;
  if (state.startTime) {
    const currentStartTime = readProcessStartTime(state.pid);
    if (!currentStartTime || currentStartTime !== state.startTime) return false;
  }
  const command = readProcessCommand(state.pid);
  if (!command || !isCompanionTunnelCommand(command, options.definition)) return false;
  if (!state.bridgeScope) return false;
  return (
    state.serverBaseUrl === normalizeBaseUrl(options.serverBaseUrl) &&
    state.localBaseUrl === normalizeBaseUrl(options.localBaseUrl) &&
    state.launchUrl === normalizeOptionalString(options.launchUrl) &&
    state.registerPath === normalizeOptionalString(options.registerPath) &&
    state.unregisterPath === normalizeOptionalString(options.unregisterPath) &&
    state.devicePort === options.devicePort &&
    state.session === normalizeOptionalString(options.session) &&
    areCompanionScopesEqual(state.bridgeScope, options.bridgeScope) &&
    state.tokenHash === hashString(options.bearerToken)
  );
}

function resolveConsumerKey(options: { profileKey?: string; consumerKey?: string }): string | null {
  return (
    normalizeOptionalString(options.consumerKey) ??
    normalizeOptionalString(options.profileKey) ??
    null
  );
}

function withConsumer(
  state: CompanionTunnelState,
  consumerKey: string | null,
): CompanionTunnelState {
  if (!consumerKey || state.consumers.includes(consumerKey)) {
    return state;
  }
  return {
    ...state,
    consumers: [...state.consumers, consumerKey],
  };
}

function withoutConsumer(
  state: CompanionTunnelState,
  consumerKey: string | null,
): CompanionTunnelState {
  if (!consumerKey) {
    return {
      ...state,
      consumers: [],
    };
  }
  return {
    ...state,
    consumers: state.consumers.filter((entry) => entry !== consumerKey),
  };
}

async function stopCompanionProcess(
  state: CompanionTunnelState,
  definition: CompanionTunnelDefinition,
): Promise<void> {
  if (!isProcessAlive(state.pid)) return;
  const command = readProcessCommand(state.pid);
  if (!command || !isCompanionTunnelCommand(command, definition)) return;
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw error;
  }
  if (await waitForProcessExit(state.pid, COMPANION_TUNNEL_TERM_TIMEOUT_MS)) return;
  try {
    process.kill(state.pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw error;
  }
  await waitForProcessExit(state.pid, COMPANION_TUNNEL_KILL_TIMEOUT_MS);
}

function buildCompanionEnv(
  options: EnsureCompanionTunnelOptions,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  nextEnv[ENV_COMPANION_TUNNEL_SERVER_BASE_URL] = normalizeBaseUrl(options.serverBaseUrl);
  nextEnv[ENV_COMPANION_TUNNEL_BEARER_TOKEN] = options.bearerToken;
  nextEnv[ENV_COMPANION_TUNNEL_LOCAL_BASE_URL] = normalizeBaseUrl(options.localBaseUrl);
  nextEnv[ENV_COMPANION_TUNNEL_STATE_PATH] = resolveCompanionTunnelPaths(
    options.projectRoot,
    options.definition,
    options.profileKey,
    options.stateDir,
  ).statePath;
  nextEnv[ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID] = options.bridgeScope.tenantId;
  nextEnv[ENV_COMPANION_TUNNEL_SCOPE_RUN_ID] = options.bridgeScope.runId;
  nextEnv[ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID] = options.bridgeScope.leaseId;
  if (options.launchUrl?.trim()) {
    nextEnv[ENV_COMPANION_TUNNEL_LAUNCH_URL] = options.launchUrl.trim();
  } else {
    delete nextEnv[ENV_COMPANION_TUNNEL_LAUNCH_URL];
  }
  if (options.registerPath?.trim()) {
    nextEnv[ENV_COMPANION_TUNNEL_REGISTER_PATH] = options.registerPath.trim();
  } else {
    delete nextEnv[ENV_COMPANION_TUNNEL_REGISTER_PATH];
  }
  if (options.unregisterPath?.trim()) {
    nextEnv[ENV_COMPANION_TUNNEL_UNREGISTER_PATH] = options.unregisterPath.trim();
  } else {
    delete nextEnv[ENV_COMPANION_TUNNEL_UNREGISTER_PATH];
  }
  if (options.devicePort !== undefined) {
    nextEnv[ENV_COMPANION_TUNNEL_DEVICE_PORT] = String(options.devicePort);
  } else {
    delete nextEnv[ENV_COMPANION_TUNNEL_DEVICE_PORT];
  }
  if (options.session?.trim()) {
    nextEnv[ENV_COMPANION_TUNNEL_SESSION] = options.session.trim();
  } else {
    delete nextEnv[ENV_COMPANION_TUNNEL_SESSION];
  }
  return nextEnv;
}

function resolveCompanionEntryModulePath(definition: CompanionTunnelDefinition): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentModulePath) || '.js';
  const entryPaths = [
    path.join(path.dirname(currentModulePath), `${COMPANION_TUNNEL_ENTRYPOINT}${extension}`),
    path.join(
      path.dirname(currentModulePath),
      'internal',
      `${COMPANION_TUNNEL_ENTRYPOINT}${extension}`,
    ),
  ];
  const entryPath = entryPaths.find((candidate) => fs.existsSync(candidate));
  if (!entryPath) {
    throw new Error(
      `${definition.displayName} entrypoint not found. Rebuild the package to include the companion worker entry.`,
    );
  }
  return entryPath;
}

function spawnCompanionProcess(
  options: EnsureCompanionTunnelOptions,
  logPath: string,
): CompanionTunnelState {
  const modulePath = resolveCompanionEntryModulePath(options.definition);
  const execArgs = modulePath.endsWith('.ts') ? ['--experimental-strip-types'] : [];
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  let pid = 0;
  try {
    pid = runCmdDetached(process.execPath, [...execArgs, modulePath, options.definition.runArg], {
      env: buildCompanionEnv(options, options.env ?? process.env),
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Failed to start ${options.definition.displayName} process.`);
  }
  return {
    pid,
    startTime: readProcessStartTime(pid) ?? undefined,
    command: readProcessCommand(pid) ?? undefined,
    serverBaseUrl: normalizeBaseUrl(options.serverBaseUrl),
    localBaseUrl: normalizeBaseUrl(options.localBaseUrl),
    launchUrl: normalizeOptionalString(options.launchUrl),
    registerPath: normalizeOptionalString(options.registerPath),
    unregisterPath: normalizeOptionalString(options.unregisterPath),
    devicePort: options.devicePort,
    session: normalizeOptionalString(options.session),
    bridgeScope: options.bridgeScope,
    tokenHash: hashString(options.bearerToken),
    consumers: [],
  };
}

export async function ensureCompanionTunnel(
  options: EnsureCompanionTunnelOptions,
): Promise<EnsureCompanionTunnelResult> {
  const consumerKey = resolveConsumerKey(options);
  const paths = resolveCompanionTunnelPaths(
    options.projectRoot,
    options.definition,
    options.profileKey,
    options.stateDir,
  );
  const existing = readCompanionState(paths.statePath);
  if (existing && shouldReuseCompanion(existing, options)) {
    const nextState = withConsumer(existing, consumerKey);
    if (nextState !== existing) {
      writeCompanionState(paths.statePath, nextState);
    }
    return {
      pid: existing.pid,
      spawned: false,
      statePath: paths.statePath,
      logPath: paths.logPath,
    };
  }

  if (existing) {
    await stopCompanionProcess(existing, options.definition);
    clearCompanionArtifacts(paths, options.definition);
  }

  touchCompanionState(paths.statePath);
  let spawned: CompanionTunnelState | undefined;
  try {
    spawned = spawnCompanionProcess(options, paths.logPath);
    writeCompanionState(paths.statePath, withConsumer(spawned, consumerKey));
  } catch (error) {
    if (spawned) {
      await stopCompanionProcess(spawned, options.definition).catch(() => {});
    }
    clearCompanionArtifacts(paths, options.definition);
    throw error;
  }
  return {
    pid: spawned.pid,
    spawned: true,
    statePath: paths.statePath,
    logPath: paths.logPath,
  };
}

export async function stopCompanionTunnel(
  options: StopCompanionTunnelOptions,
): Promise<{ stopped: boolean; statePath: string }> {
  const consumerKey = resolveConsumerKey(options);
  const paths = resolveCompanionTunnelPaths(
    options.projectRoot,
    options.definition,
    options.profileKey,
    options.stateDir,
  );
  const existing = readCompanionState(paths.statePath);
  if (!existing) {
    clearCompanionArtifacts(paths, options.definition);
    return { stopped: false, statePath: paths.statePath };
  }
  const nextState = withoutConsumer(existing, consumerKey);
  if (nextState.consumers.length > 0) {
    writeCompanionState(paths.statePath, nextState);
    return { stopped: false, statePath: paths.statePath };
  }
  await stopCompanionProcess(existing, options.definition);
  clearCompanionArtifacts(paths, options.definition);
  return { stopped: true, statePath: paths.statePath };
}
