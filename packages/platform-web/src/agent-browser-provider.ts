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
  session?: string;
  stateDir?: string;
  openWebSessionNames?: () => readonly string[];
  ownedProcessRecords?: OwnedProcessRecordStore;
};

export function createAgentBrowserWebProvider(
  options: AgentBrowserProviderOptions = {},
): WebProvider {
  const session = options.session?.trim();
  const runJson = async (args: string[], signal?: AbortSignal): Promise<unknown> =>
    await runAgentBrowserJson(args, { session, options, signal });

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
        (args) => runJson(args, snapshotOptions?.signal),
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
  runJson: (args: string[]) => Promise<unknown>,
  options: WebSnapshotOptions | undefined,
): Promise<WebSnapshotResult> {
  const data = await runJson(buildSnapshotArgs(options));
  return await normalizeAgentBrowserSnapshot(
    data,
    options?.includeRects ? async (ref) => await fetchRefRect(runJson, ref) : undefined,
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

async function fetchRefRect(
  runJson: (args: string[]) => Promise<unknown>,
  ref: string,
): Promise<Rect | undefined> {
  try {
    return parseRect(await runJson(['get', 'box', browserRefSelector(ref)]));
  } catch (error) {
    if (isIgnorableBoxError(error)) return undefined;
    throw error;
  }
}

function isIgnorableBoxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/\bstale\b/i.test(message) && /\bbox\b|not visible|not found|no element/i.test(message);
}

async function runAgentBrowserJson(
  args: string[],
  params: {
    session: string | undefined;
    options: AgentBrowserProviderOptions;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const { session, options, signal } = params;
  const cliArgs = [...args, '--json', ...(session ? ['--session', session] : [])];
  return await runAgentBrowserCommand(
    cliArgs,
    options,
    (result) => {
      const parsed = parseAgentBrowserJson(result.stdout, result.stderr, cliArgs, result.exitCode);
      return unwrapAgentBrowserJson(parsed, result, cliArgs);
    },
    signal,
  );
}

async function runAgentBrowserCommand(
  cliArgs: string[],
  options: AgentBrowserProviderOptions,
  interpret: (result: { stdout: string; stderr: string; exitCode: number }) => unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let commandCompleted = false;
  let semanticSuccess = false;
  const status = getManagedAgentBrowserStatus({ stateDir: options.stateDir });
  try {
    await cleanupProviderStartupOrphans(options);
    const result = await runManagedAgentBrowser(cliArgs, {
      stateDir: options.stateDir,
      allowFailure: true,
      timeoutMs: AGENT_BROWSER_TIMEOUT_MS,
      signal,
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
 * joins them because in the pinned 0.27.1 CLI, `record start` mints an `ffmpeg` child of the
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
 * it refreshes; so do `open` and `close`, which launch and end the fleet. A plain successful call
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
  const status = getManagedAgentBrowserStatus({ stateDir: options.stateDir });
  if (!status.installed) return;
  try {
    await cleanupManagedAgentBrowserOrphansForProviderStartup(status, {
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
