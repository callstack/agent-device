import path from 'node:path';
import {
  createHostDirectoryLinkSync,
  ensureHostDirectorySync,
  hostFileExistsSync,
  hostFileLstatSync,
  hostFileStatSync,
  readHostSymbolicLinkSync,
  readHostTextFileSync,
  removeHostFileSync,
} from '@agent-device/host-kit/host-file';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { ManagedWebBackendStatus } from '@agent-device/contracts/managed-web-backend';
import type { WebCommandResult } from './command-host.ts';
import {
  installManagedAgentBrowserPackage,
  writeManagedAgentBrowserManifest,
} from './agent-browser-install.ts';
import { isNoEntryError, managedInstallPaths } from './agent-browser-install-paths.ts';
import {
  appendAgentDeviceChromeArgs,
  resolveAgentBrowserIdleTimeoutMs,
} from './agent-browser-lifecycle.ts';
import type { WebMachine, WebToolbox } from './toolbox.ts';

const MANAGED_AGENT_BROWSER_VERSION = '0.39.0';

const AGENT_BROWSER = 'agent-browser';
const MINIMUM_WEB_NODE_MAJOR = 24;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const DOCTOR_TIMEOUT_MS = 60_000;

export type AgentBrowserToolStatus = ManagedWebBackendStatus;

export type ManagedAgentBrowserRunOptions = {
  /** The plugin's toolbox: its host selects the state dir and seeds the backend env. */
  toolbox: WebToolbox;
  stateDir?: string;
  timeoutMs: number;
  allowFailure?: boolean;
  signal?: AbortSignal;
  /** Written to the backend's stdin, for the command that reads its work from it (`batch`). */
  stdin?: string;
};

/**
 * The only way the managed backend is executed. Entry resolution, the Node
 * runtime, the managed environment, and the spawn all live behind this call, so
 * no caller can reintroduce the `.bin` shim that Windows cannot spawn (#2022).
 */
export async function runManagedAgentBrowser(
  args: readonly string[],
  options: ManagedAgentBrowserRunOptions,
): Promise<WebCommandResult> {
  const status = getManagedAgentBrowserStatus({
    host: options.toolbox.host,
    stateDir: options.stateDir,
  });
  if (!status.installed) throw missingManagedToolError(status, options.toolbox.host);
  return await spawnManagedAgentBrowser(status, args, options);
}

export async function setupManagedAgentBrowser(options: {
  toolbox: WebToolbox;
  stateDir?: string;
}): Promise<AgentBrowserToolStatus> {
  const status = getManagedAgentBrowserStatus(managedStatusOptions(options));
  assertWebNodeSupported(status.nodeMajor, options.toolbox.host);

  // The install lock goes through the host: claiming it names this process's identity with a `ps`
  // read, and every poll of a held or stale lock re-proves the recorded owner and the guard holder
  // with another. Answered from the plugin's bundled copy those reads run with the daemon
  // environment and trace into the bundle's own store, so the request that waited shows no wait.
  return await options.toolbox.host.processes.withLock({
    lockDirPath: path.join(status.installDir, '..', '.agent-browser-install.lock'),
    timeoutMs: SETUP_TIMEOUT_MS,
    description: 'managed agent-browser setup',
    task: async () => {
      const freshStatus = getManagedAgentBrowserStatus(managedStatusOptions(options));
      if (freshStatus.installed) return freshStatus;
      ensureHostDirectorySync(freshStatus.installDir);
      await installManagedAgentBrowserPackage({
        packageRoot: path.join(freshStatus.installDir, 'package'),
        packageSpec: `${AGENT_BROWSER}@${MANAGED_AGENT_BROWSER_VERSION}`,
        timeoutMs: SETUP_TIMEOUT_MS,
        env: options.toolbox.host.env,
        machine: options.toolbox.host,
        commands: options.toolbox.commands,
      });
      // The backend entry only exists once npm has written the package.
      const installedStatus = getManagedAgentBrowserStatus(managedStatusOptions(options));
      if (!installedStatus.entryScript) throw unusableInstallError(installedStatus);
      await spawnManagedAgentBrowser(installedStatus, ['install'], {
        toolbox: options.toolbox,
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      await spawnManagedAgentBrowser(installedStatus, ['doctor', '--offline', '--quick'], {
        toolbox: options.toolbox,
        timeoutMs: DOCTOR_TIMEOUT_MS,
      });
      writeManagedAgentBrowserManifest({
        installDir: installedStatus.installDir,
        packageName: AGENT_BROWSER,
        version: MANAGED_AGENT_BROWSER_VERSION,
        machine: options.toolbox.host,
      });
      return await getManagedAgentBrowserStatus(managedStatusOptions(options));
    },
  });
}

export async function doctorManagedAgentBrowser(options: {
  toolbox: WebToolbox;
  stateDir?: string;
}): Promise<{ status: AgentBrowserToolStatus; stdout: string; stderr: string; exitCode: number }> {
  const status = getManagedAgentBrowserStatus(managedStatusOptions(options));
  if (!status.installed) {
    throw missingManagedToolError(status, options.toolbox.host);
  }
  const result = await spawnManagedAgentBrowser(status, ['doctor', '--offline', '--quick'], {
    toolbox: options.toolbox,
    timeoutMs: DOCTOR_TIMEOUT_MS,
    allowFailure: true,
  });
  return { status, ...result };
}

/** Reads a status for the host one of the toolbox-taking operations was set up with. */
function managedStatusOptions(options: { toolbox: WebToolbox; stateDir?: string }): {
  host: WebStatusHost;
  stateDir?: string;
} {
  return {
    host: options.toolbox.host,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  };
}

/**
 * The host whose answers describe one managed install: the environment and working directory the
 * caller captured, plus what the host says about the machine those commands run on. Every field is
 * asked of the host so the status names paths, and a Node, the process that spawns the backend can
 * actually use.
 */
export type WebStatusHost = HostEnvironment & WebMachine;

/**
 * Where the managed backend is on disk, and whether it is there. Reads only the host's environment
 * and the filesystem, so it answers the same way whether or not anything is installed.
 */
export function getManagedAgentBrowserStatus(options: {
  /** Either the calling runtime's host or the plugin's own host; both answer the same way. */
  host: WebStatusHost;
  stateDir?: string;
}): AgentBrowserToolStatus {
  const { host } = options;
  const stateDir = options.stateDir ?? host.env.AGENT_DEVICE_STATE_DIR ?? defaultStateDir(host);
  const { installDir, homeDir, runtimeHomeDir, socketDir } = managedInstallPaths(
    stateDir,
    MANAGED_AGENT_BROWSER_VERSION,
    host,
  );
  const packageDir = resolveManagedPackageDir(installDir);
  const binaryPath = resolveManagedBinaryPath(installDir, host);
  const entryScript = resolveManagedEntryScript(packageDir);
  const installed = entryScript !== undefined && hasManifest(installDir);
  const nodeMajor = Number.parseInt(host.nodeVersion.replace(/^v/, '').split('.')[0] ?? '0', 10);
  return {
    version: MANAGED_AGENT_BROWSER_VERSION,
    stateDir,
    installDir,
    packageDir,
    binaryPath,
    entryScript,
    homeDir,
    runtimeHomeDir,
    socketDir,
    installed,
    nodeMajor,
    nodeSupported: nodeMajor >= MINIMUM_WEB_NODE_MAJOR,
  };
}

// `node <entry>`, never the `node_modules/.bin` shim: that shim is a `.cmd` on
// Windows, which spawn refuses without a shell since CVE-2024-27980 (#2022).
async function spawnManagedAgentBrowser(
  status: AgentBrowserToolStatus,
  args: readonly string[],
  options: Omit<ManagedAgentBrowserRunOptions, 'stateDir'>,
): Promise<WebCommandResult> {
  if (!status.entryScript) throw missingManagedToolError(status, options.toolbox.host);
  return await options.toolbox.commands.run(
    options.toolbox.host.nodeExecutablePath,
    [status.entryScript, ...args],
    {
      allowFailure: options.allowFailure,
      env: managedAgentBrowserEnv(status, options.toolbox.host.env),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      stdin: options.stdin,
    },
  );
}

function managedAgentBrowserEnv(
  status: AgentBrowserToolStatus,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  ensureHostDirectorySync(status.homeDir);
  ensureRuntimeHomeDir(status);
  ensureHostDirectorySync(status.socketDir);
  return {
    ...env,
    HOME: status.runtimeHomeDir,
    AGENT_BROWSER_SOCKET_DIR: status.socketDir,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(resolveAgentBrowserIdleTimeoutMs(env)),
    AGENT_BROWSER_ARGS: appendAgentDeviceChromeArgs(env.AGENT_BROWSER_ARGS, status),
  };
}

function ensureRuntimeHomeDir(status: AgentBrowserToolStatus): void {
  if (status.runtimeHomeDir === status.homeDir) return;
  ensureHostDirectorySync(path.dirname(status.runtimeHomeDir));
  try {
    const stats = hostFileLstatSync(status.runtimeHomeDir);
    if (
      stats.isSymbolicLink() &&
      readHostSymbolicLinkSync(status.runtimeHomeDir) === status.homeDir
    )
      return;
    if (stats.isDirectory()) return;
    if (stats.isSymbolicLink()) removeHostFileSync(status.runtimeHomeDir);
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }
  try {
    createHostDirectoryLinkSync(status.homeDir, status.runtimeHomeDir);
  } catch {
    ensureHostDirectorySync(status.runtimeHomeDir);
  }
}

function hasManifest(installDir: string): boolean {
  return hostFileExistsSync(path.join(installDir, 'manifest.json'));
}

/**
 * The backend's declared `bin` entry. Read from the installed manifest rather
 * than hard-coded, because the path inside the package is the package's to
 * choose.
 */
function resolveManagedEntryScript(packageDir: string): string | undefined {
  let bin: unknown;
  try {
    const manifest: unknown = JSON.parse(
      readHostTextFileSync(path.join(packageDir, 'package.json')),
    );
    bin =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as { bin?: unknown }).bin
        : undefined;
  } catch {
    return undefined;
  }
  const declaredPath =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null
        ? (bin as Record<string, unknown>)[AGENT_BROWSER]
        : undefined;
  if (typeof declaredPath !== 'string') return undefined;
  const entryScript = path.resolve(packageDir, declaredPath);
  return isFile(entryScript) ? entryScript : undefined;
}

function isFile(filePath: string): boolean {
  try {
    return hostFileStatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveManagedPackageDir(installDir: string): string {
  return path.join(installDir, 'package', 'node_modules', AGENT_BROWSER);
}

function resolveManagedBinaryPath(installDir: string, host: WebStatusHost): string {
  const shim = host.hostOs === 'win32' ? `${AGENT_BROWSER}.cmd` : AGENT_BROWSER;
  return path.join(installDir, 'package', 'node_modules', '.bin', shim);
}

function missingManagedToolError(status: AgentBrowserToolStatus, host: WebStatusHost): AppError {
  return new AppError('TOOL_MISSING', 'Managed web browser backend is not installed.', {
    version: MANAGED_AGENT_BROWSER_VERSION,
    installDir: status.installDir,
    hint:
      status.nodeSupported === false
        ? `Web automation requires Node ${MINIMUM_WEB_NODE_MAJOR}+; current Node is ${host.nodeVersion}.`
        : 'Run `agent-device web setup` to install the managed web backend.',
  });
}

// npm exited 0 but left no runnable entry: reported apart from the
// not-installed-yet case, whose "run web setup" hint is useless in `web setup`.
function unusableInstallError(status: AgentBrowserToolStatus): AppError {
  return new AppError('TOOL_MISSING', 'Managed web backend install produced no runnable entry.', {
    version: MANAGED_AGENT_BROWSER_VERSION,
    installDir: status.installDir,
    packageDir: status.packageDir,
    hint: `Remove ${status.installDir} and run \`agent-device web setup\` again.`,
  });
}

function assertWebNodeSupported(nodeMajor: number, host: WebStatusHost): void {
  if (nodeMajor >= MINIMUM_WEB_NODE_MAJOR) return;
  throw new AppError('UNSUPPORTED_OPERATION', 'Web automation requires Node 24 or newer.', {
    currentNode: host.nodeVersion,
    requiredNodeMajor: MINIMUM_WEB_NODE_MAJOR,
    hint: 'Run agent-device with Node 24+ for web setup and web automation.',
  });
}

function defaultStateDir(host: HostEnvironment): string {
  return path.join(host.env.HOME ?? host.cwd, '.agent-device');
}

export function mapManagedAgentBrowserError(error: unknown): AppError {
  const appError = asAppError(error);
  if (appError.code !== 'TOOL_MISSING') return appError;
  return new AppError(appError.code, appError.message, {
    ...(appError.details ?? {}),
    hint:
      typeof appError.details?.hint === 'string'
        ? appError.details.hint
        : 'Run `agent-device web setup` to install the managed web backend.',
  });
}
