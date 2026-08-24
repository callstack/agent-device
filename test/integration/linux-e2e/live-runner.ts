import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { runSourceCliJsonSync } from '../cli-json.ts';
import { assertJsonContains } from '../live-device-e2e/assertions.ts';
import {
  collectPagedEventTimeline,
  type EventTimelinePage,
} from '../live-device-e2e/event-timeline.ts';
import {
  createLiveDeviceContext,
  createLiveDeviceHarness,
  type LiveDeviceContext,
} from '../live-device-e2e/runtime.ts';
import { runLiveReplayTestSuite } from '../live-device-e2e/replay-suite.ts';
import { writeCoverageReport } from '../live-device-e2e/coverage.ts';
import {
  LINUX_COMMAND_EVIDENCE_COMMANDS,
  LINUX_COMMAND_EVIDENCE_SCRIPT,
} from './command-evidence.ts';

const C = PUBLIC_COMMANDS;
const LINUX_CALCULATOR_LANDMARK =
  'appname=gnome-calculator || windowtitle=Calculator || label=Calculator || label=0 || label=1 || label=5';
const SCENARIO_ID = 'linux-command-evidence';
const SCRIPT_PATH = path.resolve(LINUX_COMMAND_EVIDENCE_SCRIPT);

type LinuxBehavior = 'command-evidence';
type LinuxContext = LiveDeviceContext<LinuxBehavior>;

const harness = createLiveDeviceHarness<LinuxContext, LinuxBehavior>({
  behaviorsForScenario: () => [],
  commandsForScenario: () => LINUX_COMMAND_EVIDENCE_COMMANDS,
  commonFlags: (context, args) => [
    ...args,
    '--platform',
    'linux',
    '--session',
    context.session,
    '--json',
  ],
  runCli: async (args, env, options) =>
    runSourceCliJsonSync(args, { env, timeoutMs: options?.timeoutMs }),
  writeCoverageReport: (context) =>
    writeCoverageReport(context, {
      platform: 'linux',
      script: SCRIPT_PATH,
    }),
});

const { runScenario, runStep, sessionExists, verifyCommand } = harness;

async function runLinuxCommandEvidence(): Promise<void> {
  const context = createLiveDeviceContext<LinuxBehavior>({
    artifactRoot: 'test/artifacts/linux-command-evidence',
    session: `${SCENARIO_ID}-${process.pid}`,
  });
  context.env = {
    ...context.env,
    AGENT_DEVICE_STATE_DIR: path.join(context.artifactDir, 'daemon-state'),
  };
  const primaryError = await captureError(() =>
    runScenario(context, {
      id: SCENARIO_ID,
      run: runCommandEvidence,
    }),
  );
  const cleanupError = await finalize(context);
  throwErrors(primaryError, cleanupError);
}

async function runCommandEvidence(context: LinuxContext): Promise<void> {
  await runCommandDiscoveryEvidence(context);
  await runSnapshotEvidence(context);
  await runEventEvidence(context);
}

async function runCommandDiscoveryEvidence(context: LinuxContext): Promise<void> {
  const capabilities = await runStep(context, 'read Linux capabilities', ['capabilities']);
  assertJsonContains(capabilities, 'find', 'Linux capabilities should expose find');
  assertJsonContains(capabilities, 'swipe', 'Linux capabilities should expose swipe');
  verifyCommand(
    context,
    C.capabilities,
    'Linux capabilities reports command admission for the selected desktop',
  );

  const doctor = await runStep(context, 'run Linux doctor', ['doctor']);
  assertJsonContains(doctor, 'linux', 'Linux doctor should report the selected platform');
  verifyCommand(context, C.doctor, 'Linux doctor returns platform-specific diagnostics');

  const suite = await runLiveReplayTestSuite({
    context,
    runStep,
    step: 'run the command-evidence script as a test suite',
    scripts: [SCRIPT_PATH],
    artifactName: 'command-evidence-test',
  });
  assert.equal(suite.commandsByScript.get(SCRIPT_PATH)?.includes('find'), true);
  verifyCommand(context, C.test, 'the Linux command-evidence script passes through test');

  const replay = await runStep(context, 'replay the command-evidence script', [
    'replay',
    SCRIPT_PATH,
    '--keep-session',
  ]);
  assert.equal(replay.json?.data?.sessionActive, true, JSON.stringify(replay.json));
  assert.equal(typeof replay.json?.data?.session, 'string', JSON.stringify(replay.json));
  context.session = replay.json.data.session;
  context.sessionOpen = true;
  verifyCommand(context, C.replay, 'the Linux command-evidence script passes through replay');
}

async function runSnapshotEvidence(context: LinuxContext): Promise<void> {
  await runFindEvidence(context);
  await runDiffEvidence(context);
  await runSwipeEvidence(context);
  await runBatchEvidence(context);
}

async function runFindEvidence(context: LinuxContext): Promise<void> {
  const find = await runStep(context, 'find a calculator button', [
    'find',
    'role',
    'button',
    'exists',
    '--first',
  ]);
  assert.equal(find.json?.data?.found, true, JSON.stringify(find.json));
  verifyCommand(context, C.find, 'find resolves a live AT-SPI role match');
}

async function runDiffEvidence(context: LinuxContext): Promise<void> {
  await closeIfOpen(context);
  await runStep(context, 'reset the calculator before diff', [
    'open',
    'gnome-calculator',
    '--relaunch',
  ]);
  await runStep(context, 'capture the diff baseline', ['snapshot', '-i']);
  await runStep(context, 'mutate the calculator before diff', ['click', 'role=button label=1']);
  const diff = await runStep(context, 'read the live snapshot diff', ['diff', 'snapshot', '-i']);
  const summary = diff.json!.data!.summary!;
  const additions = Number(summary.additions);
  const removals = Number(summary.removals);
  assert.ok(
    additions + removals > 0,
    `expected a non-empty Linux snapshot diff: ${JSON.stringify(diff.json)}`,
  );
  verifyCommand(context, C.diff, 'snapshot diff observes the calculator mutation');
}

async function runSwipeEvidence(context: LinuxContext): Promise<void> {
  await runStep(context, 'swipe across the Linux desktop', ['swipe', '100', '400', '100', '300']);
  verifyCommand(context, C.swipe, 'coordinate swipe reaches the Linux input runtime');
}

async function runBatchEvidence(context: LinuxContext): Promise<void> {
  const batchSteps = JSON.stringify([
    { command: 'is', input: { predicate: 'exists', selector: LINUX_CALCULATOR_LANDMARK } },
    { command: 'snapshot', input: { interactiveOnly: true } },
  ]);
  const batch = await runStep(context, 'run a Linux batch of live reads', [
    'batch',
    '--steps',
    batchSteps,
  ]);
  assertLinuxBatchResults(batch.json);
  verifyCommand(context, C.batch, 'batch executes two successful Linux session reads');
}

function assertLinuxBatchResults(json: any): void {
  const data = json?.data;
  assert.ok(data, JSON.stringify(json));
  assert.equal(data.executed, 2, JSON.stringify(json));
  const results = data.results;
  assert.ok(Array.isArray(results), JSON.stringify(json));
  assert.equal(results.length, 2, JSON.stringify(json));
  const first = results[0] as { command?: string; data?: { pass?: boolean } };
  const second = results[1] as { command?: string };
  assert.equal(first.command, 'is', JSON.stringify(json));
  assert.equal(first.data?.pass, true, JSON.stringify(json));
  assert.equal(second.command, 'snapshot', JSON.stringify(json));
}

async function runEventEvidence(context: LinuxContext): Promise<void> {
  const timeline = await collectPagedEventTimeline((cursor) => readLinuxEventPage(context, cursor));
  for (const command of [C.open, C.snapshot]) {
    assert.ok(
      timeline.commands.includes(command),
      `Linux events missing ${command}: ${JSON.stringify(timeline)}`,
    );
  }
  verifyCommand(context, C.events, 'event timeline names open and snapshot from the Linux session');
}

async function readLinuxEventPage(
  context: LinuxContext,
  cursor: string | undefined,
): Promise<EventTimelinePage> {
  const args = ['events', '100'];
  if (cursor !== undefined) args.push(cursor);
  const events = await runStep(context, 'read Linux session events', args);
  const json = events.json as { data?: EventTimelinePage };
  assert.ok(json.data, JSON.stringify(events.json));
  return json.data;
}

async function finalize(context: LinuxContext): Promise<unknown> {
  const closeError = await captureError(() => closeIfOpen(context));
  const reportError = await captureError(() => {
    writeCoverageReport(context, {
      platform: 'linux',
      script: SCRIPT_PATH,
    });
  });
  return combineErrors([closeError, reportError]);
}

async function closeIfOpen(context: LinuxContext): Promise<void> {
  if (!context.sessionOpen && !(await sessionExists(context))) return;
  await runStep(context, 'close the Linux command-evidence session', ['close']);
}

async function captureError(action: () => Promise<void> | void): Promise<unknown | undefined> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function combineErrors(errors: readonly (unknown | undefined)[]): unknown {
  const failures = errors.filter((error): error is unknown => error !== undefined);
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, 'Linux command evidence cleanup failed');
}

function throwErrors(primaryError: unknown | undefined, cleanupError: unknown): void {
  if (primaryError === undefined) {
    if (cleanupError !== undefined) throw cleanupError;
    return;
  }
  if (cleanupError === undefined) throw primaryError;
  throw new AggregateError(
    [primaryError, cleanupError],
    'Linux command evidence failed and cleanup also failed',
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runLinuxCommandEvidence();
}
