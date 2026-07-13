import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { getRequestSignal } from '../../request/cancel.ts';
import { emitRequestProgress, readReplayTestActionProgress } from '../../request/progress.ts';
import {
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
} from '../../replay/vars.ts';
import { summarizeSnapshotTimingSamples } from '../../snapshot-diagnostics.ts';
import { createDaemonMaestroRuntimePort } from '../../compat/maestro/daemon-runtime-port.ts';
import { executeMaestroPlan } from '../../compat/maestro/engine.ts';
import { formatMaestroCommandProgress } from '../../compat/maestro/progress.ts';
import { parseMaestroProgram } from '../../compat/maestro/program-ir-parser.ts';
import { createMaestroProgramLoader } from '../../compat/maestro/program-loader.ts';
import {
  compileMaestroReplayPlan,
  resolveMaestroReplayStartIndex,
} from '../../compat/maestro/replay-plan.ts';
import type { MaestroEngineEvent } from '../../compat/maestro/engine-types.ts';
import type { MaestroPlatform } from '../../compat/maestro/program-ir.ts';
import type { MaestroReplayPlan } from '../../compat/maestro/replay-plan-types.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { ReplayCommandResult } from '../../contracts/replay.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { buildReplayBuiltinVars } from './session-replay-vars.ts';
import {
  buildTypedMaestroFailureResponse,
  type MaestroFailedEngineEvent,
} from './session-replay-maestro-failure.ts';
import { resolveEffectiveOpenRuntimeHints } from './session-runtime.ts';

export async function runTypedMaestroReplayFile(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, invoke } = params;
  const requestedPath = req.positionals?.[0];
  if (!requestedPath) return errorResponse('INVALID_ARGS', 'replay requires a path');
  if (req.flags?.saveScript !== undefined) {
    return errorResponse(
      'INVALID_ARGS',
      'Maestro YAML does not support --save-script; ADR 0012 repair recording applies only to .ad scripts.',
    );
  }
  const startedAt = Date.now();
  let failedEvent: MaestroFailedEngineEvent | undefined;
  let plan: MaestroReplayPlan | undefined;
  let snapshotStart = 0;
  try {
    const filePath = SessionStore.expandHome(requestedPath, req.meta?.cwd);
    const program = parseMaestroProgram(fs.readFileSync(filePath, 'utf8'), {
      sourcePath: filePath,
    });
    const sessionDevice = sessionStore.get(sessionName)?.device;
    const platform = resolveMaestroPlatform(req, sessionDevice);
    const target = resolveMaestroTarget(req, sessionDevice);
    const runtimeHints = sessionDevice
      ? resolveEffectiveOpenRuntimeHints({ req, sessionStore, sessionName, device: sessionDevice })
      : req.runtime;
    const defaults = {
      ...buildReplayBuiltinVars({
        req,
        sessionName,
        metadata: {},
        resolvedPath: filePath,
      }),
      AD_PLATFORM: platform,
      AD_TARGET: target,
    };
    const env = {
      ...collectReplayShellEnv(readReplayShellEnvSource(req.flags?.replayShellEnv)),
      ...parseReplayCliEnvEntries(readReplayCliEnvEntries(req.flags?.replayEnv)),
    };
    const signal = getRequestSignal(req.meta?.requestId);
    const loadProgram = createMaestroProgramLoader(path.dirname(filePath));
    plan = await compileMaestroReplayPlan(program, {
      defaults,
      env,
      platform,
      target,
      runtimeHints,
      loadProgram,
      signal,
    });
    const startIndex = resolveMaestroReplayStartIndex(plan, {
      from: req.flags?.replayFrom,
      planDigest: req.flags?.replayPlanDigest,
    });
    const { command: _command, positionals: _positionals, ...requestBase } = req;
    const executionRuntime = req.runtime ?? runtimeHints;
    const baseReq =
      executionRuntime === undefined
        ? requestBase
        : { ...requestBase, runtime: executionRuntime };
    const port = createDaemonMaestroRuntimePort({
      baseReq,
      invoke,
      platform,
      sourcePath: filePath,
      dependencies: {
        now: Date.now,
        sleep: async (milliseconds, abortSignal) => {
          await sleep(milliseconds, undefined, { signal: abortSignal });
        },
      },
    });
    snapshotStart = sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.length ?? 0;
    const result = await executeMaestroPlan(plan, port, {
      defaults,
      env,
      platform,
      target,
      loadProgram,
      signal,
      startIndex,
      observer: {
        commandStarted: (event) => {
          emitMaestroProgress(filePath, event);
        },
        commandFailed: (event) => {
          failedEvent = event;
        },
      },
    });
    const samples =
      sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.slice(snapshotStart) ?? [];
    const snapshotDiagnostics = summarizeSnapshotTimingSamples(samples);
    const replayed = plan.total - startIndex;
    return {
      ok: true,
      data: {
        replayed,
        healed: 0,
        session: sessionName,
        artifactPaths: result.artifactPaths,
        ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
        message: replaySuccessMessage(replayed, Date.now() - startedAt),
      } satisfies ReplayCommandResult,
    };
  } catch (error) {
    const normalizedError = normalizeError(error);
    if (failedEvent && plan) {
      const samples =
        sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.slice(snapshotStart) ?? [];
      return await buildTypedMaestroFailureResponse({
        error: normalizedError,
        event: failedEvent,
        plan,
        replayPath: SessionStore.expandHome(requestedPath, req.meta?.cwd),
        req,
        sessionName,
        sessionStore,
        logPath,
        snapshotDiagnostics: summarizeSnapshotTimingSamples(samples),
      });
    }
    return errorResponse(normalizedError.code, normalizedError.message, {
      ...(normalizedError.details ?? {}),
      ...(failedEvent
        ? {
            replaySource: failedEvent.source,
            replayStep: failedEvent.stepIndex,
            replayStepTotal: failedEvent.stepTotal,
          }
        : {}),
    });
  }
}

export function isTypedMaestroReplay(req: DaemonRequest, filePath: string): boolean {
  return (
    req.flags?.replayBackend === 'maestro' &&
    (path.extname(filePath) === '.yaml' || path.extname(filePath) === '.yml')
  );
}

function resolveMaestroPlatform(
  req: DaemonRequest,
  sessionDevice: DeviceInfo | undefined,
): Extract<MaestroPlatform, 'android' | 'ios'> {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  if (sessionDevice?.platform === 'android') return 'android';
  if (sessionDevice?.platform === 'apple' && sessionDevice.appleOs === 'ios') return 'ios';
  throw new AppError(
    'INVALID_ARGS',
    'Maestro replay requires --platform android|ios or an active mobile session.',
  );
}

function resolveMaestroTarget(req: DaemonRequest, sessionDevice: DeviceInfo | undefined): string {
  return typeof req.flags?.target === 'string'
    ? req.flags.target
    : (sessionDevice?.target ?? 'mobile');
}

function emitMaestroProgress(file: string, event: MaestroEngineEvent): void {
  const progress = readReplayTestActionProgress();
  if (!progress) return;
  const formatted = formatMaestroCommandProgress(event.command);
  emitRequestProgress({
    type: 'replay-test',
    ...progress,
    file: progress.file || file,
    status: 'progress',
    stepIndex: event.stepIndex,
    stepTotal: event.stepTotal,
    stepCommand: formatted.command,
    ...(formatted.value ? { stepValue: formatted.value } : {}),
  });
}

function replaySuccessMessage(replayed: number, wallClockMs: number): string {
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${(wallClockMs / 1_000).toFixed(1)}s`;
}
