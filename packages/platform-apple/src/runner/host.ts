import type { ChildProcess } from 'node:child_process';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { InfrastructureBootFailureReason } from '@agent-device/contracts/boot-failure';
import type { XmlNode } from '@agent-device/xml';

/**
 * The host-capability port for the Apple runner client. Every effectful or
 * shared-single-source capability the runner needs from its embedding process
 * enters through this object: process execution, diagnostics, retry, process
 * probes, locks, Apple foreground tooling, and physical-device control. The
 * package never imports root implementation files; the composition root
 * (`src/platforms/apple/core/runner-client.ts`) constructs the client with the
 * real implementations exactly once per process.
 *
 * Signatures mirror the root utilities structurally, narrowed to what the
 * runner uses; the composition-root assignment is the conformance check, so a
 * root signature drifting incompatibly fails typecheck there rather than at
 * runtime.
 */

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
};

/** Narrowed to the option fields the runner actually passes. */
export type ExecOptions = {
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  timeoutMs?: number;
  detached?: boolean;
  signal?: AbortSignal;
  maxBuffer?: number;
};

export type ExecStreamOptions = ExecOptions & {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
};

export type ExecBackgroundResult = {
  child: ChildProcess;
  wait: Promise<ExecResult>;
};

export type ExecBackgroundOptions = ExecOptions;

export type Deadline = {
  remainingMs(nowMs?: number): number;
  elapsedMs(nowMs?: number): number;
  isExpired(nowMs?: number): boolean;
};

export type RetryAttemptContext = {
  attempt: number;
  maxAttempts: number;
  deadline?: Deadline;
};

export type RetryPolicy = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

export type RetryTelemetryEvent = {
  phase?: string;
  event: 'attempt_failed' | 'retry_scheduled' | 'succeeded' | 'exhausted';
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  elapsedMs?: number;
  remainingMs?: number;
  reason?: string;
};

export type RetryOptions = {
  deadline?: Deadline;
  phase?: string;
  signal?: AbortSignal;
  classifyReason?: (error: unknown) => string | undefined;
  onEvent?: (event: RetryTelemetryEvent) => void;
  retryWakeSignal?: AbortSignal;
};

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticEventInput = {
  level?: DiagnosticLevel;
  phase: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

export type ProcessLockOwner = {
  pid: number;
  startTime: string | null;
  acquiredAtMs: number;
};

export type OwnerLiveness =
  | 'live'
  | 'owner-process-dead'
  | 'owner-process-reused'
  | 'owner-state-dir-gone'
  | 'unknown';

/** Narrowed to the members the runner's fingerprint cache consumes. */
export type TtlMemo<Key, Value> = {
  get: (key: Key) => Value | undefined;
  set: (key: Key, value: Value) => void;
};

export type TtlMemoOptions = {
  ttlMs?: number;
};

export type DefinedEnvMap = Record<string, string>;

export type BootFailureReason =
  | InfrastructureBootFailureReason
  | 'IOS_RUNNER_DEVICE_NOT_PROVISIONED'
  | 'BOOT_COMMAND_FAILED'
  | 'UNKNOWN';

/** The slice of physical-device control the runner's command routing consults. */
export type IosPhysicalDeviceRunnerControl = {
  backend: string;
  resolveTunnel(device: DeviceInfo, timeoutBudgetMs?: number): Promise<{ tunnelIp: string | null }>;
};

export type AppleRunnerHost = {
  // Process execution (@agent-device/host-kit/command)
  runCmdStreaming(cmd: string, args: string[], options?: ExecStreamOptions): Promise<ExecResult>;
  runCmdSync(cmd: string, args: string[], options?: ExecOptions): ExecResult;
  runCmdBackground(
    cmd: string,
    args: string[],
    options?: ExecBackgroundOptions,
  ): ExecBackgroundResult;
  requireExecSuccess(
    result: ExecResult,
    message: string,
    extra?: Record<string, unknown> | ((result: ExecResult) => Record<string, unknown>),
  ): ExecResult;
  // Diagnostics (@agent-device/host-kit/diagnostics)
  emitDiagnostic(event: DiagnosticEventInput): void;
  withDiagnosticTimer<T>(
    phase: string,
    fn: () => Promise<T> | T,
    data?: Record<string, unknown>,
  ): Promise<T>;
  // Retry (@agent-device/host-kit/retry)
  retryWithPolicy<T>(
    fn: (context: RetryAttemptContext) => Promise<T>,
    policy?: RetryPolicy,
    options?: RetryOptions,
  ): Promise<T>;
  isEnvTruthy(value: string | undefined): boolean;
  deadlineFromTimeoutMs(timeoutMs: number, nowMs?: number): Deadline;
  // Host process probes and signals (@agent-device/host-kit/process)
  isProcessAlive(pid: number): boolean;
  isProcessGroupAlive(pid: number): boolean;
  readProcessStartTime(pid: number): string | null;
  readProcessCommand(pid: number): string | null;
  signalPidsBestEffort(pidsToSignal: readonly number[], signal: NodeJS.Signals): number;
  signalProcessGroupBestEffort(pid: number, signal: NodeJS.Signals): boolean;
  // Project identity (@agent-device/host-kit/version)
  findProjectRoot(): string;
  readVersion(root?: string): string;
  // Locks (@agent-device/host-kit/file, @agent-device/kernel/keyed-lock)
  acquireProcessLock(params: {
    lockDirPath: string;
    owner: ProcessLockOwner;
    timeoutMs?: number;
    pollMs?: number;
    ownerGraceMs?: number;
    description?: string;
  }): Promise<() => Promise<void>>;
  withKeyedLock<T>(
    locks: Map<string, Promise<unknown>>,
    key: string,
    task: () => Promise<T>,
  ): Promise<T>;
  // Atomic publish (@agent-device/host-kit/file)
  publishFileSync(options: {
    destination: string;
    contents: string;
    mode?: number;
    publish?: 'replace' | 'link-exclusive';
  }): void;
  // Owner liveness (@agent-device/host-kit/process)
  classifyOwnerLiveness(params: {
    owner: { pid: number; startTime: string | null };
    stateDir?: string;
  }): OwnerLiveness;
  // Memoization (@agent-device/kernel/ttl-memo)
  createTtlMemo<Key, Value>(options?: TtlMemoOptions): TtlMemo<Key, Value>;
  // Parsing helpers (@agent-device/kernel/source-value, @agent-device/kernel/record)
  parseBooleanLiteral(value: string): boolean | undefined;
  isRecord(value: unknown): value is Record<string, unknown>;
  // Simulator device-set isolation (@agent-device/kernel/device-isolation)
  resolveIosSimulatorDeviceSetPath(flagValue: string | undefined): string | undefined;
  // Request progress and cancellation (@agent-device/host-kit/request)
  emitRequestProgress(event: RequestProgressEvent): void;
  getRequestSignal(requestId: string | undefined): AbortSignal | undefined;
  isRequestCanceled(requestId: string | undefined): boolean;
  // Boot-failure classification (src/platforms/boot-diagnostics.ts)
  classifyBootFailure(input: {
    error?: unknown;
    message?: string;
    stdout?: string;
    stderr?: string;
    context?: { platform?: 'ios' | 'android'; phase?: 'boot' | 'connect' | 'transport' };
  }): BootFailureReason;
  bootFailureHint(reason: BootFailureReason): string;
  // Apple foreground tooling (src/platforms/apple/core/tool-provider.ts)
  runAppleToolCommand(cmd: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  runXcrun(args: string[], options?: ExecOptions): Promise<ExecResult>;
  readApplePlistJson(
    plistPath: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
  // simctl argument shaping (src/platforms/apple/core/simctl.ts)
  buildSimctlArgsForDevice(device: DeviceInfo, args: string[]): string[];
  // Physical-device control routing (src/platforms/apple/core/physical-device-control.ts)
  resolveIosPhysicalDeviceControl(device: DeviceInfo): IosPhysicalDeviceRunnerControl;
  // XML plist traversal (src/platforms/apple/core/plist-xml.ts)
  visitXmlPlistEntries(nodes: XmlNode[], visitor: (key: string, valueNode: XmlNode) => void): void;
  // Daemon-owned lease owner state directory (src/platforms/apple/core/runner-owner-state.ts)
  leaseOwnerStateDir(): string | undefined;
};

let boundHost: AppleRunnerHost | undefined;

/**
 * Binds the process-wide host. Called by `createAppleRunnerClient`; binding a
 * different host after one is bound throws, because the runner keeps
 * process-wide state (sessions, leases, provider scopes) that cannot serve two
 * hosts. Rebinding the same reference is a no-op.
 */
export function bindAppleRunnerHost(host: AppleRunnerHost): void {
  if (boundHost && boundHost !== host) {
    throw new Error('Apple runner host is already bound to a different implementation.');
  }
  boundHost = host;
}

function requireHost(): AppleRunnerHost {
  if (!boundHost) {
    throw new Error(
      'Apple runner host is not bound. Construct the client via createAppleRunnerClient() before using runner operations.',
    );
  }
  return boundHost;
}

// Delegators keep the original root-utility names so runner modules only swap
// import specifiers; every call resolves the bound host lazily.

export const runCmdStreaming: AppleRunnerHost['runCmdStreaming'] = (cmd, args, options) =>
  requireHost().runCmdStreaming(cmd, args, options);
export const runCmdSync: AppleRunnerHost['runCmdSync'] = (cmd, args, options) =>
  requireHost().runCmdSync(cmd, args, options);
export const runCmdBackground: AppleRunnerHost['runCmdBackground'] = (cmd, args, options) =>
  requireHost().runCmdBackground(cmd, args, options);
export const requireExecSuccess: AppleRunnerHost['requireExecSuccess'] = (result, message, extra) =>
  requireHost().requireExecSuccess(result, message, extra);
export const emitDiagnostic: AppleRunnerHost['emitDiagnostic'] = (event) =>
  requireHost().emitDiagnostic(event);
export const withDiagnosticTimer = <T>(
  phase: string,
  fn: () => Promise<T> | T,
  data?: Record<string, unknown>,
): Promise<T> => requireHost().withDiagnosticTimer(phase, fn, data);
export const retryWithPolicy = <T>(
  fn: (context: RetryAttemptContext) => Promise<T>,
  policy?: RetryPolicy,
  options?: RetryOptions,
): Promise<T> => requireHost().retryWithPolicy(fn, policy, options);
export const isEnvTruthy: AppleRunnerHost['isEnvTruthy'] = (value) =>
  requireHost().isEnvTruthy(value);
export const isProcessAlive: AppleRunnerHost['isProcessAlive'] = (pid) =>
  requireHost().isProcessAlive(pid);
export const isProcessGroupAlive: AppleRunnerHost['isProcessGroupAlive'] = (pid) =>
  requireHost().isProcessGroupAlive(pid);
export const readProcessStartTime: AppleRunnerHost['readProcessStartTime'] = (pid) =>
  requireHost().readProcessStartTime(pid);
export const readProcessCommand: AppleRunnerHost['readProcessCommand'] = (pid) =>
  requireHost().readProcessCommand(pid);
export const signalPidsBestEffort: AppleRunnerHost['signalPidsBestEffort'] = (pids, signal) =>
  requireHost().signalPidsBestEffort(pids, signal);
export const signalProcessGroupBestEffort: AppleRunnerHost['signalProcessGroupBestEffort'] = (
  pid,
  signal,
) => requireHost().signalProcessGroupBestEffort(pid, signal);
export const findProjectRoot: AppleRunnerHost['findProjectRoot'] = () =>
  requireHost().findProjectRoot();
export const readVersion: AppleRunnerHost['readVersion'] = (root) =>
  requireHost().readVersion(root);
export const acquireProcessLock: AppleRunnerHost['acquireProcessLock'] = (params) =>
  requireHost().acquireProcessLock(params);
export const withKeyedLock = <T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> => requireHost().withKeyedLock(locks, key, task);
export const publishFileSync: AppleRunnerHost['publishFileSync'] = (options) =>
  requireHost().publishFileSync(options);
export const classifyOwnerLiveness: AppleRunnerHost['classifyOwnerLiveness'] = (params) =>
  requireHost().classifyOwnerLiveness(params);
export const createTtlMemo = <Key, Value>(options?: TtlMemoOptions): TtlMemo<Key, Value> =>
  requireHost().createTtlMemo(options);
export const parseBooleanLiteral: AppleRunnerHost['parseBooleanLiteral'] = (value) =>
  requireHost().parseBooleanLiteral(value);
export const isRecord: AppleRunnerHost['isRecord'] = (value): value is Record<string, unknown> =>
  requireHost().isRecord(value);
export const resolveIosSimulatorDeviceSetPath: AppleRunnerHost['resolveIosSimulatorDeviceSetPath'] =
  (flagValue) => requireHost().resolveIosSimulatorDeviceSetPath(flagValue);
export const emitRequestProgress: AppleRunnerHost['emitRequestProgress'] = (event) =>
  requireHost().emitRequestProgress(event);
export const getRequestSignal: AppleRunnerHost['getRequestSignal'] = (requestId) =>
  requireHost().getRequestSignal(requestId);
export const isRequestCanceled: AppleRunnerHost['isRequestCanceled'] = (requestId) =>
  requireHost().isRequestCanceled(requestId);
export const classifyBootFailure: AppleRunnerHost['classifyBootFailure'] = (input) =>
  requireHost().classifyBootFailure(input);
export const bootFailureHint: AppleRunnerHost['bootFailureHint'] = (reason) =>
  requireHost().bootFailureHint(reason);
export const runAppleToolCommand: AppleRunnerHost['runAppleToolCommand'] = (cmd, args, options) =>
  requireHost().runAppleToolCommand(cmd, args, options);
export const runXcrun: AppleRunnerHost['runXcrun'] = (args, options) =>
  requireHost().runXcrun(args, options);
export const readApplePlistJson: AppleRunnerHost['readApplePlistJson'] = (plistPath, signal) =>
  requireHost().readApplePlistJson(plistPath, signal);
export const buildSimctlArgsForDevice: AppleRunnerHost['buildSimctlArgsForDevice'] = (
  device,
  args,
) => requireHost().buildSimctlArgsForDevice(device, args);
export const resolveIosPhysicalDeviceControl: AppleRunnerHost['resolveIosPhysicalDeviceControl'] = (
  device,
) => requireHost().resolveIosPhysicalDeviceControl(device);
export const visitXmlPlistEntries: AppleRunnerHost['visitXmlPlistEntries'] = (nodes, visitor) =>
  requireHost().visitXmlPlistEntries(nodes, visitor);
export const leaseOwnerStateDir: AppleRunnerHost['leaseOwnerStateDir'] = () =>
  requireHost().leaseOwnerStateDir();

/**
 * Deadline keeps its root call-site shape (`Deadline.fromTimeoutMs(...)`);
 * instances come from the host so package and root share one clock model.
 */
export const Deadline = {
  fromTimeoutMs(timeoutMs: number, nowMs?: number): Deadline {
    return requireHost().deadlineFromTimeoutMs(timeoutMs, nowMs);
  },
};
