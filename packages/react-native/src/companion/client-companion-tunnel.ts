import type { CompanionTunnelScope } from '@agent-device/contracts/remote';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENV_COMPANION_TUNNEL_BEARER_TOKEN,
  ENV_COMPANION_TUNNEL_LAUNCH_URL,
  ENV_COMPANION_TUNNEL_LOCAL_BASE_URL,
  ENV_COMPANION_TUNNEL_REGISTER_PATH,
  ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID,
  ENV_COMPANION_TUNNEL_SCOPE_RUN_ID,
  ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID,
  ENV_COMPANION_TUNNEL_SERVER_BASE_URL,
  ENV_COMPANION_TUNNEL_STATE_PATH,
  ENV_COMPANION_TUNNEL_UNREGISTER_PATH,
} from './client-companion-tunnel-contract.ts';
import { normalizeBaseUrl } from '../metro/base-url.ts';
import { runCmdDetached } from '@agent-device/host-kit/command';
import {
  confirmedProcessStopDetails,
  describeUnconfirmedProcessStop,
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  stopProcessAndConfirmExit,
  type ConfirmedProcessStop,
} from '@agent-device/host-kit/process';
import { AppError } from '@agent-device/kernel/errors';

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
  profileKey?: string;
  consumerKey?: string;
  stateDir?: string;
  /** The environment and working directory the detached companion process starts with. */
  env: NodeJS.ProcessEnv;
  cwd: string;
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

function normalizeOptionalString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
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
      launchUrl: normalizeOptionalString(parsed.launchUrl),
      registerPath: normalizeOptionalString(parsed.registerPath),
      unregisterPath: normalizeOptionalString(parsed.unregisterPath),
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

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
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
  unlinkQuietly(paths.statePath);
  unlinkQuietly(paths.logPath);
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

/** Stops the recorded companion, throwing unless the host proves it left. */
async function stopCompanionProcess(
  state: CompanionTunnelState,
  definition: CompanionTunnelDefinition,
  paths: { statePath: string; logPath: string },
): Promise<void> {
  const outcome = await stopProcessAndConfirmExit(
    {
      pid: state.pid,
      identity: {
        startTime: state.startTime,
        matches: (command) => isCompanionTunnelCommand(command, definition),
      },
    },
    {
      termTimeoutMs: COMPANION_TUNNEL_TERM_TIMEOUT_MS,
      killTimeoutMs: COMPANION_TUNNEL_KILL_TIMEOUT_MS,
    },
  );
  if (outcome.status === 'retained') {
    throw companionStopFailure({ ...outcome, pid: state.pid }, definition, paths);
  }
}

/** A companion whose exit could not be confirmed: state stays, so a retry stops the same process. */
function companionStopFailure(
  retained: { pid: number } & Extract<ConfirmedProcessStop, { status: 'retained' }>,
  definition: CompanionTunnelDefinition,
  paths: { statePath: string; logPath: string },
): AppError {
  // `identity-unverified` is the one verdict that cannot say "still running": the pid answers
  // `kill(pid, 0)`, and on Windows an exited process does too while its object keeps handles.
  const why =
    retained.reason === 'identity-unverified'
      ? `${definition.displayName} ${describeUnconfirmedProcessStop(retained.pid, `the ${definition.displayName} this profile started`)}. Stop it yourself, as its owner if needed.`
      : `${definition.displayName} pid ${retained.pid} is still running${
          retained.reason === 'exit-timeout'
            ? `: it survived ${retained.signal}.`
            : retained.errno === 'EPERM'
              ? `: it refused ${retained.signal} (${retained.errno}), so it belongs to another user or was started with elevated privileges. Stop it as that user, e.g. \`sudo kill ${retained.pid}\`.`
              : `: it refused ${retained.signal} (${retained.errno}).`
        }`;
  return new AppError('COMMAND_FAILED', why, {
    ...confirmedProcessStopDetails(retained, retained.pid),
    statePath: paths.statePath,
    logPath: paths.logPath,
    hint: `${paths.statePath} still tracks this pid, so a retry acts on that same companion instead of starting a second one.`,
  });
}

/** Records a half-spawned companion a stop could not confirm, so a retry stops the same pid. */
function persistUnstoppedCompanion(statePath: string, state: CompanionTunnelState): void {
  try {
    writeCompanionState(statePath, state);
  } catch {
    // A pid this host will not record cannot be tracked on a retry; the refusal names it, and the
    // caller dispatches on that verdict.
  }
}

function setOrDelete(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
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
  setOrDelete(nextEnv, ENV_COMPANION_TUNNEL_LAUNCH_URL, normalizeOptionalString(options.launchUrl));
  setOrDelete(
    nextEnv,
    ENV_COMPANION_TUNNEL_REGISTER_PATH,
    normalizeOptionalString(options.registerPath),
  );
  setOrDelete(
    nextEnv,
    ENV_COMPANION_TUNNEL_UNREGISTER_PATH,
    normalizeOptionalString(options.unregisterPath),
  );
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
      cwd: options.cwd,
      env: buildCompanionEnv(options, options.env),
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

  // Stopping before spawning is what keeps one bridge scope down to one companion: an unconfirmed
  // exit aborts here instead of registering a second one beside the first.
  if (existing) {
    await stopCompanionProcess(existing, options.definition, paths);
    clearCompanionArtifacts(paths, options.definition);
  }

  touchCompanionState(paths.statePath);
  let spawned: CompanionTunnelState | undefined;
  try {
    spawned = spawnCompanionProcess(options, paths.logPath);
    writeCompanionState(paths.statePath, withConsumer(spawned, consumerKey));
  } catch (error) {
    // An unconfirmed exit of our own half-spawned companion outranks the spawn failure.
    if (spawned) {
      try {
        await stopCompanionProcess(spawned, options.definition, paths);
      } catch (stopError) {
        // The failure promises a retry stops the same pid, and the sentinel carries none.
        persistUnstoppedCompanion(paths.statePath, spawned);
        if (stopError instanceof AppError) stopError.cause = error;
        throw stopError;
      }
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
  await stopCompanionProcess(existing, options.definition, paths);
  clearCompanionArtifacts(paths, options.definition);
  return { stopped: true, statePath: paths.statePath };
}
