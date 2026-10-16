import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@agent-device/kernel/errors';
import { isCommandTimeoutError, type ExecResult } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { listHostProcesses } from '@agent-device/host-kit/process';
import { Deadline } from '@agent-device/host-kit/retry';
import type { AppleToolCommandExecutor } from '../../core/tool-provider-types.ts';

const LAUNCH_SERVICES_POLL_MS = 200;
const LAUNCH_SERVICES_MAX_POLLS = 10;
const LAUNCH_SERVICES_READ_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_TIMEOUT_MS = 2_000;
const BUNDLE_ID_READ_TIMEOUT_MS = 1_500;
/**
 * Ceiling for the whole probe, shared by every read below. It has to exceed the full wait plus
 * the reads ahead of it — registration lands 0.5-0.75 s after a direct spawn — or the probe gives
 * up on the only case it exists for; the reads themselves fit the remainder with room on a healthy
 * host. AGENTS.md sizes a probe budget against the operation it precedes: the cost tradeoff of
 * this one against `open -b` is measured and argued in PR #3707.
 */
const LAUNCH_SERVICES_PROBE_BUDGET_MS = 2_500;
/**
 * Below this remaining budget a read is worth skipping rather than spawning with a token amount. It
 * is also what keeps every read bounded: the exec seam turns a zero timeout into no timer at all, so
 * a read armed with what is left of the budget after the floor would run unbounded.
 */
const MIN_PROBE_READ_MS = 100;
const LAUNCH_SERVICES_TOOL = '/usr/bin/lsappinfo';
const BUNDLE_ID_TOOL = 'plutil';
const BUNDLE_ID_KEY = 'CFBundleIdentifier';
const APP_EXECUTABLE_MARKER = '/Contents/MacOS/';
const APP_BUNDLE_SUFFIX = '.app';
const APP_BUNDLE_INFO_PLIST = 'Contents/Info.plist';
const LSAPPINFO_ASN = /ASN:/;

/**
 * Waits out the LaunchServices registration race so an open does not start a second copy of an app
 * whose running copy LaunchServices has not listed yet (#3406).
 *
 * A copy started directly — by a supervisor or a dev script — is only listed by LaunchServices
 * about half a second after it spawns. While it is unlisted, `open -b` sees no instance and launches
 * a second one with no arguments, which the session then drives instead of the copy the caller
 * owns. An open whose bundle LaunchServices already lists reaches `open` on that single read; an
 * open with no running copy pays one `lsappinfo find` and one process-table read (plus a
 * bundle-identifier read only when app-shaped candidates exist) to learn that; only a copy that
 * runs while unlisted is waited for, and only until LaunchServices lists it, since `open -b` then
 * attaches instead of launching. Every read shares one budget, and the wait itself stays well
 * inside it:
 *
 * - `LAUNCH_SERVICES_PROBE_BUDGET_MS` bounds every read below, each read also taking its own
 *   smaller cap so a single hung tool cannot consume the budget alone;
 * - `LAUNCH_SERVICES_MAX_POLLS` x `LAUNCH_SERVICES_POLL_MS` bounds the wait, sized for the ~0.5 s
 *   race measured on host Macs and far below the 90 s request envelope an open runs inside.
 *
 * A copy still unlisted when either bound runs out is opened anyway: the wait can only delay a
 * duplicate, never cause one, and never withhold the open.
 */
export async function waitForLaunchServicesRegistration(
  runCommand: AppleToolCommandExecutor,
  bundleId: string,
): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(LAUNCH_SERVICES_PROBE_BUDGET_MS);
  try {
    const listed = await readsLaunchServicesInstance(runCommand, bundleId, deadline);
    // Only an explicit "nothing is listed" is worth probing the process table for; a read that
    // cannot answer leaves this open the way it was before the check existed.
    if (listed !== false) return;
    const unlistedPids = await findUnlistedInstancePids(runCommand, bundleId, deadline);
    if (unlistedPids.length === 0) return;
    for (let poll = 0; poll < LAUNCH_SERVICES_MAX_POLLS; poll += 1) {
      if (deadline.remainingMs() < LAUNCH_SERVICES_POLL_MS + MIN_PROBE_READ_MS) return;
      await sleep(LAUNCH_SERVICES_POLL_MS);
      for (const pid of unlistedPids) {
        // A copy LaunchServices has come to list is the copy `open -b` will attach to, whichever of
        // the running copies it is. A read that answers nothing keeps the wait on its own bound
        // rather than being read as a registration, which is what would hand the duplicate back. A
        // read that cannot run at all ends the probe, which opens the bundle the way an unreadable
        // host always did.
        if ((await readsLaunchServicesInstance(runCommand, bundleId, deadline, pid)) === true) {
          return;
        }
      }
    }
  } catch (error) {
    // The probe is an extra read on someone else's app launch, so a host that cannot answer it at
    // all gets the open it would have had without the probe. The diagnostic is the only trace of
    // why a duplicate still happened.
    emitDiagnostic({
      level: 'warn',
      phase: 'macos_launch_services_registration_probe_failed',
      data: {
        bundleId,
        reason: error instanceof AppError ? error.code : 'probe_read_failed',
      },
    });
  }
}

/**
 * Whether LaunchServices lists a running instance of `bundleId`, optionally one exact process, or
 * `undefined` when the read failed. It lists nothing for an app that is not running and for a copy
 * still registering, which is what makes it the seam's only view of what `open -b` would attach to.
 * Failing to answer is its own answer: the probe's first read treats it as an instance to attach to,
 * so the open proceeds exactly as it did before the check existed, and only the wait for a process
 * the caller holds refuses to read it as one, because that wait ends on its own bound.
 */
async function readsLaunchServicesInstance(
  runCommand: AppleToolCommandExecutor,
  bundleId: string,
  deadline: Deadline,
  pid?: number,
): Promise<boolean | undefined> {
  const timeoutMs = probeBudgetMs(deadline, LAUNCH_SERVICES_READ_TIMEOUT_MS);
  if (timeoutMs === undefined) return undefined;
  let result: ExecResult;
  try {
    result = await runCommand(
      LAUNCH_SERVICES_TOOL,
      ['find', `bundleid=${bundleId}`, ...(pid === undefined ? [] : [`pid=${pid}`])],
      { allowFailure: true, timeoutMs },
    );
  } catch (error) {
    // A read killed at its own budget answers nothing, the way a non-zero exit does. Only a tool that
    // cannot run at all is worth ending the whole probe for.
    if (isCommandTimeoutError(error)) return undefined;
    throw error;
  }
  if (result.exitCode !== 0) return undefined;
  // The tool prints every instance it lists as an `ASN:` token, space-separated on one line.
  return LSAPPINFO_ASN.test(result.stdout);
}

/**
 * The processes running `bundleId` that LaunchServices does not list. `open -b` attaches to
 * whichever copy the registration eventually names, so every running copy of the bundle is watched
 * and any one of them being listed ends the wait.
 */
async function findUnlistedInstancePids(
  runCommand: AppleToolCommandExecutor,
  bundleId: string,
  deadline: Deadline,
): Promise<number[]> {
  const timeoutMs = probeBudgetMs(deadline, PROCESS_TABLE_TIMEOUT_MS);
  if (timeoutMs === undefined) return [];
  // The provider's own executor, so every read of this probe answers about the same host its
  // `lsappinfo`, `plutil` and `open` run on: a scoped Apple provider must never pair pids from one
  // host with tools on another.
  const processes = await listHostProcesses({ runCommand, timeoutMs });
  if (processes.length === 0) {
    // A macOS host always has a process table, so no rows at all is the read failing rather than a
    // host running nothing. The open proceeds without this probe knowing anything, so the reason is
    // worth leaving behind.
    emitDiagnostic({
      level: 'warn',
      phase: 'macos_launch_services_process_table_unreadable',
      data: { bundleId },
    });
    return [];
  }
  const pidsByBundle = new Map<string, number[]>();
  for (const processInfo of processes) {
    const bundlePath = macAppBundlePath(processInfo.command);
    if (bundlePath === undefined) continue;
    const pids = pidsByBundle.get(bundlePath);
    if (pids) pids.push(processInfo.pid);
    else pidsByBundle.set(bundlePath, [processInfo.pid]);
  }
  if (pidsByBundle.size === 0) return [];
  const bundlePaths = Array.from(pidsByBundle.keys());
  const bundleIds = await readAppBundleIds(
    runCommand,
    bundlePaths.map((bundlePath) => path.join(bundlePath, APP_BUNDLE_INFO_PLIST)),
    deadline,
  );
  return bundlePaths
    .filter(
      (bundlePath) =>
        bundleIds.get(path.join(bundlePath, APP_BUNDLE_INFO_PLIST))?.trim() === bundleId,
    )
    .flatMap((bundlePath) => pidsByBundle.get(bundlePath)!);
}

/**
 * The app bundle an executable path like `/Applications/App.app/Contents/MacOS/App` belongs to, or
 * none. Requiring the prefix to be a bundle rather than merely a path containing that directory
 * keeps the candidates to the shape `open -b` can launch: most rows carrying `/Contents/MacOS/` are
 * XPC services, app extensions, and driver bundles, whose identifiers match no app anyone opens.
 */
function macAppBundlePath(command: string): string | undefined {
  const marker = command.indexOf(APP_EXECUTABLE_MARKER);
  if (marker <= 0) return undefined;
  const bundlePath = command.slice(0, marker);
  return bundlePath.endsWith(APP_BUNDLE_SUFFIX) ? bundlePath : undefined;
}

/**
 * The `CFBundleIdentifier` of each given Info.plist, read in one `plutil` call. The tool prints one
 * row per readable plist in argument order — an empty row for a plist carrying the key with no
 * value — and names every unreadable plist on stderr as `<path>: <message>`, with the path
 * unquoted, so a plist is named only by a line that starts with the path it was asked about. When
 * the counts still disagree the read is unusable: it reports no identifiers rather than shifting one
 * bundle's identifier onto another bundle's process, and it never guesses which plist a row belongs
 * to.
 */
async function readAppBundleIds(
  runCommand: AppleToolCommandExecutor,
  plistPaths: readonly string[],
  deadline: Deadline,
): Promise<Map<string, string>> {
  const timeoutMs = probeBudgetMs(deadline, BUNDLE_ID_READ_TIMEOUT_MS);
  if (timeoutMs === undefined) return new Map();
  const result = await runCommand(
    BUNDLE_ID_TOOL,
    ['-extract', BUNDLE_ID_KEY, 'raw', ...plistPaths],
    { allowFailure: true, timeoutMs },
  );
  const rows = stripTrailingNewline(result.stdout).split('\n');
  const readable = plistPaths.filter((plistPath) => !namesPlutilFailure(result.stderr, plistPath));
  if (rows.length !== readable.length) return new Map();
  const bundleIds = new Map<string, string>();
  readable.forEach((plistPath, index) => {
    const bundleId = rows[index]?.trim();
    if (bundleId) bundleIds.set(plistPath, bundleId);
  });
  return bundleIds;
}

function namesPlutilFailure(stderr: string, plistPath: string): boolean {
  return stderr
    .split('\n')
    .some((line) => line.startsWith(plistPath) && line[plistPath.length] === ':');
}

function stripTrailingNewline(stdout: string): string {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

/**
 * The budget left for one probe read, or none when too little remains to ask a tool anything. Every
 * read of this probe takes its share of `LAUNCH_SERVICES_PROBE_BUDGET_MS` and no more than its own
 * cap, so one hung tool cannot consume the budget alone.
 */
function probeBudgetMs(deadline: Deadline, capMs: number): number | undefined {
  const remainingMs = deadline.remainingMs();
  return remainingMs < MIN_PROBE_READ_MS ? undefined : Math.min(capMs, remainingMs);
}
