import { execFailureDetails } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { hostPlatform, type OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import {
  AppError,
  type DispatchDisclosure,
  discloseDispatchAfterSteps,
} from '@agent-device/kernel/errors';

import type { Rect } from '@agent-device/kernel/snapshot';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  buildAudioProbeEvalScript,
  normalizeAgentBrowserAudioProbeResult,
} from './agent-browser-audio-probe.ts';
import { normalizeAgentBrowserNetworkRequests } from './agent-browser-network.ts';
import { normalizeAgentBrowserSnapshot } from './agent-browser-snapshot.ts';
import {
  isJsonObject,
  readNumberProperty,
  readStringProperty,
  type JsonObject,
} from './json-utils.ts';
import type { WebProvider, WebSnapshotOptions, WebSnapshotResult } from './provider.ts';
import {
  getManagedAgentBrowserStatus,
  mapManagedAgentBrowserError,
  runManagedAgentBrowser,
} from './agent-browser-tool.ts';
import { cleanupManagedAgentBrowserOrphansForProviderStartup } from './agent-browser-lifecycle.ts';
import {
  managedWebBrowserProcessRecordIsLive,
  recordManagedAgentBrowserProcesses,
} from './agent-browser-process-record.ts';
import { DEFAULT_SCROLL_AMOUNT } from '@agent-device/contracts/scroll-gesture';

const AGENT_BROWSER = 'agent-browser';
const AGENT_BROWSER_TIMEOUT_MS = 30_000;
const AGENT_BROWSER_DOCTOR_HINT =
  'Run `agent-device web setup` to install the managed web backend.';

type AgentBrowserProviderOptions = {
  /** The composing runtime's host; every backend spawn and status read uses it. */
  host: HostEnvironment;
  session?: string;
  stateDir?: string;
  openWebSessionNames?: () => readonly string[];
  ownedProcessRecords?: OwnedProcessRecordStore;
};

/** How one backend call is executed: cancellation, plus the work it reads from stdin (`batch`). */
type AgentBrowserRunOptions = {
  signal?: AbortSignal;
  stdin?: string;
};

export function createAgentBrowserWebProvider(options: AgentBrowserProviderOptions): WebProvider {
  const session = options.session?.trim();
  const runJson = async (args: string[], run?: AgentBrowserRunOptions): Promise<unknown> =>
    await runAgentBrowserJson(args, { session, options, ...run });

  return {
    async open(target) {
      await runJson(['open', target]);
    },
    async close() {
      await runJson(['close']);
    },
    async startRecording(outPath) {
      await runJson(['record', 'start', outPath]);
    },
    async stopRecording() {
      await runJson(['record', 'stop']);
    },
    async snapshot(snapshotOptions) {
      return await captureAgentBrowserSnapshot(
        (args, run) => runJson(args, { ...run, signal: snapshotOptions?.signal }),
        snapshotOptions,
      );
    },
    async screenshot(outPath, screenshotOptions) {
      await runJson(['screenshot', ...(screenshotOptions?.fullscreen ? ['--full'] : []), outPath]);
    },
    async setViewport(width, height) {
      await runJson(['set', 'viewport', String(width), String(height)]);
    },
    async click(x, y) {
      const sends = createAgentBrowserSendLedger(runJson);
      try {
        await clickCoordinates(sends.send, x, y);
      } catch (error) {
        throw sends.discloseDispatch(error);
      }
    },
    async hover(x, y) {
      await movePointer(runJson, x, y);
    },
    async hoverRef(ref) {
      await runJson(['hover', browserRefSelector(ref)]);
    },
    async clickRef(ref) {
      await runJson(['click', browserRefSelector(ref)]);
    },
    async fill(x, y, text) {
      // The shared web interactor is coordinate-first; bridge that to low-level
      // browser input until a future ref-targeted web path can call native fill.
      const sends = createAgentBrowserSendLedger(runJson);
      try {
        await clickCoordinates(sends.send, x, y);
        await sends.send(['press', selectAllShortcut()]);
        if (text.length === 0) {
          // The clear-field request (#2063): typing zero characters over the selection would
          // leave the old value selected but intact, so the selection must be deleted instead.
          await sends.send(['press', 'Backspace']);
          return;
        }
        await sends.send(['keyboard', 'type', text]);
      } catch (error) {
        throw sends.discloseDispatch(error);
      }
    },
    async fillRef(ref, text) {
      await runJson(['fill', browserRefSelector(ref), text]);
    },
    async typeText(text) {
      await runJson(['keyboard', 'type', text]);
    },
    async scroll(direction, scrollOptions) {
      await runPacedScroll(runJson, direction, scrollOptions);
      return scrollOptions?.durationMs !== undefined
        ? { durationMs: scrollOptions.durationMs }
        : {};
    },
    async dumpNetwork(options) {
      return normalizeAgentBrowserNetworkRequests(await runJson(['network', 'requests']), options);
    },
    async probeAudio(options) {
      return normalizeAgentBrowserAudioProbeResult(
        await runJson(['eval', buildAudioProbeEvalScript(options)]),
      );
    },
  };
}

async function runPacedScroll(
  runJson: (args: string[]) => Promise<unknown>,
  direction: string,
  scrollOptions: { amount?: number; pixels?: number; durationMs?: number } | undefined,
): Promise<void> {
  const steps = buildPacedScrollSteps(resolveWebScrollDistance(scrollOptions));
  const sends = createAgentBrowserSendLedger(runJson);
  try {
    for (const step of steps) {
      await sends.send(buildScrollArgs(direction, step.distance));
      if (step.delayAfterMs > 0) await sleep(step.delayAfterMs);
    }
  } catch (error) {
    throw sends.discloseDispatch(error);
  }
}

/** One backend send for a compound operation, counted by {@link createAgentBrowserSendLedger}. */
type AgentBrowserSend = (args: string[]) => Promise<unknown>;

/**
 * Counts the backend sends of one compound web operation that returned, and discloses them on
 * its failure through the shared rule: `no` survives only while nothing was sent, so a counted
 * send makes the failure `unknown` with `details.dispatchedSteps`.
 */
function createAgentBrowserSendLedger(runJson: (args: string[]) => Promise<unknown>): {
  send: AgentBrowserSend;
  discloseDispatch(error: unknown): unknown;
} {
  let dispatchedSteps = 0;
  return {
    send: async (args) => {
      await runJson(args);
      dispatchedSteps += 1;
    },
    discloseDispatch(error: unknown): unknown {
      return discloseDispatchAfterSteps(error, dispatchedSteps);
    },
  };
}

type ScrollStep = {
  distance?: number;
  delayAfterMs: number;
};

/** agent-browser's own default wheel step, and the distance the default amount maps onto. */
const WEB_DEFAULT_SCROLL_PIXELS = 300;

type WebScrollDistance = {
  distance?: number;
  durationMs?: number;
};

/**
 * The browser scrolls by CSS pixels, so a relative `amount` has to become one before it reaches
 * agent-browser — feeding it through raw made `scroll down 0.5` travel half a pixel.
 *
 * There is no gesture viewport to measure against on this backend, so `amount` scales the default
 * step the same way the Linux pointer backend scales its wheel clicks: the shared default amount
 * maps to the default step, and everything else is proportional to it.
 */
function resolveWebScrollDistance(
  scrollOptions: { amount?: number; pixels?: number; durationMs?: number } | undefined,
): WebScrollDistance {
  const durationMs = scrollOptions?.durationMs;
  const timing = durationMs === undefined ? {} : { durationMs };
  if (scrollOptions?.pixels !== undefined) {
    return { distance: scrollOptions.pixels, ...timing };
  }
  if (scrollOptions?.amount !== undefined) {
    return {
      distance: Math.max(
        1,
        Math.round((WEB_DEFAULT_SCROLL_PIXELS * scrollOptions.amount) / DEFAULT_SCROLL_AMOUNT),
      ),
      ...timing,
    };
  }
  return timing;
}

function buildPacedScrollSteps(scrollDistance: WebScrollDistance): ScrollStep[] {
  const { distance, durationMs } = scrollDistance;
  if (durationMs === undefined || durationMs <= 0) {
    return [{ distance, delayAfterMs: 0 }];
  }

  const stepCount = Math.max(1, Math.min(20, Math.ceil(durationMs / 50)));
  const intervalMs = durationMs / Math.max(1, stepCount - 1);
  return distributeIntegerDistance(
    Math.round(distance ?? WEB_DEFAULT_SCROLL_PIXELS),
    stepCount,
  ).map((stepDistance, index) => ({
    distance: stepDistance,
    delayAfterMs: index < stepCount - 1 ? intervalMs : 0,
  }));
}

function distributeIntegerDistance(totalDistance: number, stepCount: number): number[] {
  const baseDistance = Math.floor(totalDistance / stepCount);
  const remainder = totalDistance - baseDistance * stepCount;
  return Array.from({ length: stepCount }, (_, index) =>
    index < remainder ? baseDistance + 1 : baseDistance,
  );
}

function buildScrollArgs(direction: string, distance: number | undefined): string[] {
  return ['scroll', direction, ...(distance === undefined ? [] : [String(distance)])];
}

async function clickCoordinates(send: AgentBrowserSend, x: number, y: number): Promise<void> {
  await movePointer(send, x, y);
  await send(['mouse', 'down']);
  await send(['mouse', 'up']);
}

async function movePointer(send: AgentBrowserSend, x: number, y: number): Promise<void> {
  await send(['mouse', 'move', String(Math.round(x)), String(Math.round(y))]);
}

async function captureAgentBrowserSnapshot(
  runJson: (args: string[], run?: AgentBrowserRunOptions) => Promise<unknown>,
  options: WebSnapshotOptions | undefined,
): Promise<WebSnapshotResult> {
  const data = await runJson(buildSnapshotArgs(options));
  return await normalizeAgentBrowserSnapshot(
    data,
    options?.includeRects ? (refs) => fetchRefRects(runJson, refs) : undefined,
  );
}

/**
 * The backend's own `--compact` is deliberately not requested: it removes an element with no ref
 * TOGETHER WITH the text under it, so a status region that just announced something never reaches
 * the projection at all. The empty structural lines it existed to hide are dropped by
 * `parseSnapshotDraftNodes` instead, which can tell an empty container from the text inside it.
 */
function buildSnapshotArgs(options: WebSnapshotOptions | undefined): string[] {
  return [
    'snapshot',
    ...(options?.interactiveOnly ? ['--interactive'] : []),
    ...(typeof options?.depth === 'number' ? ['--depth', String(options.depth)] : []),
    ...(options?.scope ? ['--selector', options.scope] : []),
  ];
}

/**
 * Refs per backend `batch` call. The bound is the group that finishes inside the command timeout it
 * runs under (`AGENT_BROWSER_TIMEOUT_MS`, 30 s) with room to spare: measured on a 408-ref page, 200
 * refs measured in 0.28 s and all 408 in 0.33 s inside one process, because a command inside a batch
 * is a DOM read of an already-loaded page rather than an interpreter boot. Raising the number is safe
 * only while that ratio holds — the stdin payload itself (~23 bytes per ref) is not the constraint.
 */
const MAX_REFS_PER_RECT_BATCH = 200;

/**
 * The bounds of every ref of the capture, in `batch` round trips: the backend measures them inside
 * one process, where the per-ref alternative pays one spawn per ref (measured on a 408-ref page: one
 * capture cost 385 spawns and 90 s, and 4 spawns and 0.3 s batched).
 *
 * A ref the backend could not measure comes back as a failed entry and simply gets no rect — an
 * element that is absent or has no box is an ordinary answer, and the entry's own `success` field is
 * what distinguishes it, never the error wording. `--bail` is deliberately not requested: it stops
 * at the first failed entry, which would silently drop the geometry of every ref after it.
 */
async function fetchRefRects(
  runJson: (args: string[], run?: AgentBrowserRunOptions) => Promise<unknown>,
  refs: readonly string[],
): Promise<Map<string, Rect>> {
  const rects = new Map<string, Rect>();
  // A capture with no addressable node is an empty group list, so the loop below never runs and the
  // backend is never called. That is the one place this seam declines to ask, and it is also what
  // keeps such a capture from tripping the refusal: nothing failed, there was nothing to measure.
  for (let start = 0; start < refs.length; start += MAX_REFS_PER_RECT_BATCH) {
    const group = refs.slice(start, start + MAX_REFS_PER_RECT_BATCH);
    const commands = group.map((ref) => ['get', 'box', browserRefSelector(ref)]);
    const entries = parseBatchEntries(
      await runJson(['batch'], { stdin: JSON.stringify(commands) }),
      commands,
      refs.length,
    );
    for (const [index, entry] of entries.entries()) {
      const ref = group[index];
      const rect = entry.success === true ? parseRect(entry.result) : undefined;
      if (rect && ref !== undefined) rects.set(ref, rect);
    }
  }
  if (refs.length > 0 && rects.size === 0) {
    // An element the backend CAN see measures as a box even when it is hidden or zero-sized, so a
    // capture whose every ref failed answered to a ref namespace the snapshot does not publish —
    // typically refs that went stale between the snapshot and this fetch. Surfacing no geometry at
    // all would leave the caller with a tree of unresolvable targets; the pre-batch code surfaced
    // the failure the same way, through the per-ref error.
    throw new AppError(
      'COMMAND_FAILED',
      'agent-browser resolved none of the snapshot refs while measuring snapshot geometry',
      {
        cmd: AGENT_BROWSER,
        args: ['batch'],
        reason: 'snapshot-refs-unmeasurable',
        requestedRefs: refs.length,
        measuredRects: 0,
        hint: AGENT_BROWSER_DOCTOR_HINT,
      },
    );
  }
  return rects;
}

type AgentBrowserBatchEntry = {
  command?: unknown;
  success?: unknown;
  result?: unknown;
};

/**
 * The backend answers a batch with one entry per command, echoing each command back, and reports a
 * whole-batch fault as a single object instead of an array. The echo is what pairs an entry to the
 * ref it measured, so position is trusted only as the order of the echo, never as the pairing
 * itself. Anything that breaks that pairing — an answer that is not a list of entries, a list that
 * does not cover the commands sent, an entry with no verdict, an entry describing some other command
 * — means the geometry cannot be matched back and is refused, naming which invariant broke.
 *
 * Each refusal is keyed by a stable `reason` identifier rather than by its own sentence, so a caller
 * branches on the failure without reading prose. `captureRefs` is the capture's whole ref count
 * instead of this group's, because the answer reads as a statement about the capture and one capture
 * can be measured in several groups.
 */
function parseBatchEntries(
  data: unknown,
  commands: readonly (readonly string[])[],
  captureRefs: number,
): AgentBrowserBatchEntry[] {
  const unusable = (reason: string): AppError =>
    new AppError(
      'COMMAND_FAILED',
      `agent-browser returned an unusable batch result for snapshot geometry (${reason})`,
      {
        cmd: AGENT_BROWSER,
        args: ['batch'],
        reason,
        requestedRefs: captureRefs,
        groupRefs: commands.length,
        hint: AGENT_BROWSER_DOCTOR_HINT,
      },
    );
  if (!Array.isArray(data)) throw unusable('batch-result-not-a-list');
  if (data.length !== commands.length) throw unusable('entry-count');
  if (!data.every(isBatchEntry)) throw unusable('entry-shape');
  const entries = data;
  for (const [index, entry] of entries.entries()) {
    if (!sameBatchCommand(entry.command, commands[index])) throw unusable('entry-command');
  }
  return entries;
}

/** The echo as the backend printed it, which for these commands is exactly the array that was sent. */
function sameBatchCommand(
  echoed: unknown,
  command: readonly string[] | undefined,
): echoed is readonly string[] {
  return (
    command !== undefined &&
    Array.isArray(echoed) &&
    echoed.length === command.length &&
    echoed.every((token, index) => token === command[index])
  );
}

function isBatchEntry(value: unknown): value is AgentBrowserBatchEntry {
  // An object with no verdict is not an answer about a ref: treated as a failed entry it would
  // silently drop that node's geometry, which reads as "this element has no box".
  return isJsonObject(value) && typeof value.success === 'boolean';
}

async function runAgentBrowserJson(
  args: string[],
  params: {
    session: string | undefined;
    options: AgentBrowserProviderOptions;
  } & AgentBrowserRunOptions,
): Promise<unknown> {
  const { session, options, signal, stdin } = params;
  const cliArgs = [...args, '--json', ...(session ? ['--session', session] : [])];
  return await runAgentBrowserCommand(
    cliArgs,
    options,
    (result) => {
      const parsed = parseAgentBrowserJson(result.stdout, result.stderr, cliArgs, result.exitCode);
      return unwrapAgentBrowserJson(parsed, result, cliArgs);
    },
    { signal, stdin },
  );
}

async function runAgentBrowserCommand(
  cliArgs: string[],
  options: AgentBrowserProviderOptions,
  interpret: (result: { stdout: string; stderr: string; exitCode: number }) => unknown,
  run: AgentBrowserRunOptions,
): Promise<unknown> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let commandCompleted = false;
  let semanticSuccess = false;
  const status = getManagedAgentBrowserStatus({ host: options.host, stateDir: options.stateDir });
  try {
    await cleanupProviderStartupOrphans(options);
    const result = await runManagedAgentBrowser(cliArgs, {
      host: options.host,
      stateDir: options.stateDir,
      allowFailure: true,
      timeoutMs: AGENT_BROWSER_TIMEOUT_MS,
      signal: run.signal,
      stdin: run.stdin,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    commandCompleted = true;
  } catch (error) {
    await finalizeAgentBrowserProcessRecord({
      cliArgs,
      commandCompleted,
      exitCode,
      semanticSuccess,
      options,
      status,
    });
    throw mapAgentBrowserRunError(error, cliArgs);
  }

  try {
    const result = { stdout, stderr, exitCode };
    const output = interpret(result);
    semanticSuccess = true;
    return output;
  } finally {
    await finalizeAgentBrowserProcessRecord({
      cliArgs,
      commandCompleted,
      exitCode,
      semanticSuccess,
      options,
      status,
    });
  }
}

async function finalizeAgentBrowserProcessRecord(params: {
  cliArgs: string[];
  commandCompleted: boolean;
  exitCode: number;
  semanticSuccess: boolean;
  options: AgentBrowserProviderOptions;
  status: ReturnType<typeof getManagedAgentBrowserStatus>;
}): Promise<void> {
  const store = params.options.ownedProcessRecords;
  if (!store || !params.status.installed) return;
  try {
    const remainingSessions = params.options.openWebSessionNames?.() ?? [];
    const currentSession = params.options.session?.trim();
    const otherOpenSessions = remainingSessions.filter((name) => name !== currentSession);
    if (canClearAgentBrowserRecord(params, otherOpenSessions.length)) {
      store.clear({ kind: 'daemon' });
      return;
    }
    if (await shouldRefreshAgentBrowserProcessRecord(params, store)) {
      await recordManagedAgentBrowserProcesses(params.status, store);
    }
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_process_record_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * The agent-browser commands that can change the owned browser fleet.
 *
 * `open` may launch the agent-browser daemon and its Chrome, and `close` can end them. `record`
 * joins them because in the pinned CLI, `record start` mints an `ffmpeg` child of the
 * daemon — the WebM encoder outlives the CLI process, which returns while the recording runs, and
 * `record stop` is a later command that pipes into it. That helper is outside Chrome's tree, so
 * only a scan reached by a lifecycle boundary can add it to the record the startup reaper signals;
 * a probe over already-recorded pids never learns of a process the fleet minted after the last
 * scan. `record stop` re-scanning too is the cheap side of one set: the fleet can also shrink.
 */
const AGENT_BROWSER_FLEET_LIFECYCLE_COMMANDS: ReadonlySet<string> = new Set([
  'open',
  'close',
  'record',
]);

/**
 * Whether the process-table scan that rewrites the owned-process record has to run for one
 * agent-browser call.
 *
 * Any failure may be the first command that finds the fleet died or restarted between calls, so
 * it refreshes; so do the {@link AGENT_BROWSER_FLEET_LIFECYCLE_COMMANDS} members, which launch,
 * end, and extend the fleet. A plain successful call
 * acts on a fleet the record already describes, and re-deriving that fleet means a process-tool
 * snapshot of every host process, which is the cost this seam exists to avoid.
 * {@link managedWebBrowserProcessRecordIsLive} answers for the recorded pids from one same-pid
 * probe instead. It is fail-closed: an empty, undecodable, or unanswered probe falls back to the
 * scan, so a live fleet this daemon adopted from a predecessor becomes owned through the record
 * again, and a fleet that died or restarted outside a lifecycle boundary is caught by the next
 * command that can no longer name every process the record still claims is alive.
 */
async function shouldRefreshAgentBrowserProcessRecord(
  params: Pick<
    Parameters<typeof finalizeAgentBrowserProcessRecord>[0],
    'cliArgs' | 'commandCompleted' | 'semanticSuccess'
  >,
  store: OwnedProcessRecordStore,
): Promise<boolean> {
  if (!params.commandCompleted || !params.semanticSuccess) return true;
  const command = params.cliArgs[0];
  if (command !== undefined && AGENT_BROWSER_FLEET_LIFECYCLE_COMMANDS.has(command)) return true;
  return !(await managedWebBrowserProcessRecordIsLive(store));
}

function canClearAgentBrowserRecord(
  params: Pick<
    Parameters<typeof finalizeAgentBrowserProcessRecord>[0],
    'cliArgs' | 'commandCompleted' | 'exitCode' | 'semanticSuccess'
  >,
  otherOpenSessionCount: number,
): boolean {
  return (
    params.commandCompleted &&
    params.semanticSuccess &&
    params.cliArgs[0] === 'close' &&
    params.exitCode === 0 &&
    otherOpenSessionCount === 0
  );
}

async function cleanupProviderStartupOrphans(options: AgentBrowserProviderOptions): Promise<void> {
  if (!options.openWebSessionNames) return;
  const status = getManagedAgentBrowserStatus({ host: options.host, stateDir: options.stateDir });
  if (!status.installed) return;
  try {
    await cleanupManagedAgentBrowserOrphansForProviderStartup(status, {
      env: options.host.env,
      openWebSessionNames: options.openWebSessionNames(),
      ...(options.ownedProcessRecords === undefined
        ? {}
        : { ownedProcessRecords: options.ownedProcessRecords }),
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_provider_orphan_cleanup_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

function unwrapAgentBrowserJson(
  parsed: unknown,
  result: { stdout: string; stderr: string; exitCode: number },
  cliArgs: string[],
): unknown {
  if (!isJsonObject(parsed)) return parsed;

  const success = parsed.success ?? parsed.ok;
  if (success === false) {
    throw new AppError(toErrorCode(parsed.code), readEnvelopeErrorMessage(parsed), {
      cmd: AGENT_BROWSER,
      args: cliArgs,
      hint: readStringProperty(parsed, 'hint') ?? AGENT_BROWSER_DOCTOR_HINT,
      agentBrowserError: parsed.error,
      ...agentBrowserCliRefusalDispatch(parsed),
    });
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'agent-browser command failed',
      execFailureDetails(result, {
        cmd: AGENT_BROWSER,
        args: cliArgs,
        stdout: result.stdout.slice(0, 500),
        stderr: result.stderr.slice(0, 500),
        hint: readStringProperty(parsed, 'hint') ?? AGENT_BROWSER_DOCTOR_HINT,
      }),
    );
  }

  return Object.hasOwn(parsed, 'data') ? parsed.data : parsed;
}

function parseAgentBrowserJson(
  stdout: string,
  stderr: string,
  args: string[],
  exitCode: number,
): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const commandFailed = exitCode !== 0;
    // exec-guard-allow: reachable at exit 0 (invalid JSON on stdout); the
    // message already branches on the exit code and output is truncated.
    throw new AppError(
      'COMMAND_FAILED',
      commandFailed ? 'agent-browser command failed' : 'agent-browser returned invalid JSON',
      {
        cmd: AGENT_BROWSER,
        args,
        ...(commandFailed ? { exitCode } : {}),
        stdout: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500),
        hint: AGENT_BROWSER_DOCTOR_HINT,
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function mapAgentBrowserRunError(error: unknown, args: string[]): AppError {
  const appError = mapManagedAgentBrowserError(error);
  if (appError.code === 'TOOL_MISSING') {
    return new AppError(
      'TOOL_MISSING',
      appError.message,
      {
        ...(appError.details ?? {}),
        cmd: AGENT_BROWSER,
        args,
        hint: webBackendHint(appError),
        // The managed entry was never spawned, so nothing of this command reached the browser.
        dispatched: 'no',
      },
      appError,
    );
  }
  if (appError.code === 'COMMAND_FAILED') {
    return new AppError(
      'COMMAND_FAILED',
      appError.message,
      {
        ...(appError.details ?? {}),
        cmd: AGENT_BROWSER,
        args,
        hint: webBackendHint(appError),
      },
      appError,
    );
  }
  return appError;
}

function webBackendHint(error: AppError): string {
  return typeof error.details?.hint === 'string' ? error.details.hint : AGENT_BROWSER_DOCTOR_HINT;
}

function readEnvelopeErrorMessage(envelope: JsonObject): string {
  const error = envelope.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isJsonObject(error)) {
    const message = readStringProperty(error, 'message') ?? readStringProperty(error, 'error');
    if (message) return message;
  }
  return readStringProperty(envelope, 'message') ?? 'agent-browser command failed';
}

function toErrorCode(value: unknown): 'COMMAND_FAILED' | (string & {}) {
  return typeof value === 'string' && value.length > 0 ? value : 'COMMAND_FAILED';
}

/**
 * The typed envelope `type`s that prove the agent-browser CLI refused an argv before the command
 * could reach the browser daemon: the CLI answers them itself, with the daemon dead, and a
 * semantic failure carries no `type` at all. The requested operation never ran, so `no` is safe.
 * For a command that did reach the backend, whatever the browser did with it is not knowable from
 * the reply, so the provider stays silent and the request router's fallback answers `unknown`.
 * Mirrored by the `web-agent-browser.` rows in contracts/fixtures/dispatch-disclosure.json.
 */
const AGENT_BROWSER_PRE_DISPATCH_REFUSAL_TYPES: ReadonlySet<string> = new Set([
  'unknown_command',
  'missing_arguments',
]);

function agentBrowserCliRefusalDispatch(parsed: JsonObject): {
  dispatched?: DispatchDisclosure;
} {
  const type = readStringProperty(parsed, 'type');
  return type !== undefined && AGENT_BROWSER_PRE_DISPATCH_REFUSAL_TYPES.has(type)
    ? { dispatched: 'no' }
    : {};
}

function browserRefSelector(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
}

function selectAllShortcut(): string {
  return hostPlatform() === 'darwin' ? 'Meta+a' : 'Control+a';
}

function parseRect(data: unknown): Rect | undefined {
  const candidate = isJsonObject(data) && isJsonObject(data.box) ? data.box : data;
  if (!isJsonObject(candidate)) return undefined;
  return rectFromPointSize(candidate) ?? rectFromEdges(candidate);
}

function rectFromPointSize(candidate: JsonObject): Rect | undefined {
  const x = readNumberProperty(candidate, 'x');
  const y = readNumberProperty(candidate, 'y');
  const width = readNumberProperty(candidate, 'width');
  const height = readNumberProperty(candidate, 'height');
  return buildRect(x, y, width, height);
}

function rectFromEdges(candidate: JsonObject): Rect | undefined {
  const left = readNumberProperty(candidate, 'left');
  const top = readNumberProperty(candidate, 'top');
  const right = readNumberProperty(candidate, 'right');
  const bottom = readNumberProperty(candidate, 'bottom');
  return buildRect(left, top, diffNumbers(right, left), diffNumbers(bottom, top));
}

function buildRect(
  x: number | undefined,
  y: number | undefined,
  width: number | undefined,
  height: number | undefined,
): Rect | undefined {
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function diffNumbers(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a - b;
}
