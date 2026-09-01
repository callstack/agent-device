import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RunnerLogicalLeaseContext } from './runner-lease-context.ts';
import type { SessionSurface } from './session-surface.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { ProviderPortReverseOptions } from './provider-device-runtime.ts';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';

/**
 * A deliberately neutral runtime-hint payload. Daemon policy owns parsing and
 * persistence; a platform implementation owns how its native runtime consumes
 * these key/value entries.
 */
export type RuntimeHintValues = Readonly<Record<string, string>>;

/**
 * The hint keys that name a JavaScript bundle transport, as opposed to a one-shot navigation
 * (`launchUrl`). Only these require a native write on open and a native removal on close, so the
 * set lives here once rather than being re-listed by each caller that gates on it.
 */
const RUNTIME_TRANSPORT_HINT_KEYS = ['metroHost', 'metroPort', 'bundleUrl'] as const;

/** True when applying these hints has a native effect a platform must later undo. */
export function hasRuntimeTransportHintValues(values: RuntimeHintValues): boolean {
  return RUNTIME_TRANSPORT_HINT_KEYS.some((key) => values[key] !== undefined);
}

/** Request-scoped runner/diagnostic context, without daemon request types. */
export type ApplicationLifecycleExecution = Readonly<{
  requestId?: string;
  logPath?: string;
  traceLogPath?: string;
  verbose?: boolean;
  activity?: string;
  launchConsole?: string;
  launchArgs?: readonly string[];
  clearAppState?: boolean;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
  runnerLeaseContext?: RunnerLogicalLeaseContext;
}>;

/** Semantic target resolution used before an application open. */
export type OpenTargetResolutionInput = Readonly<{
  target?: string;
  currentAppBundleId?: string;
  surface: SessionSurface;
  /** `open --foreground` asks the admitted Apple binding to inspect its exact target. */
  foreground?: boolean;
}>;

export type OpenTargetResolution = Readonly<{
  appBundleId?: string;
  appName?: string;
}>;

/** Native work that must occur before the visible open dispatch. */
export type OpenApplicationPreparationInput = Readonly<{
  target?: string;
  currentAppBundleId?: string;
  hasExistingSession: boolean;
  surface: SessionSurface;
  deviceHub: boolean;
  prewarmRunnerOnColdBoot: boolean;
  execution: ApplicationLifecycleExecution;
}>;

/** The normalized public application launch, independent of daemon request shape. */
export type OpenApplicationInput = Readonly<{
  target?: string;
  positionals: readonly string[];
  outPath?: string;
  runtimeLaunchUrl?: string;
  appBundleId?: string;
  surface: SessionSurface;
  hasExistingSession: boolean;
  relaunch: boolean;
  prewarmRunnerBeforeOpen: boolean;
  enableTestIme: boolean;
  stateDir: string;
  runtimeHints: RuntimeHintValues;
  /**
   * The fact-admitted runtime-hint operation for this open. It is optional only when no
   * transport hint is requested; `openApplication` never imports or falls back to a sibling
   * implementation behind a false runtime-hints fact.
   */
  applyRuntimeHints?: (input: RuntimeHintsApplicationInput) => Promise<void>;
  execution: ApplicationLifecycleExecution;
}>;

export type OpenApplicationTiming = Readonly<{
  relaunchCloseDurationMs?: number;
  runtimeHintsDurationMs?: number;
  runnerPrewarmKind?: 'session' | 'xctestrun';
  runnerPrewarmScheduled?: boolean;
  runnerPrewarmWaited?: boolean;
  runnerPrewarmDurationMs?: number;
  openDispatchDurationMs?: number;
  launchUrlDurationMs?: number;
  postOpenSettleDurationMs?: number;
}>;

export type OpenApplicationOutcome = Readonly<{
  appBundleId?: string;
  timing: OpenApplicationTiming;
}>;

/** Applies or clears a platform's native representation of neutral runtime hints. */
export type RuntimeHintsApplicationInput = Readonly<{
  appId?: string;
  values: RuntimeHintValues;
}>;

/** Native close dispatch; target omission means the platform's session-level close semantics. */
export type CloseApplicationInput = Readonly<{
  positionals: readonly string[];
  outPath?: string;
  appBundleId?: string;
  surface: SessionSurface;
  /** A selector-only close establishes readiness inside its admitted lifecycle binding. */
  ensureReady?: boolean;
  execution: ApplicationLifecycleExecution;
}>;

/** Post-resource close work owned by the selected platform runtime. */
export type CloseApplicationFinalizationInput = Readonly<{
  appBundleId?: string;
  surface: SessionSurface;
  retainRunner: boolean;
  stateDir: string;
  /** Daemon shutdown defers runner termination to the gateway's single final phase. */
  daemonShutdown?: boolean;
  /** `close --shutdown` is an admitted close finalization effect, never a daemon fallback. */
  shutdownTarget?: boolean;
}>;

export type CloseApplicationFinalizationResult = Readonly<{
  shutdown?: TargetShutdownResult;
}>;

export type PrepareAppleRunnerInput = Readonly<{
  timeoutMs: number;
  execution: ApplicationLifecycleExecution;
}>;

export type PrepareAppleRunnerResult = Readonly<{
  runner: Record<string, unknown>;
  cache?: string;
  artifact?: string;
  buildMs?: number;
  connectMs: number;
  healthCheckMs: number;
  xctestrunPath?: string;
  recoveryReason?: string;
  failureReason?: string;
}>;

/** Controls whether an opportunistic runner session prewarm also proves readiness. */
export type AppleRunnerSessionPrewarmOptions = Readonly<{
  healthCheck?: boolean;
}>;

/** Individual semantic operations exposed by the application lifecycle runtime facet. */
export type ApplicationLifecycleRuntimeOperations = Readonly<{
  resolveOpenTarget(input: OpenTargetResolutionInput): Promise<OpenTargetResolution>;
  prepareApplicationOpen(input: OpenApplicationPreparationInput): Promise<void>;
  openApplication(input: OpenApplicationInput): Promise<OpenApplicationOutcome>;
  applyRuntimeHints(input: RuntimeHintsApplicationInput): Promise<void>;
  clearRuntimeHints(input: RuntimeHintsApplicationInput): Promise<void>;
  closeApplication(input: CloseApplicationInput): Promise<void>;
  finalizeApplicationClose(
    input: CloseApplicationFinalizationInput,
  ): Promise<CloseApplicationFinalizationResult | void>;
  prepareAppleRunner(input: PrepareAppleRunnerInput): Promise<PrepareAppleRunnerResult>;
  /** Exact provider-owned port reverse; local owners publish an unavailable fact. */
  configureProviderPortReverse(
    input: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined>;
}>;

/**
 * Exact provider dispatch captured when a lifecycle binding is admitted. It deliberately does
 * not consult request-scoped provider state: a later operation either uses this owner-selected
 * interactor or fails closed before any local platform implementation can be reached.
 */
export type ApplicationLifecycleProviderInteractorResolver = (
  runner: RunnerContext,
) => Interactor | undefined;

/**
 * The full lifecycle-operation denominator, expressed once so every local and provider runtime
 * must deliberately classify every command-facing operation. Facts describe canonical operations,
 * never a shared lifecycle family: an owner may implement several operations together, but it
 * cannot make one operation available by borrowing another operation's fact.
 */
export type ApplicationLifecycleOperationFacts = Readonly<{
  [Key in keyof ApplicationLifecycleRuntimeOperations]: RuntimeOperationFact;
}>;

const applicationLifecycleOperationKeys = [
  'resolveOpenTarget',
  'prepareApplicationOpen',
  'openApplication',
  'applyRuntimeHints',
  'clearRuntimeHints',
  'closeApplication',
  'finalizeApplicationClose',
  'prepareAppleRunner',
  'configureProviderPortReverse',
] as const satisfies readonly (keyof ApplicationLifecycleRuntimeOperations)[];

export function applicationLifecycleOperationFacts(
  facts: ApplicationLifecycleOperationFacts,
): ApplicationLifecycleOperationFacts {
  return Object.freeze({
    resolveOpenTarget: facts.resolveOpenTarget,
    prepareApplicationOpen: facts.prepareApplicationOpen,
    openApplication: facts.openApplication,
    applyRuntimeHints: facts.applyRuntimeHints,
    clearRuntimeHints: facts.clearRuntimeHints,
    closeApplication: facts.closeApplication,
    finalizeApplicationClose: facts.finalizeApplicationClose,
    prepareAppleRunner: facts.prepareAppleRunner,
    configureProviderPortReverse: facts.configureProviderPortReverse,
  });
}

/**
 * A runtime owner may share one lifecycle implementation across cells, but its binding exposes
 * only operations admitted by that exact cell's facts. This prevents an unavailable leaf from
 * carrying a callable sibling operation behind a stale or bypassed handler projection.
 */
export function availableApplicationLifecycleOperations(
  operations: ApplicationLifecycleRuntimeOperations,
  facts: ApplicationLifecycleOperationFacts,
): Partial<ApplicationLifecycleRuntimeOperations> {
  return Object.freeze(
    Object.fromEntries(
      applicationLifecycleOperationKeys.flatMap((key) =>
        facts[key].available ? [[key, operations[key]]] : [],
      ),
    ),
  ) as Partial<ApplicationLifecycleRuntimeOperations>;
}

/** Local interactor construction stays a narrow host tool, never a lifecycle dispatcher. */
export type LocalApplicationInteractorHost = Readonly<{
  resolve(device: DeviceInfo, runner: RunnerContext): Promise<Interactor>;
}>;

/** Lazy Apple mechanics used by the Apple package's own lifecycle binding. */
export type AppleApplicationTools = Readonly<{
  resolveOpenTarget(
    device: DeviceInfo,
    input: OpenTargetResolutionInput,
  ): Promise<OpenTargetResolution>;
  prewarmRunnerCache(
    device: DeviceInfo,
    execution: ApplicationLifecycleExecution,
    signal: AbortSignal,
  ): Promise<void>;
  prewarmRunnerSession(
    device: DeviceInfo,
    execution: ApplicationLifecycleExecution,
    signal: AbortSignal,
    propagateError: boolean,
    options?: AppleRunnerSessionPrewarmOptions,
  ): Promise<void>;
  notifyRunnerAppRelaunched(
    device: DeviceInfo,
    execution: ApplicationLifecycleExecution,
    signal: AbortSignal,
  ): Promise<void>;
  stopRunnerSession(deviceId: string): Promise<void>;
  scheduleRunnerIdleStop(deviceId: string): void;
  prepareRunner(
    device: DeviceInfo,
    input: PrepareAppleRunnerInput,
    signal: AbortSignal,
  ): Promise<PrepareAppleRunnerResult>;
  applyRuntimeHints(device: DeviceInfo, input: RuntimeHintsApplicationInput): Promise<void>;
  clearRuntimeHints(device: DeviceInfo, input: RuntimeHintsApplicationInput): Promise<void>;
  dismissCloseAlerts(device: DeviceInfo, input: CloseApplicationFinalizationInput): Promise<void>;
  detachRunnerSessionsForShutdown(): Promise<void>;
  finalizeRunnerSessionsForShutdown(): Promise<void>;
}>;

/** Lazy Android mechanics used by the Android package's own lifecycle binding. */
export type AndroidApplicationTools = Readonly<{
  resolveOpenTarget(
    device: DeviceInfo,
    input: OpenTargetResolutionInput,
  ): Promise<OpenTargetResolution>;
  inferOpenedAppBundleId(
    device: DeviceInfo,
    target: string | undefined,
    currentAppBundleId: string | undefined,
  ): Promise<string | undefined>;
  resetFramePerfStats(device: DeviceInfo, appBundleId: string): Promise<void>;
  applyRuntimeHints(device: DeviceInfo, input: RuntimeHintsApplicationInput): Promise<void>;
  clearRuntimeHints(device: DeviceInfo, input: RuntimeHintsApplicationInput): Promise<void>;
  activateTestIme(device: DeviceInfo, input: Readonly<{ stateDir: string }>): Promise<void>;
  restoreTestIme(device: DeviceInfo, input: Readonly<{ stateDir: string }>): Promise<void>;
  recoverTestImeStartup(input: Readonly<{ stateDir: string }>): Promise<void>;
  hasTestImeRecoveryEvidence(stateDir: string): Promise<boolean>;
}>;

/** Gateway-coordinated durable phases whose concrete mechanics stay package-owned. */
export type ApplicationLifecycleResourceLifecycle = Readonly<{
  recoverStartupResources(input: Readonly<{ stateDir: string }>): Promise<void>;
  detachForDaemonShutdown(): Promise<void>;
  finalizeDaemonShutdown(): Promise<void>;
}>;
