import { relayDeviceShellArgvWithoutOptions } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import type { Readable, Stream, Writable } from 'node:stream';
import type { Rect } from '@agent-device/kernel/snapshot';
import type {
  AndroidImeHelperArtifact,
  AndroidSnapshotHelperArtifact,
} from './helper-artifacts.ts';
import type { AndroidProviderTouchPlan } from './touch-plan-lowering.ts';

// The adb transport vocabulary: the executor/provider shapes every module of the cluster (and the
// SDK, through the root shim) speaks, the pure lowering from semantic install options to adb
// flags, and the argv grammar that separates transport addressing — which device, which adb
// server — from the command that says what to run on it. Parsing, emitting, and the managed
// transport's rules over both live here so one declaration answers for every route.

export type AndroidAdbExecutorOptions = {
  allowFailure?: boolean;
  timeoutMs?: number;
  binaryStdout?: boolean;
  stdin?: string | Buffer;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  serverPort?: number;
};

export type AndroidAdbExecutorResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBuffer?: Buffer;
};

/** Structural mirror of node's StdioOptions; R13 bars the child_process import that names it. */
type AndroidAdbStdioOption = 'overlapped' | 'pipe' | 'ignore' | 'inherit';

/**
 * A spawned adb process is long-lived — the snapshot helper session rides it for the whole session
 * — so `timeoutMs` is not part of its options: background spawns arm no deadline, and a field that
 * looked like one invited callers to kill their own helper.
 */
export type AndroidAdbSpawnOptions = Omit<AndroidAdbExecutorOptions, 'timeoutMs'> & {
  cwd?: string;
  detached?: boolean;
  /** Max stdout/stderr bytes for synchronous runs (default Node ~1MB). */
  maxBuffer?: number;
  stdio?:
    | AndroidAdbStdioOption
    | Array<AndroidAdbStdioOption | 'ipc' | Stream | number | null | undefined>;
  /**
   * Capture stdout/stderr into the wait result when the child has piped stdio.
   * Set false when the caller owns, ignores, or forwards the streams.
   */
  captureOutput?: boolean;
};

export type AndroidAdbProcess = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

/**
 * Runs device-scoped adb arguments after the device serial has already been selected.
 * Implementations must be safe to call concurrently for one request.
 */
export type AndroidAdbExecutor = (
  args: readonly string[],
  options?: AndroidAdbExecutorOptions,
) => Promise<AndroidAdbExecutorResult>;

export type AndroidAdbSpawner = (
  args: readonly string[],
  options?: AndroidAdbSpawnOptions,
) => AndroidAdbProcess;

export type AndroidPortReverseEndpoint = `tcp:${number}` | `localabstract:${string}`;

export type AndroidPortReverseMapping = {
  local: AndroidPortReverseEndpoint;
  remote: AndroidPortReverseEndpoint;
  ownerId?: string;
};

export type AndroidPortReverseOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AndroidPortReverseProvider = {
  ensure(mapping: AndroidPortReverseMapping, options?: AndroidPortReverseOptions): Promise<void>;
  remove(local: AndroidPortReverseEndpoint, options?: AndroidPortReverseOptions): Promise<void>;
  removeAllOwned(ownerId: string, options?: AndroidPortReverseOptions): Promise<void>;
  list?(options?: AndroidPortReverseOptions): Promise<AndroidPortReverseMapping[]>;
};

export type AndroidAdbTransferOptions = AndroidAdbExecutorOptions;
export type AndroidAdbInstallOptions = AndroidAdbTransferOptions & {
  replace?: boolean;
};

export type AndroidAdbPuller = (
  remotePath: string,
  localPath: string,
  options?: AndroidAdbTransferOptions,
) => Promise<AndroidAdbExecutorResult>;

/**
 * Installs an APK path. Implementations are responsible for honoring the
 * semantic `replace` option (`adb install -r`).
 */
export type AndroidAdbInstaller = (
  apkPath: string,
  options?: AndroidAdbInstallOptions,
) => Promise<AndroidAdbExecutorResult>;

export type AndroidBundleInstaller = (
  bundlePath: string,
  options: Readonly<{ mode: string; signal?: AbortSignal }>,
) => Promise<void>;

export type AndroidTextInputAction = 'type' | 'fill';

export type AndroidTextInjectionRequest = {
  action: AndroidTextInputAction;
  text: string;
  delayMs?: number;
  /**
   * Present only for fill. Providers must make this target the focused/replaced
   * input for the request, not inject into an unrelated currently focused field.
   */
  target?: {
    x: number;
    y: number;
  };
};

export type AndroidTextInjector = (request: AndroidTextInjectionRequest) => Promise<void>;

export type AndroidTouchInjector = (
  request: AndroidProviderTouchPlan,
) => Promise<Record<string, unknown> | void>;

export type AndroidGestureViewportProvider = () => Promise<Rect>;

type AndroidAdbProviderBase = {
  /**
   * Fallback executor for device-scoped adb arguments. Providers may omit explicit
   * methods to keep the legacy exec-shaped pull/install fallback.
   */
  exec: AndroidAdbExecutor;
  spawn?: AndroidAdbSpawner;
  reverse?: AndroidPortReverseProvider;
  pull?: AndroidAdbPuller;
  install?: AndroidAdbInstaller;
  installBundle?: AndroidBundleInstaller;
  text?: AndroidTextInjector;
  snapshotHelperArtifact?: AndroidSnapshotHelperArtifact;
  imeHelperArtifact?: AndroidImeHelperArtifact;
};

type AndroidTouchCapabilities =
  | {
      touch?: never;
      gestureViewport?: never;
    }
  | {
      touch: AndroidTouchInjector;
      gestureViewport: AndroidGestureViewportProvider;
    };

export type AndroidTouchProvider = Required<
  Pick<AndroidTouchCapabilities, 'touch' | 'gestureViewport'>
>;

export type AndroidAdbProvider = AndroidAdbProviderBase & AndroidTouchCapabilities;

export type AndroidAdbProviderScopeOptions = {
  serial: string;
  serverPort?: number;
};

export type ScopedAndroidAdbBackgroundTransport =
  | Readonly<{ mode: 'local' }>
  | Readonly<{ mode: 'transport-composed'; spawn?: AndroidAdbSpawner }>;

export function normalizeAndroidAdbInstallOptions(options?: AndroidAdbInstallOptions): {
  installArgs: string[];
  execOptions: AndroidAdbTransferOptions;
} {
  const { replace, ...execOptions } = options ?? {};
  return { installArgs: replace ? ['-r'] : [], execOptions };
}

/**
 * Global options adb accepts before a command, mapped to the number of values each consumes. The
 * grammar tables below are transcribed from `adb help` (adb 1.0.41, platform-tools 35.0.2): this
 * arity, the `wait-for[-TRANSPORT]-STATE` product, and the server and transport commands a
 * device-scoped call must never reach.
 */
export const ADB_GLOBAL_OPTIONS = {
  '-a': 0,
  '-d': 0,
  '-e': 0,
  '-s': 1,
  '-t': 1,
  '-H': 1,
  '-P': 1,
  '-L': 1,
  '--one-device': 1,
  '--exit-on-write-error': 0,
} as const satisfies Readonly<Record<string, 0 | 1>>;

type AndroidAdbGlobalOption = keyof typeof ADB_GLOBAL_OPTIONS;

/** Transport qualifier of `wait-for[-TRANSPORT]-STATE`, spelled with its trailing separator. */
export const ADB_WAIT_TRANSPORTS = ['', 'usb-', 'local-', 'any-'] as const;

/** State argument of `wait-for[-TRANSPORT]-STATE`. */
export const ADB_WAIT_STATES = [
  'device',
  'recovery',
  'bootloader',
  'sideload',
  'sideload-window',
] as const;

/** Tokens that address a server or a transport instead of running a device command. */
export const ADB_MANAGED_FORBIDDEN_COMMANDS = [
  'nodaemon',
  'server',
  'fork-server',
  'kill-server',
  'start-server',
  'connect',
  'disconnect',
  'reconnect',
  'attach',
  'detach',
  'pair',
] as const;

export type AndroidAdbWait =
  `wait-for-${(typeof ADB_WAIT_TRANSPORTS)[number]}${(typeof ADB_WAIT_STATES)[number]}`;

const FORBIDDEN_COMMANDS = new Set<string>(ADB_MANAGED_FORBIDDEN_COMMANDS);

/** adb reads any `wait-for-` prefixed token as a readiness request, including ones it cannot parse. */
function isAndroidAdbWaitToken(token: string): boolean {
  return token.startsWith('wait-for-');
}

function parseAndroidAdbWaitToken(token: string): AndroidAdbWait | undefined {
  if (!isAndroidAdbWaitToken(token)) return undefined;
  const suffix = token.slice('wait-for-'.length);
  return ADB_WAIT_TRANSPORTS.some(
    (transport) =>
      suffix.startsWith(transport) &&
      (ADB_WAIT_STATES as readonly string[]).includes(suffix.slice(transport.length)),
  )
    ? (token as AndroidAdbWait)
    : undefined;
}

function isAndroidAdbManagedForbiddenCommand(token: string): boolean {
  return FORBIDDEN_COMMANDS.has(token);
}

// Transport addressing separated from the device command: which device and which adb server a call
// is for, kept apart from the argv that says what to run on it.

export type AndroidAdbSelector =
  | Readonly<{ kind: 'unspecified' }>
  | Readonly<{ kind: 'serial'; serial: string }>;

export type AndroidAdbServer =
  /** Whatever the ambient environment resolves: `$ANDROID_ADB_SERVER_ADDRESS`/`_PORT`, `-H`, `-L`. */
  Readonly<{ kind: 'ambient' }> | Readonly<{ kind: 'port'; port: number }>;

export type AndroidAdbTarget = Readonly<{
  selector: AndroidAdbSelector;
  server: AndroidAdbServer;
  waitFor?: AndroidAdbWait;
  /** Global options the typed grammar declines to own: `-a -d -e -t ID -H HOST -L SOCKET --…`. */
  hostGlobals?: readonly string[];
}>;

/**
 * Addressing the caller owns, plus the opaque device command. `rawArgv` records the argv an
 * invocation was parsed from so an unchanged, unmanaged invocation is handed to the process
 * verbatim instead of being re-emitted from its parts.
 */
export type AndroidAdbInvocation = Readonly<{
  target: AndroidAdbTarget;
  command: readonly string[];
  rawArgv?: readonly string[];
}>;

export function androidAdbSerialTarget(
  serial: string,
  serverPort?: number,
): Readonly<AndroidAdbTarget> {
  return {
    selector: { kind: 'serial', serial },
    server: serverPort === undefined ? { kind: 'ambient' } : { kind: 'port', port: serverPort },
  };
}

/** Addressing for a server-level command: it selects no device and names no private adb server. */
export function androidAdbHostTarget(): Readonly<AndroidAdbTarget> {
  return { selector: { kind: 'unspecified' }, server: { kind: 'ambient' } };
}

export function androidAdbInvocation(
  target: AndroidAdbTarget,
  command: readonly string[],
  rawArgv?: readonly string[],
): AndroidAdbInvocation {
  return { target, command, ...(rawArgv ? { rawArgv } : {}) };
}

/** Addresses `target` at `serial`, the device an ambient transport was built to answer for. */
export function adoptAndroidAdbSerial(
  target: AndroidAdbTarget,
  serial: string,
): Readonly<AndroidAdbTarget> {
  return { ...target, selector: { kind: 'serial', serial } };
}

/**
 * The only place adb global options are emitted for an invocation whose addressing was rewritten.
 * `command` is appended, never re-parsed.
 */
export function serializeAndroidAdbInvocation(invocation: AndroidAdbInvocation): string[] {
  if (invocation.rawArgv) return [...invocation.rawArgv];
  const { target, command } = invocation;
  const serialized: string[] = [];
  if (target.server.kind === 'port') serialized.push('-P', String(target.server.port));
  if (target.selector.kind === 'serial') serialized.push('-s', target.selector.serial);
  if (target.hostGlobals) serialized.push(...target.hostGlobals);
  if (target.waitFor) serialized.push(target.waitFor);
  serialized.push(...command);
  return serialized;
}

const OWNED_OPTIONS: Readonly<Record<string, 'serial' | 'server'>> = {
  '-s': 'serial',
  '-P': 'server',
};

/** One option token read off the front of an argv, with the argv position it leaves behind. */
type AndroidAdbOptionEffect =
  | { kind: 'stop'; next: number }
  | { kind: 'wait'; waitFor: AndroidAdbWait; next: number }
  | { kind: 'unknown-wait'; token: string; next: number }
  | { kind: 'serial'; serial: string; next: number }
  | { kind: 'server'; port: number; next: number }
  | { kind: 'global'; tokens: readonly string[]; next: number };

/** The addressing read off an argv so far, while the leading options are still being consumed. */
type AndroidAdbAddressingRead = {
  selector: AndroidAdbSelector;
  server: AndroidAdbServer;
  waitFor: AndroidAdbWait | undefined;
  hostGlobals: string[];
};

function readAndroidAdbOption(args: readonly string[], index: number): AndroidAdbOptionEffect {
  const token = args[index]!;
  const wait = parseAndroidAdbWaitToken(token);
  if (wait) return { kind: 'wait', waitFor: wait, next: index + 1 };
  if (isAndroidAdbWaitToken(token)) return { kind: 'unknown-wait', token, next: index + 1 };
  const owned = OWNED_OPTIONS[token];
  if (owned === undefined) {
    if (!token.startsWith('-')) return { kind: 'stop', next: index };
    const arity = ADB_GLOBAL_OPTIONS[token as AndroidAdbGlobalOption] ?? 0;
    return {
      kind: 'global',
      tokens: [token, ...args.slice(index + 1, index + 1 + arity)],
      next: index + 1 + arity,
    };
  }
  const value = args[index + 1] ?? '';
  if (owned === 'serial') return { kind: 'serial', serial: value, next: index + 2 };
  const port = Number(value);
  return Number.isInteger(port)
    ? { kind: 'server', port, next: index + 2 }
    : { kind: 'global', tokens: [token, value], next: index + 2 };
}

function applyAndroidAdbOptionEffect(
  effect: AndroidAdbOptionEffect,
  read: AndroidAdbAddressingRead,
): void {
  if (effect.kind === 'wait') {
    // adb honors each `wait-for` token in turn, so a second one is addressing the grammar will
    // not hold twice. It travels as a host global: verbatim on the ambient route, refused by the
    // managed route rather than answered with one wait dropped.
    if (read.waitFor === undefined) read.waitFor = effect.waitFor;
    else read.hostGlobals.push(effect.waitFor);
  } else if (effect.kind === 'unknown-wait') {
    // adb waits for any `wait-for-` token, including one it cannot parse. The grammar cannot own a
    // wait whose meaning it does not know, so it travels as a global: verbatim on the ambient
    // route, refused by a managed one rather than answered by skipping the wait entirely.
    read.hostGlobals.push(effect.token);
  } else if (effect.kind === 'serial') {
    // adb lets a later `-s` win. The first one is what the routers address by, so a second serial
    // stays an unowned global and keeps its winning position on the way out — unless it names the
    // same device, which asks for nothing the first one did not already say.
    if (read.selector.kind === 'unspecified')
      read.selector = { kind: 'serial', serial: effect.serial };
    else if (read.selector.serial !== effect.serial) read.hostGlobals.push('-s', effect.serial);
  } else if (effect.kind === 'server') read.server = { kind: 'port', port: effect.port };
  else if (effect.kind === 'global') read.hostGlobals.push(...effect.tokens);
}

/**
 * Reads addressing out of a flat argv — the only direction that has to re-slice the payload.
 * Never throws: an unowned or malformed global becomes `hostGlobals` for the policy layer to
 * accept (ambient adb) or refuse (managed transport).
 */
export function parseAndroidAdbArgv(args: readonly string[]): AndroidAdbInvocation {
  const host = androidAdbHostTarget();
  const read: AndroidAdbAddressingRead = {
    selector: host.selector,
    server: host.server,
    waitFor: undefined,
    hostGlobals: [],
  };
  let index = 0;
  for (;;) {
    const effect: AndroidAdbOptionEffect =
      index < args.length ? readAndroidAdbOption(args, index) : { kind: 'stop', next: index };
    if (effect.kind === 'stop') break;
    applyAndroidAdbOptionEffect(effect, read);
    index = effect.next;
  }
  const { selector, server, waitFor, hostGlobals } = read;
  const target: AndroidAdbTarget = {
    selector,
    server,
    ...(waitFor ? { waitFor } : {}),
    ...(hostGlobals.length > 0 ? { hostGlobals } : {}),
  };
  const requestedAddressing =
    hostGlobals.length > 0 ||
    waitFor !== undefined ||
    selector.kind !== 'unspecified' ||
    server.kind === 'port';
  return {
    target,
    // Reading addressing off the front cannot change the device command, so a minted command stays
    // minted through this slice; an argv built outside the funnel stays what it was.
    command: relayDeviceShellArgvWithoutOptions(args, 0, index),
    rawArgv: requestedAddressing ? args : undefined,
  };
}

/**
 * The private-server port a managed transport owns for `invocation`, as opposed to a `-P` the
 * caller typed into argv. Only `applyManagedAndroidAdbServer` output and hand-built targets carry
 * owned addressing; anything still holding `rawArgv` keeps the caller's request in charge.
 */
function androidAdbOwnedServerPort(invocation: AndroidAdbInvocation): number | undefined {
  if (invocation.rawArgv !== undefined) return undefined;
  return invocation.target.server.kind === 'port' ? invocation.target.server.port : undefined;
}

/**
 * Reconciles the two channels an adb server port arrives on: the addressing this layer owns, and
 * the per-call option an SDK caller can still pass. An owned port is not overridable — a caller
 * cannot move a managed lease onto another adb server by naming one.
 */
export function requireAndroidAdbServerPort(
  invocation: AndroidAdbInvocation,
  options?: Pick<AndroidAdbExecutorOptions, 'serverPort'>,
): number | undefined {
  return requireSameAndroidAdbServer(androidAdbOwnedServerPort(invocation), options?.serverPort);
}

/**
 * One adb server per request: whichever layer named a private server first, a second name for it
 * that differs is a caller trying to move the transport elsewhere, not a choice to reconcile.
 */
export function requireSameAndroidAdbServer(
  owned: number | undefined,
  requested: number | undefined,
): number | undefined {
  if (owned !== undefined && requested !== undefined && owned !== requested) {
    throw transportMismatch('server');
  }
  return owned ?? requested;
}

/**
 * The payload a device-scoped provider is asked to run: the caller's argv with this scope's own
 * `-s` pair removed and everything else — readiness tokens, transport globals — left where the
 * caller put it. Answers undefined when the argv addresses no device or another one.
 */
export function androidAdbPayloadWithoutSerial(
  args: readonly string[],
  serial: string,
): readonly string[] | undefined {
  let index = 0;
  for (;;) {
    const effect: AndroidAdbOptionEffect =
      index < args.length ? readAndroidAdbOption(args, index) : { kind: 'stop', next: index };
    if (effect.kind === 'stop') return undefined;
    if (effect.kind === 'serial') {
      // A minted command survives the loss of its own serial pair: the scope adopts that pair as its
      // addressing, which is exactly the removal the device command cannot object to.
      return effect.serial === serial
        ? relayDeviceShellArgvWithoutOptions(args, index, 2)
        : undefined;
    }
    index = effect.next;
  }
}

/** Managed (ADR 0021) transport: the lease owns a private adb server. */
export type AndroidManagedAdbServer = Readonly<{ port: number }>;

/**
 * Adopts `invocation` for one managed adb server. The command travels by reference, so a payload
 * authored upstream is the same array that reaches the spawn boundary. Addressing is rewritten
 * wherever the lease adds something the caller left unsaid, and refused wherever the caller named
 * a server of their own — see {@link requireManagedAndroidAdbAddressing}.
 */
export function applyManagedAndroidAdbServer(
  invocation: AndroidAdbInvocation,
  server: AndroidManagedAdbServer,
): AndroidAdbInvocation {
  const { target, command } = invocation;
  requireManagedAndroidAdbAddressing(target, server.port);
  requireManagedAndroidAdbCommand(command);
  return androidAdbInvocation(
    {
      selector: target.selector,
      server: { kind: 'port', port: server.port },
      ...(target.waitFor ? { waitFor: target.waitFor } : {}),
    },
    command,
  );
}

/** Refuses a device selection that is not `serial`, and adopts an absent one, under a managed device. */
export function requireManagedAndroidAdbSerial(
  target: AndroidAdbTarget,
  serial: string,
): Readonly<AndroidAdbTarget> {
  requireUnconflictedAndroidAdbSelector(target.selector, serial);
  return { ...target, selector: { kind: 'serial', serial } };
}

/** A selection naming another device is a conflict; a request that names none is not. */
export function requireUnconflictedAndroidAdbSelector(
  selector: AndroidAdbSelector,
  serial: string,
): void {
  if (selector.kind === 'serial' && selector.serial !== serial) throw transportMismatch('device');
}

/**
 * What a managed transport may be addressed by: no target globals it cannot restate, and no adb
 * server but the one it holds.
 *
 * A `-P` naming a different server is refused here, before anything is dispatched, rather than
 * rewritten onto the lease's server. A caller who asked for 5037 and got 15038 would otherwise
 * read a successful exit as evidence about 5037, which is the one answer a private server must not
 * give. A `-P` naming this server, or none at all, is the ordinary case.
 */
export function requireManagedAndroidAdbAddressing(
  target: AndroidAdbTarget,
  managedPort: number,
): void {
  if (target.hostGlobals) throw transportMismatch('target');
  requireSameAndroidAdbServer(
    managedPort,
    target.server.kind === 'port' ? target.server.port : undefined,
  );
}

/**
 * Server and transport lifecycle never belong to a device-scoped invocation. adb reads readiness
 * tokens ahead of the real command, so the guard answers for the first token that is not one.
 */
export function requireManagedAndroidAdbCommand(command: readonly string[]): void {
  const head = command.find((token) => !isAndroidAdbWaitToken(token)) ?? '';
  if (isAndroidAdbManagedForbiddenCommand(head)) throw transportMismatch('target');
}

/** What a managed transport refuses to be pointed at: another device, target, or adb server. */
const TRANSPORT_MISMATCH_MESSAGES = {
  device: 'Managed ADB transport cannot address another device.',
  target: 'Managed ADB transport cannot select another target.',
  server: 'Managed ADB transport cannot select another server.',
} as const;

function transportMismatch(scope: keyof typeof TRANSPORT_MISMATCH_MESSAGES): never {
  throw new AppError('COMMAND_FAILED', TRANSPORT_MISMATCH_MESSAGES[scope], {
    reason: 'managed-device-transport-mismatch',
  });
}

/** The per-call option an adb server port can arrive on, and nothing else. */
type AndroidAdbServerOption = {
  serverPort?: number;
  env?: Record<string, string | undefined>;
};

/**
 * The flat argv and process options one adb request runs with: the server this layer owns, the
 * environment that server implies, and the caller's own options with the port channel removed.
 * Whoever spawns the process decides `detached`, because that is a question about the process.
 */
export function lowerAndroidAdbInvocation<Options extends AndroidAdbServerOption>(
  invocation: AndroidAdbInvocation,
  options: Options | undefined,
  environment: Record<string, string | undefined>,
): { args: string[]; options: Omit<Options, 'serverPort'> } {
  const { serverPort: _requestedServerPort, ...execOptions } = options ?? ({} as Options);
  const port = requireAndroidAdbServerPort(invocation, options);
  const resolved =
    port === undefined ? invocation : applyManagedAndroidAdbServer(invocation, { port });
  const env =
    port === undefined
      ? undefined
      : androidManagedAdbEnvironment(resolved.target, environment, execOptions.env);
  return {
    args: serializeAndroidAdbInvocation(resolved),
    options: { ...execOptions, ...(env === undefined ? {} : { env }) },
  };
}

/** Process environment lowering for a private adb server; ambient invocations change nothing. */
export function androidManagedAdbEnvironment(
  target: AndroidAdbTarget,
  environment: Record<string, string | undefined>,
  base?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  if (target.server.kind === 'port') {
    return {
      ...environment,
      ...(base ?? {}),
      ADB_SERVER_SOCKET: undefined,
      ANDROID_ADB_SERVER_PORT: String(target.server.port),
      ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1',
    };
  }
  return base;
}
