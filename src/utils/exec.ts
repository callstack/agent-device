import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../kernel/errors.ts';
import { emitDiagnostic, getDiagnosticsMeta, updateDiagnosticsScope } from './diagnostics.ts';
import { parseBooleanLiteral } from './source-value.ts';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  binaryStdout?: boolean;
  stdin?: string | Buffer;
  timeoutMs?: number;
  detached?: boolean;
  signal?: AbortSignal;
  /** Max stdout/stderr bytes for synchronous runs (default Node ~1MB). */
  maxBuffer?: number;
};

type ExecStreamOptions = ExecOptions & {
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
};

export type ExecBackgroundResult = {
  child: ReturnType<typeof spawn>;
  wait: Promise<ExecResult>;
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

export type ExecDetachedProcess = {
  pid: number;
  exited: Promise<ExecDetachedExit>;
};

export type ExecBackgroundOptions = ExecOptions & {
  /**
   * Capture stdout/stderr into the wait result when the child has piped stdio.
   * Set false when the caller owns, ignores, or forwards the streams.
   */
  captureOutput?: boolean;
  stdio?: StdioOptions;
};

const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const WINDOWS_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const EXEC_DIAGNOSTIC_ARG_LIMIT = 6;
export type CommandExecutorOverride = (
  cmd: string,
  args: string[],
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

export async function runCmd(
  cmd: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const overrideResult = commandExecutorOverrideScope.getStore()?.(cmd, args, options);
  if (overrideResult) return await overrideResult;
  return await runSpawnedCommand(cmd, args, options);
}

export async function runCmdStreaming(
  cmd: string,
  args: string[],
  options: ExecStreamOptions = {},
): Promise<ExecResult> {
  const overrideResult = commandExecutorOverrideScope.getStore()?.(cmd, args, options);
  if (overrideResult) return await overrideResult;
  return await runSpawnedCommand(cmd, args, options);
}

function runSpawnedCommand(
  cmd: string,
  args: string[],
  options: ExecStreamOptions = {},
): Promise<ExecResult> {
  const executable = normalizeExecutableCommand(cmd);
  const execTrace = createExecTraceContext();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: options.detached,
      windowsHide: true,
      shell: false,
    });
    options.onSpawn?.(child);

    let stdout = '';
    const stdoutChunks: Buffer[] | undefined = options.binaryStdout ? [] : undefined;
    let stderr = '';
    let didTimeout = false;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const timeoutHandle = timeoutMs
      ? setTimeout(() => {
          didTimeout = true;
          killProcessTree(child, options.detached);
        }, timeoutMs)
      : null;
    const abort = watchCommandAbort(child, options);

    if (!options.binaryStdout) child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    void writeChildStdin(child, options.stdin).catch((err: unknown) => {
      if (abort.didAbort || didTimeout) return;
      if (isEpipeError(err)) return;
      reject(createStdinError(executable, cmd, args, err));
      killProcessTree(child, options.detached);
    });

    child.stdout.on('data', (chunk) => {
      if (options.binaryStdout) {
        stdoutChunks?.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return;
      }
      const text = String(chunk);
      stdout += text;
      options.onStdoutChunk?.(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderrChunk?.(text);
    });

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      abort.dispose();
      execTrace.emitForegroundCompletion(cmd, args);
      reject(spawnRejectionError(abort, executable, cmd, args, err));
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      abort.dispose();
      execTrace.emitForegroundCompletion(cmd, args);
      const exitCode = code ?? 1;
      if (!abort.didAbort && didTimeout && timeoutMs) {
        reject(createTimeoutError(executable, cmd, args, timeoutMs, exitCode, stdout, stderr));
        return;
      }
      const failure = commandCloseFailure(
        abort,
        executable,
        cmd,
        args,
        exitCode,
        options.allowFailure,
        stdout,
        stderr,
      );
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        stdoutBuffer: stdoutChunks ? Buffer.concat(stdoutChunks) : undefined,
      });
    });
  });
}

export async function whichCmd(cmd: string): Promise<boolean> {
  const candidate = normalizeExecutableLookup(cmd);
  if (!candidate) return false;

  if (path.isAbsolute(candidate)) {
    return isExecutablePath(candidate);
  }

  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  const pathExtensions = resolvePathExtensions();
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
  const candidate = normalizeOverridePath(rawPath, envName, 'executable');
  if (!candidate) return undefined;
  if (!(await isExecutablePath(candidate))) {
    throw new AppError(
      'TOOL_MISSING',
      `${envName} points to a missing or non-executable file: ${candidate}`,
      { envName, path: candidate },
    );
  }
  return candidate;
}

export async function resolveFileOverridePath(
  rawPath: string | undefined,
  envName: string,
): Promise<string | undefined> {
  const candidate = normalizeOverridePath(rawPath, envName, 'file');
  if (!candidate) return undefined;
  if (!(await isFilePath(candidate))) {
    throw new AppError(
      'TOOL_MISSING',
      `${envName} points to a missing or non-file path: ${candidate}`,
      { envName, path: candidate },
    );
  }
  return candidate;
}

export function runCmdSync(cmd: string, args: string[], options: ExecOptions = {}): ExecResult {
  const executable = normalizeExecutableCommand(cmd);
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
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

  return { stdout, stderr, exitCode, stdoutBuffer };
}

export function runCmdDetached(
  cmd: string,
  args: string[],
  options: ExecDetachedOptions = {},
): number {
  return runCmdDetachedMonitored(cmd, args, options).pid;
}

export function runCmdDetachedMonitored(
  cmd: string,
  args: string[],
  options: ExecDetachedOptions = {},
): ExecDetachedProcess {
  const executable = normalizeExecutableCommand(cmd);
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
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
  return { pid, exited };
}

export function runCmdBackground(
  cmd: string,
  args: string[],
  options: ExecBackgroundOptions = {},
): ExecBackgroundResult {
  const executable = normalizeExecutableCommand(cmd);
  const execTrace = createExecTraceContext();
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    detached: options.detached,
    windowsHide: true,
    shell: false,
  });
  execTrace.emitBackgroundSpawn(cmd, args);

  let stdout = '';
  let stderr = '';
  const captureOutput = options.captureOutput ?? true;
  const abort = watchCommandAbort(child, options);

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

  const wait = new Promise<ExecResult>((resolve, reject) => {
    child.on('error', (err) => {
      abort.dispose();
      execTrace.emitBackgroundCompletion(cmd, args, 'error');
      reject(spawnRejectionError(abort, executable, cmd, args, err));
    });
    child.on('close', (code) => {
      abort.dispose();
      execTrace.emitBackgroundCompletion(cmd, args, 'exit');
      const exitCode = code ?? 1;
      const failure = commandCloseFailure(
        abort,
        executable,
        cmd,
        args,
        exitCode,
        options.allowFailure,
        stdout,
        stderr,
      );
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });

  return { child, wait };
}

type ExecTraceContext = {
  emitBackgroundCompletion: (cmd: string, args: string[], event: 'error' | 'exit') => void;
  emitBackgroundSpawn: (cmd: string, args: string[]) => void;
  emitForegroundCompletion: (cmd: string, args: string[]) => void;
};

function createExecTraceContext(): ExecTraceContext {
  const diagnosticsMeta = getDiagnosticsMeta();
  const diagnosticsDebugEnabled = diagnosticsMeta.debug === true;
  const envTraceEnabled = parseBooleanLiteral(process.env.AGENT_DEVICE_EXEC_TRACE ?? '') === true;
  if (!diagnosticsDebugEnabled && !envTraceEnabled) {
    return createDisabledExecTraceContext();
  }
  if (envTraceEnabled && diagnosticsMeta.flushOnSuccess !== true) {
    updateDiagnosticsScope({ flushOnSuccess: true });
  }
  const startedAtMs = Date.now();
  let completionEmitted = false;
  return {
    emitForegroundCompletion: (cmd, args) => {
      if (completionEmitted) return;
      completionEmitted = true;
      emitExecCommandDiagnostic({
        cmd,
        args,
        startedAtMs,
      });
    },
    emitBackgroundSpawn: (cmd, args) => {
      emitExecCommandDiagnostic({
        cmd,
        args,
        data: { event: 'spawn' },
      });
    },
    emitBackgroundCompletion: (cmd, args, event) => {
      if (completionEmitted) return;
      completionEmitted = true;
      emitExecCommandDiagnostic({
        cmd,
        args,
        startedAtMs,
        data: { event },
      });
    },
  };
}

function createDisabledExecTraceContext(): ExecTraceContext {
  return {
    emitForegroundCompletion: () => {},
    emitBackgroundSpawn: () => {},
    emitBackgroundCompletion: () => {},
  };
}

function emitExecCommandDiagnostic(params: {
  cmd: string;
  args: string[];
  startedAtMs?: number;
  data?: Record<string, unknown>;
}): void {
  const argsPrefix = params.args.slice(0, EXEC_DIAGNOSTIC_ARG_LIMIT);
  emitDiagnostic({
    level: 'debug',
    phase: 'exec_command',
    durationMs:
      params.startedAtMs === undefined ? undefined : Math.max(0, Date.now() - params.startedAtMs),
    data: {
      command: params.cmd,
      argsPrefix,
      ...(params.args.length > argsPrefix.length
        ? { omittedArgCount: params.args.length - argsPrefix.length }
        : {}),
      ...(params.data ?? {}),
    },
  });
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

function createSpawnError(executable: string, cmd: string, args: string[], err: Error): AppError {
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
  args: string[],
  cause: Error,
): AppError {
  return new AppError('COMMAND_FAILED', `Failed to run ${executable}`, { cmd, args }, cause);
}

function createStdinError(
  executable: string,
  cmd: string,
  args: string[],
  cause: unknown,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Failed to write stdin for ${executable}`,
    { cmd, args },
    cause instanceof Error ? cause : undefined,
  );
}

function createCommandCanceledError(executable: string, cmd: string, args: string[]): AppError {
  return new AppError('COMMAND_FAILED', 'request canceled', {
    cmd,
    args,
    executable,
    reason: 'request_canceled',
  });
}

function createTimeoutError(
  executable: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
  exitCode: number,
  stdout: string,
  stderr: string,
): AppError {
  return new AppError('COMMAND_FAILED', `${executable} timed out after ${timeoutMs}ms`, {
    cmd,
    args,
    stdout,
    stderr,
    exitCode,
    timeoutMs,
  });
}

function createExitError(
  executable: string,
  cmd: string,
  args: string[],
  exitCode: number,
  stdout: string,
  stderr: string,
): AppError {
  return new AppError('COMMAND_FAILED', `${executable} exited with code ${exitCode}`, {
    cmd,
    args,
    stdout,
    stderr,
    exitCode,
    processExitError: true,
  });
}

type CommandAbort = { readonly didAbort: boolean };

// Error to reject a spawned child's `error` event with: canceled if we aborted, else a spawn error.
function spawnRejectionError(
  abort: CommandAbort,
  executable: string,
  cmd: string,
  args: string[],
  err: Error,
): AppError {
  return abort.didAbort
    ? createCommandCanceledError(executable, cmd, args)
    : createSpawnError(executable, cmd, args, err);
}

// Failure (if any) for a spawned child's `close` event: canceled if we aborted, an exit error on
// a non-zero code unless allowed, otherwise null (the command resolves successfully).
function commandCloseFailure(
  abort: CommandAbort,
  executable: string,
  cmd: string,
  args: string[],
  exitCode: number,
  allowFailure: boolean | undefined,
  stdout: string,
  stderr: string,
): AppError | null {
  if (abort.didAbort) return createCommandCanceledError(executable, cmd, args);
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

function resolvePathExtensions(): string[] {
  if (process.platform !== 'win32') return [''];
  const rawPathExt = process.env.PATHEXT;
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

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const timeout = Math.floor(value as number);
  if (timeout <= 0) return undefined;
  return timeout;
}

function watchCommandAbort(
  child: ChildProcess,
  options: Pick<ExecOptions, 'detached' | 'signal'>,
): { readonly didAbort: boolean; dispose: () => void } {
  let didAbort = false;
  const onAbort = () => {
    didAbort = true;
    killProcessTree(child, options.detached);
  };
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    get didAbort() {
      return didAbort;
    },
    dispose: () => {
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

function killProcessTree(child: ChildProcess, detached: boolean | undefined): void {
  if (detached && child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {}
  }
  child.kill('SIGKILL');
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
