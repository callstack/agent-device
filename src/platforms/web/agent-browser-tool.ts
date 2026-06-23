import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runCmd } from '../../utils/exec.ts';
import { AppError, asAppError } from '../../utils/errors.ts';
import { acquireProcessLock } from '../../utils/process-lock.ts';
import { readProcessStartTime } from '../../utils/process-identity.ts';

const MANAGED_AGENT_BROWSER_VERSION = '0.27.1';

const AGENT_BROWSER = 'agent-browser';
const MINIMUM_WEB_NODE_MAJOR = 24;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const DOCTOR_TIMEOUT_MS = 60_000;

export type AgentBrowserTool = {
  command: string;
  env?: NodeJS.ProcessEnv;
};

export type AgentBrowserToolStatus = {
  version: string;
  stateDir: string;
  installDir: string;
  binaryPath: string;
  homeDir: string;
  runtimeHomeDir: string;
  socketDir: string;
  installed: boolean;
  nodeMajor: number;
  nodeSupported: boolean;
};

export async function resolveAgentBrowserTool(options: {
  stateDir?: string;
}): Promise<AgentBrowserTool> {
  const status = getManagedAgentBrowserStatus(options);
  if (status.installed) {
    return createManagedTool(status);
  }

  throw missingManagedToolError(status);
}

export async function setupManagedAgentBrowser(options: {
  stateDir?: string;
}): Promise<AgentBrowserToolStatus> {
  const status = getManagedAgentBrowserStatus(options);
  assertWebNodeSupported(status.nodeMajor);

  const release = await acquireProcessLock({
    lockDirPath: path.join(status.installDir, '..', '.agent-browser-install.lock'),
    owner: {
      pid: process.pid,
      startTime: readProcessStartTime(process.pid),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: SETUP_TIMEOUT_MS,
    description: 'managed agent-browser setup',
  });
  try {
    const freshStatus = getManagedAgentBrowserStatus(options);
    if (freshStatus.installed) return freshStatus;
    fs.mkdirSync(freshStatus.installDir, { recursive: true });
    await installAgentBrowserPackage(freshStatus);
    await runManagedAgentBrowser(freshStatus, ['install'], { timeoutMs: SETUP_TIMEOUT_MS });
    await runManagedAgentBrowser(freshStatus, ['doctor', '--offline', '--quick'], {
      timeoutMs: DOCTOR_TIMEOUT_MS,
    });
    writeManifest(freshStatus);
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
  const result = await runManagedAgentBrowser(status, ['doctor', '--offline', '--quick'], {
    timeoutMs: DOCTOR_TIMEOUT_MS,
    allowFailure: true,
  });
  return { status, ...result };
}

function getManagedAgentBrowserStatus(options: { stateDir?: string }): AgentBrowserToolStatus {
  const stateDir = options.stateDir ?? process.env.AGENT_DEVICE_STATE_DIR ?? defaultStateDir();
  const installDir = path.join(stateDir, 'tools', 'agent-browser', MANAGED_AGENT_BROWSER_VERSION);
  const binaryPath = resolveManagedBinaryPath(installDir);
  const homeDir = path.join(installDir, 'home');
  const runtimeHomeDir = resolveManagedRuntimeHomeDir(installDir);
  const socketDir = resolveManagedSocketDir(installDir);
  const installed = isExecutable(binaryPath) && hasManifest(installDir);
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return {
    version: MANAGED_AGENT_BROWSER_VERSION,
    stateDir,
    installDir,
    binaryPath,
    homeDir,
    runtimeHomeDir,
    socketDir,
    installed,
    nodeMajor,
    nodeSupported: nodeMajor >= MINIMUM_WEB_NODE_MAJOR,
  };
}

function createManagedTool(status: AgentBrowserToolStatus): AgentBrowserTool {
  if (!status.installed) throw missingManagedToolError(status);
  return {
    command: status.binaryPath,
    env: managedAgentBrowserEnv(status, process.env),
  };
}

async function installAgentBrowserPackage(status: AgentBrowserToolStatus): Promise<void> {
  const packageRoot = path.join(status.installDir, 'package');
  fs.mkdirSync(packageRoot, { recursive: true });
  await runCmd(
    'npm',
    [
      'install',
      '--prefix',
      packageRoot,
      '--no-audit',
      '--no-fund',
      '--no-save',
      `${AGENT_BROWSER}@${MANAGED_AGENT_BROWSER_VERSION}`,
    ],
    { env: process.env, timeoutMs: SETUP_TIMEOUT_MS },
  );
}

async function runManagedAgentBrowser(
  status: AgentBrowserToolStatus,
  args: string[],
  options: { timeoutMs: number; allowFailure?: boolean },
) {
  return await runCmd(status.binaryPath, args, {
    allowFailure: options.allowFailure,
    env: managedAgentBrowserEnv(status, process.env),
    timeoutMs: options.timeoutMs,
  });
}

function managedAgentBrowserEnv(
  status: AgentBrowserToolStatus,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  fs.mkdirSync(status.homeDir, { recursive: true });
  ensureRuntimeHomeDir(status);
  fs.mkdirSync(status.socketDir, { recursive: true });
  return {
    ...env,
    HOME: status.runtimeHomeDir,
    AGENT_BROWSER_SOCKET_DIR: status.socketDir,
  };
}

function ensureRuntimeHomeDir(status: AgentBrowserToolStatus): void {
  if (status.runtimeHomeDir === status.homeDir) return;
  fs.mkdirSync(path.dirname(status.runtimeHomeDir), { recursive: true });
  try {
    const stats = fs.lstatSync(status.runtimeHomeDir);
    if (stats.isSymbolicLink() && fs.readlinkSync(status.runtimeHomeDir) === status.homeDir) return;
    if (stats.isDirectory()) return;
    if (stats.isSymbolicLink()) fs.unlinkSync(status.runtimeHomeDir);
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }
  try {
    fs.symlinkSync(status.homeDir, status.runtimeHomeDir, 'dir');
  } catch {
    fs.mkdirSync(status.runtimeHomeDir, { recursive: true });
  }
}

function writeManifest(status: AgentBrowserToolStatus): void {
  fs.writeFileSync(
    path.join(status.installDir, 'manifest.json'),
    JSON.stringify(
      {
        package: AGENT_BROWSER,
        version: MANAGED_AGENT_BROWSER_VERSION,
        node: process.version,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
}

function hasManifest(installDir: string): boolean {
  return fs.existsSync(path.join(installDir, 'manifest.json'));
}

function resolveManagedBinaryPath(installDir: string): string {
  const packageRoot = path.join(installDir, 'package');
  return path.join(
    packageRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser',
  );
}

function missingManagedToolError(status: AgentBrowserToolStatus): AppError {
  return new AppError('TOOL_MISSING', 'Managed web browser backend is not installed.', {
    version: MANAGED_AGENT_BROWSER_VERSION,
    installDir: status.installDir,
    hint:
      status.nodeSupported === false
        ? `Web automation requires Node ${MINIMUM_WEB_NODE_MAJOR}+; current Node is ${process.version}.`
        : 'Run `agent-device web setup` to install the managed web backend.',
  });
}

function assertWebNodeSupported(nodeMajor: number): void {
  if (nodeMajor >= MINIMUM_WEB_NODE_MAJOR) return;
  throw new AppError('UNSUPPORTED_OPERATION', 'Web automation requires Node 24 or newer.', {
    currentNode: process.version,
    requiredNodeMajor: MINIMUM_WEB_NODE_MAJOR,
    hint: 'Run agent-device with Node 24+ for web setup and web automation.',
  });
}

function resolveManagedRuntimeHomeDir(installDir: string): string {
  if (process.platform === 'win32') return path.join(installDir, 'home');
  const hash = crypto.createHash('sha1').update(installDir).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'agent-device-web', hash);
}

function resolveManagedSocketDir(installDir: string): string {
  const hash = crypto.createHash('sha1').update(installDir).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'adw', hash);
}

function isNoEntryError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultStateDir(): string {
  return path.join(process.env.HOME ?? process.cwd(), '.agent-device');
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
