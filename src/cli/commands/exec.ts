import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliFlags } from '@agent-device/contracts/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import {
  acquireWrapperDeviceClaim,
  clearDeviceClaim,
  type DeviceClaimClearOutcome,
  type DeviceClaimSessionOwnership,
} from '@agent-device/daemon-contracts/device-claims';
import { deviceClaimConflictError } from '@agent-device/daemon-contracts/device-claim-conflict';
import { createRecoveryPlatformScope } from '@agent-device/daemon-contracts/device-claim-recovery';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { runCmdBackground } from '@agent-device/host-kit/command';
import { signalProcessGroupBestEffort } from '@agent-device/host-kit/process';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import {
  hasDeviceInventoryContext,
  withDeviceInventoryContext,
} from '@agent-device/device-selection/device-inventory-context';

const EXEC_CLAIM_STATE_DIR_NAME = 'exec';

export type ExecCommandOptions = Readonly<{
  /** Parsed CLI flags; the device selectors (`--platform`, `--udid`, ...) select the claimed device. */
  flags: CliFlags;
  /** The CLI's resolved daemon state dir; the wrapper's claim lives under it. */
  stateDir: string;
  /** The host captured at the CLI entry point; it locates the claim store and the workspace. */
  host: HostEnvironment;
}>;

/**
 * `exec` (#3263): holds the host-global device claim for the lifetime of one
 * external command, so a build system that installs and launches through the
 * platform tools directly (`expo run:ios --device <UDID>`, `xcodebuild`,
 * `adb install`) is fenced against agent-device sessions on the same device.
 *
 * The claim is taken on this CLI process's own identity, never through daemon
 * admission: a build can outlast any request envelope, and a claim owned by the
 * wrapper dies with the wrapper, where the existing owner-liveness proofs
 * reconcile it as stale. The child's exit code is the command's exit code.
 */
export async function runExecCommand(
  positionals: readonly string[],
  options: ExecCommandOptions,
): Promise<number> {
  const [command, ...args] = positionals;
  if (!command) {
    throw new AppError(
      'INVALID_ARGS',
      'exec requires a command after `--`, e.g. agent-device exec --platform ios --udid <UDID> -- expo run:ios --device <UDID>.',
    );
  }
  // Signal forwarding reaches the child's process group, which Windows does
  // not model, and claims are host-global over the local devices of POSIX
  // hosts only. Refuse the whole command up front rather than run a wrapper
  // whose fence a stuck build could silently outlive.
  if (process.platform === 'win32') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      'exec holds and forwards POSIX process-group signals and supports macOS and Linux hosts only.',
      {
        reason: 'unsupported-host-platform',
        hostPlatform: process.platform,
      },
    );
  }
  const termination = attachSignalForwarding();
  try {
    const device = await resolveExecDevice(options.flags, options.host);
    if (termination.signal) return signalExitCode(termination.signal);
    const ownership = await acquireExecDeviceClaim(device, command, options);
    try {
      if (termination.signal) return signalExitCode(termination.signal);
      return await runClaimedChild(command, args, termination, options.host);
    } catch (error) {
      // A command missing from PATH is the child failing to start; shells report
      // that as 127, and `exec` promises the command's exit code.
      if (error instanceof AppError && error.code === 'TOOL_MISSING') {
        process.stderr.write(`agent-device exec: ${error.message}\n`);
        return 127;
      }
      throw error;
    } finally {
      await releaseExecDeviceClaim(ownership, options.host);
    }
  } finally {
    termination.dispose();
  }
}

async function resolveExecDevice(flags: CliFlags, host: HostEnvironment): Promise<DeviceInfo> {
  if (hasDeviceInventoryContext()) return await resolveTargetDevice(flags);
  // Claims exist only for local devices, so the wrapper composes the local
  // inventory itself; a scope installed by a host (a test or embedding caller)
  // is reused as-is. Platform modules are named by the gateway composition, so
  // it is imported only on this path.
  const { createPlatformDeviceInventoryGateways } = await import('../../platform-runtime.ts');
  const gateways = await createPlatformDeviceInventoryGateways(host);
  return await withDeviceInventoryContext(
    { ...gateways, requestScope: createRecoveryPlatformScope() },
    async () => await resolveTargetDevice(flags),
  );
}

async function acquireExecDeviceClaim(
  device: DeviceInfo,
  command: string,
  options: ExecCommandOptions,
): Promise<DeviceClaimSessionOwnership> {
  // Exact-owner reconciliation of a stale claim composes the dead owner's
  // recovery gateway, which names platform modules; import it lazily so the
  // common claim-free path stays as light as `device release --stale` keeps it.
  const { createOwnerScopedDeviceClaimReconciler } =
    await import('@agent-device/daemon-contracts/device-claim-recovery');
  const { createClaimRecoveryGatewayFor } =
    await import('../../platform-runtime-claim-recovery.ts');
  const result = await acquireWrapperDeviceClaim({
    device,
    command,
    workspace: options.host.cwd,
    stateDir: prepareExecClaimStateDir(options.stateDir),
    env: options.host.env,
    reconcileOrphanedDeviceClaim: createOwnerScopedDeviceClaimReconciler({
      scope: createRecoveryPlatformScope(),
      composeGateway: createClaimRecoveryGatewayFor(options.host),
    }),
  });
  if (result.status === 'conflict') throw deviceClaimConflictError(device, result.conflict);
  return result.ownership;
}

/**
 * The wrapper's claims are recorded under a state dir of their own: a
 * `daemon.json` published for the ordinary state dir proves what a DAEMON can
 * be reached through, and proving that about a wrapper would misread its live
 * claim as unreachable and hand the device to the next acquirer.
 */
function prepareExecClaimStateDir(stateDir: string): string {
  const execStateDir = path.join(resolveDaemonPaths(stateDir).baseDir, EXEC_CLAIM_STATE_DIR_NAME);
  fs.mkdirSync(execStateDir, { recursive: true, mode: 0o700 });
  return execStateDir;
}

async function runClaimedChild(
  command: string,
  args: readonly string[],
  termination: SignalForwarding,
  host: HostEnvironment,
): Promise<number> {
  // A build tool named with a path (`./gradlew`, `./scripts/build.sh`) is how the
  // fence is used day to day; resolve it against the cwd the way a shell would,
  // because the spawn helper keeps bare PATH names and absolute paths only.
  const executable =
    !path.isAbsolute(command) && command.includes('/') ? path.resolve(host.cwd, command) : command;
  // The child leads its own process group so a forwarded signal reaches the
  // build tools it spawns — the grandchildren the fence exists to cover — not
  // just its direct process.
  const child = runCmdBackground(executable, args, {
    cwd: host.cwd,
    env: host.env,
    stdio: 'inherit',
    captureOutput: false,
    allowFailure: true,
    detached: true,
  });
  let exitSignal: NodeJS.Signals | null = null;
  child.child.once('exit', (_code, signal) => {
    exitSignal = signal;
  });
  termination.attach(child.child);
  const result = await child.wait;
  if (termination.signal) return signalExitCode(termination.signal);
  if (exitSignal) return signalExitCode(exitSignal);
  return result.exitCode;
}

type SignalForwarding = Readonly<{
  /** Forwards to the child's process group once it exists; signals received earlier are replayed at attach. */
  attach(child: { pid?: number }): void;
  readonly signal: NodeJS.Signals | null;
  dispose(): void;
}>;

// Every terminating signal the wrapper can catch. The child leads its own
// session, so terminal-generated signals reach only the wrapper: forwarding
// them all is what keeps the claim and the build dying together. SIGHUP is the
// closed terminal or dropped SSH connection, SIGQUIT the Ctrl-\; without a
// handler either one would take the wrapper down before the release, leaving a
// dead owner's claim while the build keeps mutating the device. SIGTSTP is
// deliberately absent: stopping the wrapper with the child left running is the
// shell's own semantics, and job control here would need a controlling
// terminal the detached child does not share.
export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

function attachSignalForwarding(): SignalForwarding {
  let first: NodeJS.Signals | null = null;
  let child: { pid?: number } | undefined;
  const received: NodeJS.Signals[] = [];
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const name of FORWARDED_SIGNALS) {
    const handler = () => {
      // The first signal owns the exit code; every received signal still reaches
      // the group, so a child that traps or ignores one stays stoppable by the
      // next, and the wrapper always lives to await the child and release.
      if (!first) first = name;
      received.push(name);
      if (child?.pid !== undefined) signalProcessGroupBestEffort(child.pid, name);
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }
  return {
    attach(next) {
      child = next;
      if (next.pid !== undefined) {
        for (const name of received) signalProcessGroupBestEffort(next.pid, name);
      }
    },
    get signal() {
      return first;
    },
    dispose() {
      for (const [name, handler] of handlers) process.off(name, handler);
    },
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  const signum = os.constants.signals[signal];
  return 128 + (signum ?? 0);
}

async function releaseExecDeviceClaim(
  ownership: DeviceClaimSessionOwnership,
  host: HostEnvironment,
): Promise<void> {
  let outcome: DeviceClaimClearOutcome;
  try {
    outcome = await clearDeviceClaim(ownership, host.env);
  } catch (error) {
    process.stderr.write(
      `agent-device exec: could not release the device claim: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return;
  }
  // The wrapper is about to exit, so a claim left behind names a process that is
  // gone and every acquirer reconciles it as stale. Report it; never mask the
  // child's exit code with it.
  if (outcome === 'unattributable') {
    process.stderr.write(
      'agent-device exec: the device claim could not be attributed on release; ' +
        'it becomes reclaimable as stale when this process exits.\n',
    );
  }
}
