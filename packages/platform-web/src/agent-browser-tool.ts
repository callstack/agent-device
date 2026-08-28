import crypto from 'node:crypto';
import path from 'node:path';
import { runCmd, type ExecResult } from '@agent-device/host-kit/command';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import {
  createHostDirectoryLinkSync,
  ensureHostDirectorySync,
  hostFileExistsSync,
  hostFileLstatSync,
  hostFileStatSync,
  hostTemporaryDirectory,
  readHostSymbolicLinkSync,
  readHostTextFileSync,
  removeHostFileSync,
} from '@agent-device/host-kit/host-file';
import {
  hostCurrentWorkingDirectory,
  hostEnvironment,
  hostNodeExecutablePath,
  hostNodeVersion,
  hostPlatform,
  hostProcessId,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { ManagedWebBackendStatus } from '@agent-device/contracts/managed-web-backend';
import {
  installManagedAgentBrowserPackage,
  writeManagedAgentBrowserManifest,
} from './agent-browser-install.ts';
import {
  appendAgentDeviceChromeArgs,
  resolveAgentBrowserIdleTimeoutMs,
} from './agent-browser-lifecycle.ts';

const MANAGED_AGENT_BROWSER_VERSION = '0.27.1';

const AGENT_BROWSER = 'agent-browser';
const MINIMUM_WEB_NODE_MAJOR = 24;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const DOCTOR_TIMEOUT_MS = 60_000;

export type AgentBrowserToolStatus = ManagedWebBackendStatus;

export type ManagedAgentBrowserRunOptions = {
  stateDir?: string;
  timeoutMs: number;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

/**
 * The only way the managed backend is executed. Entry resolution, the Node
 * runtime, the managed environment, and the spawn all live behind this call, so
 * no caller can reintroduce the `.bin` shim that Windows cannot spawn (#2022).
 */
export async function runManagedAgentBrowser(
  args: readonly string[],
  options: ManagedAgentBrowserRunOptions,
): Promise<ExecResult> {
  const status = getManagedAgentBrowserStatus({ stateDir: options.stateDir });
  if (!status.installed) throw missingManagedToolError(status);
  return await spawnManagedAgentBrowser(status, args, options);
}

export async function setupManagedAgentBrowser(options: {
  stateDir?: string;
}): Promise<AgentBrowserToolStatus> {
  const status = getManagedAgentBrowserStatus(options);
  assertWebNodeSupported(status.nodeMajor);
  const processId = hostProcessId();

  const release = await acquireProcessLock({
    lockDirPath: path.join(status.installDir, '..', '.agent-browser-install.lock'),
    owner: {
      pid: processId,
      startTime: readProcessStartTime(processId),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: SETUP_TIMEOUT_MS,
    description: 'managed agent-browser setup',
  });
  try {
    const freshStatus = getManagedAgentBrowserStatus(options);
    if (freshStatus.installed) return freshStatus;
    ensureHostDirectorySync(freshStatus.installDir);
    await installManagedAgentBrowserPackage({
      packageRoot: path.join(freshStatus.installDir, 'package'),
      packageSpec: `${AGENT_BROWSER}@${MANAGED_AGENT_BROWSER_VERSION}`,
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    // The backend entry only exists once npm has written the package.
    const installedStatus = getManagedAgentBrowserStatus(options);
    if (!installedStatus.entryScript) throw unusableInstallError(installedStatus);
    await spawnManagedAgentBrowser(installedStatus, ['install'], { timeoutMs: SETUP_TIMEOUT_MS });
    await spawnManagedAgentBrowser(installedStatus, ['doctor', '--offline', '--quick'], {
      timeoutMs: DOCTOR_TIMEOUT_MS,
    });
    writeManagedAgentBrowserManifest({
      installDir: installedStatus.installDir,
      packageName: AGENT_BROWSER,
      version: MANAGED_AGENT_BROWSER_VERSION,
    });
    return getManagedAgentBrowserStatus(options);
  } finally {
    await release();
  }
}

export async function doctorManagedAgentBrowser(options: {
  stateDir?: string;
}): Promise<{ status: AgentBrowserToolStatus; stdout: string; stderr: string; exitCode: number }> {
  const status = getManagedAgentBrowserStatus(options);
  if (!status.installed) {
    throw missingManagedToolError(status);
  }
  const result = await spawnManagedAgentBrowser(status, ['doctor', '--offline', '--quick'], {
    timeoutMs: DOCTOR_TIMEOUT_MS,
    allowFailure: true,
  });
  return { status, ...result };
}

export function getManagedAgentBrowserStatus(options: {
  stateDir?: string;
}): AgentBrowserToolStatus {
  const stateDir =
    options.stateDir ?? hostEnvironment().AGENT_DEVICE_STATE_DIR ?? defaultStateDir();
  const installDir = path.join(stateDir, 'tools', 'agent-browser', MANAGED_AGENT_BROWSER_VERSION);
  const packageDir = resolveManagedPackageDir(installDir);
  const binaryPath = resolveManagedBinaryPath(installDir);
  const entryScript = resolveManagedEntryScript(packageDir);
  const homeDir = path.join(installDir, 'home');
  const runtimeHomeDir = resolveManagedRuntimeHomeDir(installDir);
  const socketDir = resolveManagedSocketDir(installDir);
  const installed = entryScript !== undefined && hasManifest(installDir);
  const nodeMajor = Number.parseInt(hostNodeVersion().replace(/^v/, '').split('.')[0] ?? '0', 10);
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
): Promise<ExecResult> {
  if (!status.entryScript) throw missingManagedToolError(status);
  return await runCmd(hostNodeExecutablePath(), [status.entryScript, ...args], {
    allowFailure: options.allowFailure,
    env: managedAgentBrowserEnv(status, hostEnvironment()),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
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
 * choose (`bin/agent-browser.js` in 0.27.1).
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

function resolveManagedBinaryPath(installDir: string): string {
  const shim = hostPlatform() === 'win32' ? `${AGENT_BROWSER}.cmd` : AGENT_BROWSER;
  return path.join(installDir, 'package', 'node_modules', '.bin', shim);
}

function missingManagedToolError(status: AgentBrowserToolStatus): AppError {
  return new AppError('TOOL_MISSING', 'Managed web browser backend is not installed.', {
    version: MANAGED_AGENT_BROWSER_VERSION,
    installDir: status.installDir,
    hint:
      status.nodeSupported === false
        ? `Web automation requires Node ${MINIMUM_WEB_NODE_MAJOR}+; current Node is ${hostNodeVersion()}.`
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

function assertWebNodeSupported(nodeMajor: number): void {
  if (nodeMajor >= MINIMUM_WEB_NODE_MAJOR) return;
  throw new AppError('UNSUPPORTED_OPERATION', 'Web automation requires Node 24 or newer.', {
    currentNode: hostNodeVersion(),
    requiredNodeMajor: MINIMUM_WEB_NODE_MAJOR,
    hint: 'Run agent-device with Node 24+ for web setup and web automation.',
  });
}

function resolveManagedRuntimeHomeDir(installDir: string): string {
  if (hostPlatform() === 'win32') return path.join(installDir, 'home');
  const hash = crypto.createHash('sha1').update(installDir).digest('hex').slice(0, 12);
  return path.join(hostTemporaryDirectory(), 'agent-device-web', hash);
}

function resolveManagedSocketDir(installDir: string): string {
  const hash = crypto.createHash('sha1').update(installDir).digest('hex').slice(0, 12);
  return path.join(hostTemporaryDirectory(), 'adw', hash);
}

function isNoEntryError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function defaultStateDir(): string {
  return path.join(hostEnvironment().HOME ?? hostCurrentWorkingDirectory(), '.agent-device');
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
