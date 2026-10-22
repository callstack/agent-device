import fs from 'node:fs';
import path from 'node:path';
import {
  resolveSessionDir,
  resolveSessionRequestLogPath,
} from '@agent-device/daemon-contracts/session-artifact-paths';
import { invokeCli } from './cli.ts';
import type { PerfConfig } from './config.ts';
import { captureWithForcedBackend } from './forced-backend.ts';
import { expectationViolation, type SuiteScenario, type SuiteStep } from './ios-suite.ts';
import { buildMeasurement } from './measurement.ts';
import {
  profileRequestLog,
  readClientDiagnostics,
  readSettleFacts,
  readSnapshotFacts,
} from './profile.ts';
import type { CliResult, Measurement, Sample } from './types.ts';

const SESSION = 'perf';

export type IosSuiteContext = {
  stateDir: string;
  udid: string;
  appId: string;
  artifactsDir: string;
  rawDir: string;
  // Set when a request outlived the client timeout. That request still holds the session, so
  // the suite restarts the daemon before the next scenario.
  daemonStuck?: boolean;
};

function log(msg: string): void {
  process.stderr.write(`[perf] ${msg}\n`);
}

function baseFlags(ctx: IosSuiteContext): string[] {
  return ['--state-dir', ctx.stateDir, '--session', SESSION, '--platform', 'ios'];
}

function run(ctx: IosSuiteContext, args: readonly string[]): CliResult {
  return watch(ctx, invokeCli(expandStatic(args, ctx), baseFlags(ctx)));
}

function watch(ctx: IosSuiteContext, result: CliResult): CliResult {
  if (daemonTimedOut(result)) ctx.daemonStuck = true;
  return result;
}

function expandStatic(args: readonly string[], ctx: IosSuiteContext): string[] {
  return args.map((arg) =>
    arg === '{app}'
      ? ctx.appId
      : arg.replace(/^\{out:(.+)\}$/, (_, file: string) => path.join(ctx.artifactsDir, file)),
  );
}

type SnapshotNode = {
  ref?: string;
  identifier?: string;
  rect?: { x: number; y: number; width: number; height: number };
};

const TARGET_TOKEN = /^\{(ref|point):(.+)\}$/;

/** Expands `{ref:id}` and `{point:id}` from one untimed interactive snapshot. */
function resolveTargets(args: string[], ctx: IosSuiteContext): string[] | { error: string } {
  if (!args.some((arg) => TARGET_TOKEN.test(arg))) return args;
  const snapshot = run(ctx, ['snapshot', '-i']);
  const nodes = ((snapshot.json as { data?: { nodes?: SnapshotNode[] } })?.data?.nodes ??
    []) as SnapshotNode[];
  const expanded: string[] = [];
  for (const arg of args) {
    const match = TARGET_TOKEN.exec(arg);
    if (!match) {
      expanded.push(arg);
      continue;
    }
    const node = nodes.find((candidate) => candidate.identifier === match[2]);
    if (!node?.ref || !node.rect) return { error: `target ${match[2]} is not in snapshot -i` };
    if (match[1] === 'ref') {
      expanded.push(`@${node.ref}`);
    } else {
      expanded.push(
        String(Math.round(node.rect.x + node.rect.width / 2)),
        String(Math.round(node.rect.y + node.rect.height / 2)),
      );
    }
  }
  return expanded;
}

/** Runs untimed calls in order and describes the first failure. */
function untimed(
  ctx: IosSuiteContext,
  calls: readonly (readonly string[])[] = [],
): string | undefined {
  for (const args of calls) {
    const result = run(ctx, args);
    if (!result.ok) return `${args.join(' ')}: ${errorOf(result).errorMessage}`;
  }
  return undefined;
}

/** True when the client gave up on a daemon request that is still running. */
function daemonTimedOut(result: CliResult): boolean {
  const details = (result.json as { error?: { details?: { reason?: unknown } } } | undefined)?.error
    ?.details;
  return details?.reason === 'daemon_transport_timeout';
}

function errorOf(result: CliResult): Pick<Sample, 'errorCode' | 'errorMessage'> {
  const error = (result.json as { error?: { code?: string; message?: string } } | undefined)?.error;
  return {
    errorCode: error?.code ?? `exit:${result.exitCode}`,
    errorMessage: (error?.message ?? result.stderr.trim().split('\n').pop() ?? '').slice(0, 300),
  };
}

function readProfile(ctx: IosSuiteContext, requestId: string | undefined) {
  if (!requestId) return undefined;
  const sessionDir = resolveSessionDir(path.join(ctx.stateDir, 'sessions'), SESSION);
  const logPath = resolveSessionRequestLogPath(sessionDir, requestId);
  return fs.existsSync(logPath) ? profileRequestLog(fs.readFileSync(logPath, 'utf8')) : undefined;
}

function recordFailure(ctx: IosSuiteContext, id: string, round: number, detail: unknown): void {
  const dir = path.join(ctx.rawDir, 'failures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id.replace('/', '__')}.round-${round}.json`),
    JSON.stringify(detail, null, 2),
  );
}

async function runTimedStep(
  scenario: SuiteScenario,
  step: SuiteStep,
  ctx: IosSuiteContext,
  round: number,
): Promise<Sample> {
  const id = `${scenario.id}/${step.id}`;
  const before = untimed(ctx, step.before);
  if (before) {
    log(`  ✗ ${id} (before_failed: ${before})`);
    return { round, ok: false, wallClockMs: 0, errorCode: 'before_failed', errorMessage: before };
  }
  let sample: Sample;
  if (step.via === 'sdk-forced-tree') {
    const { result: forced, requestId } = await captureWithForcedBackend({
      stateDir: ctx.stateDir,
      session: SESSION,
      udid: ctx.udid,
      backend: 'tree',
    });
    const result = watch(ctx, forced);
    const profile = readProfile(ctx, requestId);
    sample = {
      round,
      ok: result.ok,
      wallClockMs: result.wallClockMs,
      daemonMs: profile?.requestSpanMs,
      requestId,
      snapshot: readSnapshotFacts(result.json),
      profile,
    };
    if (!result.ok) Object.assign(sample, errorOf(result));
  } else {
    const args = resolveTargets(expandStatic(step.args, ctx), ctx);
    if ('error' in args) {
      sample = {
        round,
        ok: false,
        wallClockMs: 0,
        errorCode: 'target_unresolved',
        errorMessage: args.error,
      };
    } else {
      const result = watch(ctx, invokeCli([...args, '--debug'], baseFlags(ctx)));
      const diagnostics = readClientDiagnostics(result.stderr);
      sample = {
        round,
        ok: result.ok,
        wallClockMs: result.wallClockMs,
        daemonMs: diagnostics.daemonMs,
        requestId: diagnostics.requestId,
        snapshot: step.command === 'snapshot' ? readSnapshotFacts(result.json) : undefined,
        settle: readSettleFacts(result.json),
        profile: readProfile(ctx, diagnostics.requestId),
      };
      if (!result.ok) {
        Object.assign(sample, errorOf(result));
        recordFailure(ctx, id, round, {
          args,
          json: result.json,
          stderrTail: result.stderr.slice(-4000),
        });
      }
    }
  }
  const violation = sample.ok ? expectationViolation(step.expect, sample.snapshot) : undefined;
  if (violation)
    Object.assign(sample, { ok: false, errorCode: 'expectation_failed', errorMessage: violation });
  const after = untimed(ctx, step.after);
  if (after) log(`  ! ${id} after: ${after}`);
  if (!sample.ok) log(`  ✗ ${id} (${sample.errorCode}: ${sample.errorMessage})`);
  return sample;
}

function sessionError(result: CliResult): string | undefined {
  if (result.ok) return undefined;
  const message = `open: ${errorOf(result).errorMessage}`;
  log(` ✗ session failed: ${message}`);
  return message;
}

function stopStuckDaemon(ctx: IosSuiteContext): void {
  log(' ! a request outlived its timeout; restarting the daemon');
  invokeCli(['daemon', 'stop', '--clean'], ['--state-dir', ctx.stateDir]);
  ctx.daemonStuck = false;
}

/** Opens the session with device selectors; later calls address it by session name alone. */
function establishSession(ctx: IosSuiteContext): CliResult {
  if (ctx.daemonStuck) stopStuckDaemon(ctx);
  return watch(
    ctx,
    invokeCli(['open', ctx.appId, '--relaunch', '--udid', ctx.udid], baseFlags(ctx)),
  );
}

export async function runIosSuite(
  ctx: IosSuiteContext,
  cfg: PerfConfig,
  scenarios: readonly SuiteScenario[],
): Promise<Measurement[]> {
  const samples = new Map<string, Sample[]>();
  const totalRounds = cfg.warmup + cfg.rounds;
  for (let round = 0; round < totalRounds; round++) {
    const measured = round >= cfg.warmup;
    log(`round ${round + 1}/${totalRounds}${measured ? '' : ' (warmup, dropped)'}`);
    let sessionFailure = sessionError(establishSession(ctx));
    for (const scenario of scenarios) {
      // A request that outlived its timeout still holds the session; reopen before the next scenario.
      if (ctx.daemonStuck) sessionFailure = sessionError(establishSession(ctx));
      log(` scenario ${scenario.id}`);
      const setupFailure = sessionFailure ?? untimed(ctx, scenario.setup);
      if (setupFailure) log(`  ✗ setup failed: ${setupFailure}`);
      for (const step of scenario.steps) {
        // CLI calls block the event loop; yield so an interrupt can stop the run between steps.
        await new Promise((resolve) => setImmediate(resolve));
        const id = `${scenario.id}/${step.id}`;
        const skipped = setupFailure
          ? { errorCode: 'setup_failed', errorMessage: setupFailure }
          : ctx.daemonStuck
            ? {
                errorCode: 'daemon_stuck',
                errorMessage: 'an earlier request still holds the session',
              }
            : undefined;
        const sample: Sample = skipped
          ? { round, ok: false, wallClockMs: 0, ...skipped }
          : await runTimedStep(scenario, step, ctx, round);
        if (measured) samples.set(id, [...(samples.get(id) ?? []), sample]);
      }
    }
  }
  return scenarios.flatMap((scenario) =>
    scenario.steps.map((step) =>
      buildMeasurement({
        id: `${scenario.id}/${step.id}`,
        scenario: scenario.id,
        label: step.args.join(' '),
        command: step.command,
        args: [...step.args],
        platform: 'ios',
        execMode: step.via === 'sdk-forced-tree' ? 'sdk' : 'standalone',
        samples: samples.get(`${scenario.id}/${step.id}`) ?? [],
        warmupDropped: cfg.warmup,
      }),
    ),
  );
}

// A stalled close or daemon stop must not keep the run, and its logs, from finishing.
const TEARDOWN_TIMEOUT_MS = 60_000;

/**
 * Returns the end of a run: save the logs, stop the session and the daemon within a deadline, save
 * the logs again with the teardown, and remove the state directory unless it is kept. It runs once,
 * so the interrupt handler and the normal finish can both call it.
 */
export function iosRunFinalizer(ctx: IosSuiteContext, keepArtifacts: boolean): () => void {
  let finalized = false;
  const saveLogs = (): void => {
    try {
      copyRawState(ctx);
    } catch (error) {
      log(`finalize: saving logs failed: ${(error as Error).message}`);
    }
  };
  const teardown = (args: string[], flags: string[]): void => {
    const result = invokeCli(args, flags, { timeoutMs: TEARDOWN_TIMEOUT_MS });
    if (!result.ok) log(`finalize: ${args.join(' ')} failed: ${result.stderr.trim().slice(-400)}`);
  };
  return () => {
    if (finalized) return;
    finalized = true;
    saveLogs();
    teardown(['close'], ['--state-dir', ctx.stateDir, '--session', SESSION]);
    teardown(['daemon', 'stop', '--clean'], ['--state-dir', ctx.stateDir]);
    saveLogs();
    if (!keepArtifacts) fs.rmSync(ctx.stateDir, { recursive: true, force: true });
  };
}

/** Copies daemon and session logs into the raw artifact; the daemon token file stays behind. */
function copyRawState(ctx: IosSuiteContext): void {
  const target = path.join(ctx.rawDir, 'state');
  fs.mkdirSync(target, { recursive: true });
  const daemonLog = path.join(ctx.stateDir, 'daemon.log');
  if (fs.existsSync(daemonLog)) fs.copyFileSync(daemonLog, path.join(target, 'daemon.log'));
  const sessions = path.join(ctx.stateDir, 'sessions');
  if (fs.existsSync(sessions))
    fs.cpSync(sessions, path.join(target, 'sessions'), { recursive: true });
}
