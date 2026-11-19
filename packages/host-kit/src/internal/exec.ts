import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  bindCommandLifecycle,
  destroyCommandStreams,
  killProcessTree,
  commandSettlementReason,
  createExecTraceContext,
  normalizeTimeoutMs,
  type ExecSettlementReason,
} from './exec-trace.ts';
export { signalProcessGroupBestEffort } from './exec-trace.ts';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
  /** The signal that ended the process, when one did. */
  signal?: string;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Applied as the final word over the resolved spawn environment, so one child variable can be
   * pinned without dropping the rest of the effective environment — `TZ` picks the zone a
   * `ps -o lstart` read renders in, so replacing the whole `env` would move the identity clock.
   */
  envOverrides?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  binaryStdout?: boolean;
  stdin?: string | Buffer;
  timeoutMs?: number;
  detached?: boolean;
  signal?: AbortSignal;
  /** Max captured bytes per stream for runCmd and runCmdSync. runCmd is unlimited when omitted. */
  maxBuffer?: number;
  /**
   * How a deadline or a cancelled request stops the child. Without this it is SIGKILL at
   * once. A child that has to undo something before it dies — the macOS helper releasing a
   * mouse button it is holding — is sent `signal` first, and SIGKILL only once `graceMs`
   * pass without it exiting.
   */
  kill?: { readonly signal: NodeJS.Signals; readonly graceMs: number };
};

export type ExecStreamOptions = ExecOptions & {
  /** Set false when chunk callbacks own output and only the exit code is needed. */
  captureOutput?: boolean;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
};

export type ExecBackgroundResult = {
  child: ReturnType<typeof spawn>;
  /** A background run reports no `signal`: its caller owns the child and reads its exit directly. */
  wait: Promise<Omit<ExecResult, 'signal'>>;
};

type ExecDetachedOptions = ExecOptions & {
  stdio?: StdioOptions;
};

export type ExecDetachedExit = {
  pid: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  error?: string;
};

/**
 * The child's side of the Node IPC channel, present only when `stdio` includes `'ipc'`. It is
 * unref'd at spawn, so neither the child handle nor the channel keeps this process alive.
 */
export type ExecDetachedChannel = Readonly<{
  /** Subscribes to the messages the child sends over its IPC channel. */
  onMessage(listener: (message: unknown) => void): void;
}>;

export type ExecDetachedProcess = {
  pid: number;
  exited: Promise<ExecDetachedExit>;
  channel?: ExecDetachedChannel;
};

/**
 * Background runs have no `timeoutMs`: the callers are long-lived sessions (the
 * Android snapshot helper, the keep-hot xcodebuild runner, app-log capture), and
 * a deadline field the spawn path never armed was one plumbing change away from
 * killing them. A background deadline belongs to its caller, which cancels it with
 * `signal`; a caller that kills the child directly still waits for the streams to
 * drain, exactly as before.
 */
export type ExecBackgroundOptions = Omit<ExecOptions, 'timeoutMs' | 'maxBuffer'> & {
  /**
   * Capture stdout/stderr into the wait result when the child has piped stdio.
   * Set false when the caller owns, ignores, or forwards the streams.
   */
  captureOutput?: boolean;
  stdio?: StdioOptions;
};

const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const WINDOWS_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
export type CommandExecutorOverride = (
  cmd: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult> | undefined;

const commandExecutorOverrideScope = new AsyncLocalStorage<CommandExecutorOverride | undefined>();

export async function withCommandExecutorOverride<T>(
  override: CommandExecutorOverride | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!override) return await fn();
  return await commandExecutorOverrideScope.run(override, fn);
}

// Used by local executors to bypass the active override for intentional host command execution.
export async function withoutCommandExecutorOverride<T>(fn: () => Promise<T>): Promise<T> {
  return await commandExecutorOverrideScope.run(undefined, fn);
}

type CommandHostScope = Readonly<{
  host: HostEnvironment;
  requestEnv: EnvMap | undefined;
}>;

const commandHostScope = new AsyncLocalStorage<CommandHostScope>();

/**
 * Runs `fn` as the host that owns the commands it spawns. A command without its own `env` starts
 * from `host.env`, then takes `requestEnv` on top, so neither the process's environment nor a
 * concurrent request's values reach it. Outside a scope a command without `env` inherits the process's.
 */
export async function withCommandHost<T>(
  scope: CommandHostScope,
  fn: () => Promise<T>,
): Promise<T> {
  // A nested scope of the same host that names no request env keeps the enclosing request's.
  const enclosing = commandHostScope.getStore();
  const requestEnv =
    scope.requestEnv ?? (enclosing?.host === scope.host ? enclosing.requestEnv : undefined);
  return await commandHostScope.run({ host: scope.host, requestEnv }, fn);
}

/**
 * The host of the enclosing {@link withCommandHost} scope, for code that has no host of its own.
 * Outside a scope there is no host to answer with, so it refuses rather than guess.
 */
export function commandHostEnvironment(): HostEnvironment {
  const scope = commandHostScope.getStore();
  if (!scope) {
    throw new AppError('COMMAND_FAILED', 'No host environment is bound to this command.', {
      reason: 'host_environment_unscoped',
    });
  }
  return scope.host;
}

/** Effective toolchain selection; an explicitly empty request value selects `xcode-select`. */
export function commandDeveloperDir(): string | undefined {
  const scope = commandHostScope.getStore();
  if (scope?.requestEnv && Object.hasOwn(scope.requestEnv, 'DEVELOPER_DIR')) {
    return scope.requestEnv.DEVELOPER_DIR || undefined;
  }
  return scope?.host.env.DEVELOPER_DIR || undefined;
}

function resolveSpawnEnv(
  env: NodeJS.ProcessEnv | undefined,
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  const scope = commandHostScope.getStore();
  if (!scope) {
    // Outside a host scope there is no captured environment to merge into: an explicit `env` is
    // still honored with the overrides on top, and with neither the child inherits natively.
    if (env === undefined) return overrides;
    return { ...env, ...overrides };
  }
  return { ...(env ?? scope.host.env), ...scope.requestEnv, ...overrides };
}

export async function runCmd(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const overrideResult = commandExecutorOverrideScope.getStore()?.(cmd, args, options);
  if (overrideResult) return coerceExecResult(await overrideResult);
  return await runSpawnedCommand(cmd, args, options);
}

export async function runCmdStreaming(
  cmd: string,
  args: readonly string[],
  options: ExecStreamOptions = {},
): Promise<ExecResult> {
  const overrideResult = commandExecutorOverrideScope.getStore()?.(cmd, args, options);
  if (overrideResult) return coerceExecResult(await overrideResult);
  return await runSpawnedCommand(cmd, args, options);
}

/**
 * Normalize an exec result produced outside this module. Tool providers,
 * executor overrides, and SDK-supplied adb executors are plain callbacks whose
 * results cross an unchecked boundary; coercing once here lets downstream code
 * trust the ExecResult types instead of re-wrapping fields defensively at every
 * use. A non-number exitCode coerces to 1 — the same failure branch such a
 * result already landed in at every `exitCode !== 0` guard.
 */
export function coerceExecResult<T extends Pick<ExecResult, 'stdout' | 'stderr' | 'exitCode'>>(
  result: T,
): T {
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? '');
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;
  if (stdout === result.stdout && stderr === result.stderr && exitCode === result.exitCode) {
    return result;
  }
  return { ...result, stdout, stderr, exitCode };
}

function runSpawnedCommand(
  cmd: string,
  args: readonly string[],
  options: ExecStreamOptions = {},
): Promise<ExecResult> {
  const executable = normalizeExecutableCommand(cmd);
  const execTrace = createExecTraceContext(
    cmd,
    normalizeTimeoutMs(options.timeoutMs),
    commandHostScope.getStore()?.host.env,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: resolveSpawnEnv(options.env, options.envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: options.detached,
      windowsHide: true,
      shell: false,
    });
    child.once('spawn', () => execTrace.emit('spawn', { pid: child.pid }));
    options.onSpawn?.(child);

    let stdout = '';
    const stdoutChunks: Buffer[] | undefined =
      options.binaryStdout && options.captureOutput !== false ? [] : undefined;
    let stderr = '';
    const outputBytes = { stdout: 0, stderr: 0 };
    let exceededStream: 'stdout' | 'stderr' | undefined;
    let didTimeout = false;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    let timeoutHandle: NodeJS.Timeout | null = null;
    let settled = false;
    function finish(reason: ExecSettlementReason): boolean {
      if (settled) return false;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      abort.dispose();
      destroyCommandStreams(child);
      execTrace.emit('settled', { reason });
      return true;
    }
    function fail(error: AppError, reason: ExecSettlementReason): void {
      if (finish(reason)) reject(error);
    }
    function settle(code: number | null): void {
      const finalReason = commandSettlementReason({
        didAbort: abort.didAbort,
        exceededStream,
        didTimeout,
        code,
        allowFailure: options.allowFailure,
      });
      if (!finish(finalReason)) return;
      const finalExitCode = code ?? 1;
      if (!abort.didAbort && exceededStream && !didTimeout) {
        reject(
          new AppError('COMMAND_FAILED', `${executable} exceeded its output limit`, {
            cmd,
            args,
            reason: 'command_output_limit',
            stream: exceededStream,
            maxBuffer: options.maxBuffer,
            stdout,
            stderr,
          }),
        );
        return;
      }
      if (!abort.didAbort && didTimeout && timeoutMs) {
        reject(createTimeoutError(executable, cmd, args, timeoutMs, finalExitCode, stdout, stderr));
        return;
      }
      const failure = commandCloseFailure(
        abort,
        executable,
        cmd,
        args,
        finalExitCode,
        options.allowFailure,
        stdout,
        stderr,
      );
      if (failure) {
        reject(failure);
        return;
      }
      resolve(
        execResult(child, {
          stdout,
          stderr,
          exitCode: finalExitCode,
          stdoutBuffer: stdoutChunks ? Buffer.concat(stdoutChunks) : undefined,
        }),
      );
    }
    // A deadline that fires after the child exited on its own still has to settle: the
    // group kill that would have ended the pipe holder can no longer run through a child
    // Node already reaped.
    const { settlement, abort } = bindCommandLifecycle(child, options, execTrace, settle);
    timeoutHandle = timeoutMs
      ? setTimeout(() => {
          execTrace.emit('deadline');
          didTimeout = exceededStream === undefined;
          settlement.requestKill();
        }, timeoutMs)
      : null;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    void writeChildStdin(child, options.stdin).catch((error: unknown) => {
      if (abort.didAbort || didTimeout) return;
      if (isEpipeError(error)) return;
      fail(createStdinError(executable, cmd, args, error), 'stdin_error');
      killProcessTree(child, options);
    });

    function acceptOutput(stream: 'stdout' | 'stderr', chunk: string | Buffer): boolean {
      if (exceededStream) return false;
      if (options.captureOutput === false || options.maxBuffer === undefined) return true;
      outputBytes[stream] += Buffer.byteLength(chunk);
      if (outputBytes[stream] <= options.maxBuffer) return true;
      exceededStream = stream;
      settlement.requestKill();
      return false;
    }

    function appendText(stream: 'stdout' | 'stderr', text: string): void {
      if (!text) return;
      if (options.captureOutput !== false) {
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      }
      if (stream === 'stdout') options.onStdoutChunk?.(text);
      else options.onStderrChunk?.(text);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (!acceptOutput('stdout', chunk)) return;
      if (options.binaryStdout) {
        stdoutChunks?.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return;
      }
      appendText('stdout', stdoutDecoder.write(chunk));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (!acceptOutput('stderr', chunk)) return;
      appendText('stderr', stderrDecoder.write(chunk));
    });
    child.stdout.on('end', () => {
      if (!options.binaryStdout && !exceededStream) appendText('stdout', stdoutDecoder.end());
    });
    child.stderr.on('end', () => {
      if (!exceededStream) appendText('stderr', stderrDecoder.end());
    });

    child.on('error', (err) => {
      execTrace.emit('error');
      fail(spawnRejectionError(abort, executable, cmd, args, err), 'spawn_error');
    });
  });
}

function execResult(ended: { signalCode: string | null }, result: ExecResult): ExecResult {
  return ended.signalCode ? { ...result, signal: ended.signalCode } : result;
}

export async function whichCmd(cmd: string, env: EnvMap): Promise<boolean> {
  const candidate = normalizeExecutableLookup(cmd);
  if (!candidate) return false;

  if (path.isAbsolute(candidate)) {
    return isExecutablePath(candidate);
  }

  const pathValue = readPathVariable(env, 'PATH');
  if (!pathValue) return false;
  const pathExtensions = resolvePathExtensions(env);
  for (const directory of pathValue.split(path.delimiter)) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) continue;
    for (const entry of resolveExecutableCandidates(candidate, pathExtensions)) {
      if (await isExecutablePath(path.join(trimmedDirectory, entry))) {
        return true;
      }
    }
  }

  return false;
}

export async function resolveExecutableOverridePath(
  rawPath: string | undefined,
  envName: string,
): Promise<string | undefined> {
  return await resolveOverridePath(rawPath, envName, 'executable', isExecutablePath);
}

export async function resolveFileOverridePath(
  rawPath: string | undefined,
  envName: string,
): Promise<string | undefined> {
  return await resolveOverridePath(rawPath, envName, 'file', isFilePath);
}

async function resolveOverridePath(
  rawPath: string | undefined,
  envName: string,
  kind: 'executable' | 'file',
  isUsable: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  const candidate = normalizeOverridePath(rawPath, envName, kind);
  if (!candidate) return undefined;
  if (!(await isUsable(candidate))) {
    throw new AppError(
      'TOOL_MISSING',
      `${envName} points to a missing or non-${kind} ${kind === 'file' ? 'path' : 'file'}: ${candidate}`,
      { envName, path: candidate },
    );
  }
  return candidate;
}

// fallow-ignore-next-line complexity
export function runCmdSync(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {},
): ExecResult {
  const executable = normalizeExecutableCommand(cmd);
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: resolveSpawnEnv(options.env, options.envOverrides),
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: options.binaryStdout ? undefined : 'utf8',
    input: options.stdin,
    timeout: normalizeTimeoutMs(options.timeoutMs),
    windowsHide: true,
    shell: false,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      throw new AppError(
        'COMMAND_FAILED',
        `${executable} timed out after ${normalizeTimeoutMs(options.timeoutMs)}ms`,
        {
          cmd,
          args,
          timeoutMs: normalizeTimeoutMs(options.timeoutMs),
        },
        result.error,
      );
    }
    if (code === 'ENOENT') {
      throw createMissingToolError(executable, cmd, result.error);
    }
    throw createCommandFailedError(executable, cmd, args, result.error);
  }

  const stdoutBuffer = options.binaryStdout
    ? Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout ?? '')
    : undefined;
  const stdout = options.binaryStdout
    ? ''
    : typeof result.stdout === 'string'
      ? result.stdout
      : (result.stdout ?? '').toString();
  const stderr =
    typeof result.stderr === 'string' ? result.stderr : (result.stderr ?? '').toString();
  const exitCode = result.status ?? 1;

  if (exitCode !== 0 && !options.allowFailure) {
    throw createExitError(executable, cmd, args, exitCode, stdout, stderr);
  }

  return execResult({ signalCode: result.signal }, { stdout, stderr, exitCode, stdoutBuffer });
}

export function runCmdDetached(
  cmd: string,
  args: readonly string[],
  options: ExecDetachedOptions = {},
): number {
  return runCmdDetachedMonitored(cmd, args, options).pid;
}

export function runCmdDetachedMonitored(
  cmd: string,
  args: readonly string[],
  options: ExecDetachedOptions = {},
): ExecDetachedProcess {
  const executable = normalizeExecutableCommand(cmd);
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: resolveSpawnEnv(options.env, options.envOverrides),
    stdio: options.stdio ?? 'ignore',
    detached: true,
    windowsHide: true,
    shell: false,
  });
  const pid = child.pid ?? 0;
  const exited = new Promise<ExecDetachedExit>((resolve) => {
    child.once('error', (err) => {
      resolve({ pid, error: err.message });
    });
    child.once('exit', (code, signal) => {
      resolve({
        pid,
        ...(typeof code === 'number' ? { exitCode: code } : {}),
        ...(signal ? { signal } : {}),
      });
    });
  });
  child.unref();
  // A detached monitored child is joined through `exited`, never through its IPC channel, so the
  // channel must not hold this process's event loop either.
  child.channel?.unref();
  const channel: ExecDetachedChannel | undefined = child.channel
    ? Object.freeze({
        onMessage(listener: (message: unknown) => void): void {
          child.on('message', listener);
        },
      })
    : undefined;
  return { pid, exited, ...(channel ? { channel } : {}) };
}

export function runCmdBackground(
  cmd: string,
  args: readonly string[],
  options: ExecBackgroundOptions = {},
): ExecBackgroundResult {
  const executable = normalizeExecutableCommand(cmd);
  const execTrace = createExecTraceContext(cmd, undefined, commandHostScope.getStore()?.host.env);
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: resolveSpawnEnv(options.env, options.envOverrides),
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    detached: options.detached,
    windowsHide: true,
    shell: false,
  });
  child.once('spawn', () => execTrace.emit('spawn', { pid: child.pid }));

  let stdout = '';
  let stderr = '';
  const captureOutput = options.captureOutput ?? true;

  if (captureOutput) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
  }

  const wait = new Promise<Omit<ExecResult, 'signal'>>((resolve, reject) => {
    let settled = false;
    function finish(event: 'error' | 'exit'): boolean {
      if (settled) return false;
      settled = true;
      abort.dispose();
      destroyCommandStreams(child);
      execTrace.emit('settled', {
        reason:
          event === 'error'
            ? 'spawn_error'
            : abort.didAbort
              ? 'abort'
              : (child.exitCode ?? 1) !== 0 && !options.allowFailure
                ? 'exit_failure'
                : 'success',
      });
      return true;
    }
    function settle(code: number | null): void {
      if (!finish('exit')) return;
      const finalExitCode = code ?? 1;
      const failure = commandCloseFailure(
        abort,
        executable,
        cmd,
        args,
        finalExitCode,
        options.allowFailure,
        stdout,
        stderr,
      );
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ stdout, stderr, exitCode: finalExitCode });
    }
    const { abort } = bindCommandLifecycle(child, options, execTrace, settle);
    child.on('error', (err) => {
      execTrace.emit('error');
      if (finish('error')) reject(spawnRejectionError(abort, executable, cmd, args, err));
    });
  });

  return { child, wait };
}

function normalizeExecutableCommand(cmd: string): string {
  const candidate = normalizeExecutableLookup(cmd);
  if (!candidate) {
    throw new AppError('INVALID_ARGS', `Invalid executable command: ${JSON.stringify(cmd)}`, {
      cmd,
      hint: 'Use a bare command name from PATH or an absolute executable path.',
    });
  }
  return candidate;
}

function createSpawnError(
  executable: string,
  cmd: string,
  args: readonly string[],
  err: Error,
): AppError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return createMissingToolError(executable, cmd, err);
  }
  return createCommandFailedError(executable, cmd, args, err);
}

function createMissingToolError(executable: string, cmd: string, cause: Error): AppError {
  return new AppError('TOOL_MISSING', `${executable} not found in PATH`, { cmd }, cause);
}

function createCommandFailedError(
  executable: string,
  cmd: string,
  args: readonly string[],
  cause: Error,
): AppError {
  return new AppError('COMMAND_FAILED', `Failed to run ${executable}`, { cmd, args }, cause);
}

function createStdinError(
  executable: string,
  cmd: string,
  args: readonly string[],
  cause: unknown,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Failed to write stdin for ${executable}`,
    { cmd, args },
    cause instanceof Error ? cause : undefined,
  );
}

function createTimeoutError(
  executable: string,
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
  exitCode: number,
  stdout: string,
  stderr: string,
): AppError {
  // exec-guard-allow: deliberately no processExitError — "timed out after Nms"
  // beats whatever partial stderr the killed process left behind.
  return new AppError('COMMAND_FAILED', `${executable} timed out after ${timeoutMs}ms`, {
    cmd,
    args,
    stdout,
    stderr,
    exitCode,
    timeoutMs,
  });
}

/**
 * True only for the COMMAND_FAILED error this module raises when it kills a command at
 * its own `timeoutMs`. Callers classify with this rather than matching the message text,
 * so a command whose own output says "timed out" is not mistaken for one exec killed.
 */
export function isCommandTimeoutError(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    typeof error.details?.timeoutMs === 'number'
  );
}

function createExitError(
  executable: string,
  cmd: string,
  args: readonly string[],
  exitCode: number,
  stdout: string,
  stderr: string,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${executable} exited with code ${exitCode}`,
    execFailureDetails({ stdout, stderr, exitCode }, { cmd, args }),
  );
}

// xcrun itself emits this line, including when the caller supplies no command metadata.
const XCRUN_TOOL_NOT_FOUND_STDERR = /xcrun: error: unable to find utility "([^"]+)"/;

function xcrunToolNotFoundDetails(stderr: string): Record<string, unknown> {
  const tool = XCRUN_TOOL_NOT_FOUND_STDERR.exec(stderr)?.[1];
  if (!tool) return {};
  const developerDir = commandDeveloperDir();
  const source = developerDir
    ? `DEVELOPER_DIR ${developerDir}`
    : 'the developer dir selected by xcode-select (see xcode-select -p)';
  return {
    reason: 'xcrun-tool-not-found',
    developerDir: developerDir ?? null,
    hint: `xcrun could not find ${tool} in ${source}. Export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer (or your Xcode's path) before running agent-device, or run sudo xcode-select -s /Applications/Xcode.app.`,
  };
}

/**
 * Raises COMMAND_FAILED for a non-zero result, preserving stderr for normalizeError.
 * Passes successful results through unchanged and evaluates functional `extra` only on failure.
 */
export function requireExecSuccess<
  R extends Pick<ExecResult, 'stdout' | 'stderr'> & Readonly<{ exitCode: number | null }>,
>(
  result: R,
  message: string,
  extra?: Record<string, unknown> | ((result: R) => Record<string, unknown>),
): R {
  if (result.exitCode === 0) return result;
  throw new AppError(
    'COMMAND_FAILED',
    message,
    execFailureDetails(result, typeof extra === 'function' ? extra(result) : extra),
  );
}

/**
 * Exit-failure details for normalizeError, including null exit codes from signalled processes.
 */
export function execFailureDetails(
  result: Pick<ExecResult, 'stdout' | 'stderr'> & Readonly<{ exitCode: number | null }>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    processExitError: true,
    ...extra,
    // Last: a missing tool makes a caller's hint about the device or app moot.
    ...xcrunToolNotFoundDetails(result.stderr),
  };
}

type CommandAbort = { readonly didAbort: boolean };

function spawnRejectionError(
  abort: CommandAbort,
  executable: string,
  cmd: string,
  args: readonly string[],
  err: Error,
): AppError {
  return abort.didAbort
    ? createRequestCanceledError({ cmd, args, executable })
    : createSpawnError(executable, cmd, args, err);
}

function commandCloseFailure(
  abort: CommandAbort,
  executable: string,
  cmd: string,
  args: readonly string[],
  exitCode: number,
  allowFailure: boolean | undefined,
  stdout: string,
  stderr: string,
): AppError | null {
  if (abort.didAbort) return createRequestCanceledError({ cmd, args, executable });
  if (exitCode !== 0 && !allowFailure) {
    return createExitError(executable, cmd, args, exitCode, stdout, stderr);
  }
  return null;
}

function normalizeOverridePath(
  rawPath: string | undefined,
  envName: string,
  kind: 'executable' | 'file',
): string | undefined {
  const candidate = rawPath?.trim();
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new AppError(
      'INVALID_ARGS',
      `${envName} must be an absolute ${kind} path, not ${JSON.stringify(rawPath)}`,
      { envName, path: rawPath },
    );
  }
  return candidate;
}

function normalizeExecutableLookup(cmd: string): string | null {
  const candidate = cmd.trim();
  if (!candidate || candidate.includes('\0')) return null;
  if (path.isAbsolute(candidate)) return candidate;
  if (candidate.includes('/') || candidate.includes('\\')) {
    return null;
  }
  return BARE_COMMAND_RE.test(candidate) ? candidate : null;
}

/** Windows names an environment variable in any case; a captured copy no longer folds it. */
function readPathVariable(env: EnvMap, name: 'PATH' | 'PATHEXT'): string | undefined {
  if (process.platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function resolvePathExtensions(env: EnvMap): string[] {
  if (process.platform !== 'win32') return [''];
  const rawPathExt = readPathVariable(env, 'PATHEXT');
  if (!rawPathExt) return WINDOWS_PATH_EXTENSIONS;
  const extensions = rawPathExt
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return extensions.length > 0 ? extensions : WINDOWS_PATH_EXTENSIONS;
}

function resolveExecutableCandidates(cmd: string, pathExtensions: string[]): string[] {
  if (process.platform !== 'win32') return [cmd];
  const lowered = cmd.toLowerCase();
  if (pathExtensions.some((extension) => lowered.endsWith(extension))) {
    return [cmd];
  }
  return pathExtensions.map((extension) => `${cmd}${extension}`);
}

export async function isExecutablePath(filePath: string): Promise<boolean> {
  try {
    if (!(await isFilePath(filePath))) return false;
    await access(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFilePath(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function writeChildStdin(
  child: ChildProcess,
  stdin: string | Buffer | undefined,
): Promise<void> {
  if (!child.stdin) return;
  if (stdin === undefined) {
    child.stdin?.end();
    return;
  }
  await pipeline(Readable.from([stdin]), child.stdin);
}

function isEpipeError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPIPE'
  );
}
