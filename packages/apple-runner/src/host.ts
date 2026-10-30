import type * as HostCommand from '@agent-device/host-kit/command';
import type * as HostDiagnostics from '@agent-device/host-kit/diagnostics';
import type * as HostFile from '@agent-device/host-kit/file';
import type * as HostProcess from '@agent-device/host-kit/process';
import type * as HostRequest from '@agent-device/host-kit/request';
import type * as HostRetry from '@agent-device/host-kit/retry';
import type * as HostRuntimeSlots from '@agent-device/host-kit/runtime-slots';
import type * as HostVersion from '@agent-device/host-kit/version';
import type * as KernelDeviceShell from '@agent-device/kernel/device-shell';
import type * as KernelKeyedLock from '@agent-device/kernel/keyed-lock';
import type * as KernelRecord from '@agent-device/kernel/record';
import type * as KernelSourceValue from '@agent-device/kernel/source-value';
import type * as BootDiagnostics from '@agent-device/provision-kit/boot-diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ScopedSimctlCommand } from '@agent-device/contracts/platform-runtime-host';
import type { IosPhysicalDeviceRunnerControl } from './runner-physical-device.ts';

/**
 * Daemon-owned device-claim arbitration probe: does the embedding process hold
 * the host-global local device claim for exactly this device right now? The
 * probe receives the full device so the claim owner can match its canonical
 * platform-family/OS/id key — a bare id is ambiguous across families. Unbound
 * (in embedders that run no claim store, such as package tests) it answers
 * false, which keeps runner-lease takeover disabled there.
 */
export type RunnerDeviceClaimAuthorityProbe = (device: DeviceInfo) => boolean;

/**
 * The Apple foreground tooling the runner consumes, declared by the runner as the narrow slice it
 * calls. The embedder's `appleRunnerHost: AppleRunnerHost` assignment in `platform-apple`
 * (`core/runner-host.ts`) is the compile-checked drift boundary: a tool-provider or simctl signature
 * that stops satisfying a member fails there.
 */
type AppleRunnerToolPort = {
  runAppleToolCommand: (
    cmd: string,
    args: string[],
    options?: HostCommand.ExecOptions,
  ) => Promise<HostCommand.ExecResult>;
  /** Runs one scoped simctl argv; the runner has no other xcrun tool to run. */
  runXcrun: (
    args: ScopedSimctlCommand,
    options?: HostCommand.ExecOptions,
  ) => Promise<HostCommand.ExecResult>;
  readApplePlistJson: (
    plistPath: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown> | null>;
  hasScopedAppleToolProvider: () => boolean;
  buildSimctlArgsForDevice: (device: DeviceInfo, args: readonly string[]) => ScopedSimctlCommand;
  /** A simulator udid with the simulator set that holds it; two devices match only when both do. */
  simulatorAddressFor: (
    device: DeviceInfo,
  ) => Readonly<{ udid: string; simulatorSetPath: string | undefined }>;
};

/**
 * The host-capability port for the Apple runner client. Every effectful or
 * shared-single-source capability the runner needs from its embedding process
 * enters through this object: process execution, diagnostics, retry, process
 * probes, locks, Apple foreground tooling, and physical-device control. The
 * package never imports platform-apple or root implementation files; the
 * composition root (`packages/platform-apple/src/core/runner-client.ts`) binds
 * the real implementations exactly once per process.
 *
 * Host-kit and kernel capabilities are DERIVED from the modules they front, never re-typed: the
 * `Pick` lists below are the one place that says which symbol of which module the runner may
 * reach, and every signature comes from the owning module. A host-kit signature change reaches the
 * runner with no edit here; a new capability costs one name in the matching `Pick`, one
 * `delegate` line, and its binding in `platform-apple`'s `core/runner-host.ts`. The Apple-owned
 * capabilities are the runner's own narrow signatures, checked where the host is bound.
 *
 * A host-kit symbol the runner needs is added HERE -- never imported directly from a runner
 * module. The reason:
 * `packages/apple-runner/src/` sits in the eager import closure of the Apple facade entries
 * (`app-lifecycle-facade.ts`, `doctor-facade.ts`, `runner-operations-facade.ts`, and the package
 * entry itself) that `scripts/__tests__/eager-closure-budgets.ts` holds at a fixed size (no
 * growth against the merge-base); a static `@agent-device/host-kit/*` value import from a runner
 * module adds every module on its own import path to all of those closures at once (#2423
 * measured one candidate import adding 5 modules to a runner closure).
 * `scripts/layering/` enforces the port at the import-graph
 * level (R77 apple-runner-host-port): a runner file may hold a type-only
 * `@agent-device/host-kit/*` import, which evaluates nothing, but never a value one -- the
 * `import type * as` declarations above are exactly that, and so are the type imports the runner
 * modules take straight from the owning package. A pure constant that both the runner and another
 * package need is not a host-kit exception to this -- it belongs in a runner module already inside
 * every facade closure (e.g. `apple-runner-platform.ts`), imported directly from there.
 */
export type AppleRunnerHost = Pick<
  typeof HostCommand,
  | 'runCmdStreaming'
  | 'runCmdBackground'
  | 'requireExecSuccess'
  | 'isCommandTimeoutError'
  | 'commandDeveloperDir'
> &
  Pick<typeof HostDiagnostics, 'emitDiagnostic' | 'withDiagnosticTimer'> &
  Pick<typeof HostRetry, 'retryWithPolicy' | 'isEnvTruthy'> &
  Pick<
    typeof HostProcess,
    | 'isProcessAlive'
    | 'isProcessGroupAlive'
    | 'readProcessStartTime'
    | 'readProcessCommand'
    | 'signalPidsBestEffort'
    | 'signalProcessGroupBestEffort'
    | 'classifyOwnerLiveness'
    | 'readHostCpuArchSync'
  > &
  Pick<typeof HostVersion, 'findProjectRoot' | 'readVersion'> &
  Pick<typeof HostFile, 'acquireProcessLock' | 'withProcessLock' | 'publishFileSync'> &
  Pick<typeof HostRequest, 'emitRequestProgress' | 'getRequestSignal' | 'isRequestCanceled'> &
  Pick<typeof KernelKeyedLock, 'withKeyedLock'> &
  Pick<typeof KernelRecord, 'isRecord'> &
  Pick<typeof KernelSourceValue, 'parseBooleanLiteral'> &
  Pick<typeof KernelDeviceShell, 'shellQuote'> &
  Pick<typeof BootDiagnostics, 'classifyBootFailure' | 'bootFailureHint'> &
  AppleRunnerToolPort & {
    /**
     * The environment and working directory the runner reads its configuration from (derived-data
     * overrides, lease directory, bundle ids, signing settings) and starts detached children with.
     */
    hostEnvironment: typeof HostCommand.commandHostEnvironment;
    /**
     * The `Deadline` constructor is a class static, so the port carries the factory alone, typed
     * to the read side: a test host substitutes its own clock.
     */
    deadlineFromTimeoutMs: (
      ...args: Parameters<typeof HostRetry.Deadline.fromTimeoutMs>
    ) => HostRetry.DeadlineClock;
    resolveIosPhysicalDeviceControl: (device: DeviceInfo) => IosPhysicalDeviceRunnerControl;
    /** Daemon-owned lease owner state directory. */
    leaseOwnerStateDir: () => string | undefined;
    /**
     * One registry the current runtime owns (sessions, locks, ledgers), created on first use.
     * Fronts host-kit's one runtime slot store, so the runner declares keys and never a store.
     */
    runnerRuntimeSlot: typeof HostRuntimeSlots.runtimeSlot;
    /**
     * Daemon-owned device-claim arbitration probe: true only while the embedding process holds
     * the host-global local device claim for exactly this device (matched by canonical
     * family/OS/id, never a bare id). Embedders without a claim store answer false.
     */
    hasDeviceClaimAuthority: RunnerDeviceClaimAuthorityProbe;
  };

/** The runner's deadline type is the host's read side; the {@link Deadline} shim below builds them. */
export type Deadline = HostRetry.DeadlineClock;

let boundHost: AppleRunnerHost | undefined;

/**
 * Binds the process-wide host. Called by the composition root; binding a
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
      'Apple runner host is not bound. Production binds it in core/runner-client.ts; package tests bind it through test-host.ts.',
    );
  }
  return boundHost;
}

/**
 * Delegators keep the owning module's export name so runner modules only swap
 * import specifiers; every call resolves the bound host lazily.
 */
function delegate<Name extends keyof AppleRunnerHost>(name: Name): AppleRunnerHost[Name] {
  return ((...args: unknown[]) =>
    (requireHost()[name] as (...callArgs: unknown[]) => unknown)(...args)) as AppleRunnerHost[Name];
}

export const runCmdStreaming = delegate('runCmdStreaming');
export const runCmdBackground = delegate('runCmdBackground');
export const requireExecSuccess = delegate('requireExecSuccess');
export const isCommandTimeoutError = delegate('isCommandTimeoutError');
export const commandDeveloperDir = delegate('commandDeveloperDir');
export const hostEnvironment = delegate('hostEnvironment');
export const shellQuote = delegate('shellQuote');
export const emitDiagnostic = delegate('emitDiagnostic');
export const withDiagnosticTimer = delegate('withDiagnosticTimer');
export const retryWithPolicy = delegate('retryWithPolicy');
export const isEnvTruthy = delegate('isEnvTruthy');
export const isProcessAlive = delegate('isProcessAlive');
export const isProcessGroupAlive = delegate('isProcessGroupAlive');
export const readProcessStartTime = delegate('readProcessStartTime');
export const readProcessCommand = delegate('readProcessCommand');
export const signalPidsBestEffort = delegate('signalPidsBestEffort');
export const signalProcessGroupBestEffort = delegate('signalProcessGroupBestEffort');
export const classifyOwnerLiveness = delegate('classifyOwnerLiveness');
export const readHostCpuArchSync = delegate('readHostCpuArchSync');
export const findProjectRoot = delegate('findProjectRoot');
export const readVersion = delegate('readVersion');
export const runnerRuntimeSlot = delegate('runnerRuntimeSlot');
export const acquireProcessLock = delegate('acquireProcessLock');
export const withProcessLock = delegate('withProcessLock');
export const publishFileSync = delegate('publishFileSync');
export const emitRequestProgress = delegate('emitRequestProgress');
export const getRequestSignal = delegate('getRequestSignal');
export const isRequestCanceled = delegate('isRequestCanceled');
export const withKeyedLock = delegate('withKeyedLock');
export const isRecord = delegate('isRecord');
export const parseBooleanLiteral = delegate('parseBooleanLiteral');
export const classifyBootFailure = delegate('classifyBootFailure');
export const bootFailureHint = delegate('bootFailureHint');
export const runAppleToolCommand = delegate('runAppleToolCommand');
export const runXcrun = delegate('runXcrun');
export const readApplePlistJson = delegate('readApplePlistJson');
export const hasScopedAppleToolProvider = delegate('hasScopedAppleToolProvider');
export const buildSimctlArgsForDevice = delegate('buildSimctlArgsForDevice');
export const simulatorAddressFor = delegate('simulatorAddressFor');
export const resolveIosPhysicalDeviceControl = delegate('resolveIosPhysicalDeviceControl');
export const leaseOwnerStateDir = delegate('leaseOwnerStateDir');
export const hasDeviceClaimAuthority = delegate('hasDeviceClaimAuthority');

/**
 * Deadline keeps its root call-site shape (`Deadline.fromTimeoutMs(...)`);
 * instances come from the host so package and root share one clock model.
 */
export const Deadline = {
  fromTimeoutMs: delegate('deadlineFromTimeoutMs'),
};
