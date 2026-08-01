import path from 'node:path';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { executeMaestroPlan } from './engine.ts';
import {
  isMaestroControlCommandDescriptor,
  type MaestroEngineEvent,
  type MaestroEngineObserver,
  type MaestroRuntimePort,
} from './engine-types.ts';
import { parseMaestroProgram } from './program-ir-parser.ts';
import type {
  MaestroCommand,
  MaestroPlatform,
  MaestroProgram,
  MaestroSourceLocation,
} from './program-ir.ts';
import { createMaestroProgramLoader } from './program-loader.ts';
import { formatMaestroCommandProgress } from './progress.ts';
import {
  compileMaestroReplayPlan,
  evaluateMaestroReplayResume,
  resolveMaestroReplayStartIndex,
} from './replay-plan.ts';
import type { MaestroReplayPlan } from './replay-plan-types.ts';
import { matchesMaestroTypedSelector } from './runtime-target-policy.ts';
import { rankMaestroCandidates } from './runtime-target-ranking.ts';

const flowProgram = Symbol('maestroFlowProgram');
const failureCommand = Symbol('maestroFailureCommand');
const failurePlan = Symbol('maestroFailurePlan');

export type MaestroFlow = {
  readonly sourcePath: string;
  readonly name?: string;
  readonly appTarget?: string;
  readonly [flowProgram]: MaestroProgram;
};

export type MaestroActionEvent = {
  readonly action: string;
  readonly value?: string;
  readonly source: MaestroSourceLocation;
  readonly generation: number;
  readonly stepIndex: number;
  readonly stepTotal: number;
};

export type MaestroCompletedActionEvent = MaestroActionEvent & {
  readonly durationMs: number;
  readonly runtimeMetrics?: {
    hierarchyCaptures: number;
    screenshotCaptures: number;
    tapRetries: number;
  };
  readonly data?: Record<string, unknown>;
};

export type MaestroFailedAction = MaestroActionEvent & {
  readonly durationMs: number;
  readonly runtimeMetrics?: MaestroCompletedActionEvent['runtimeMetrics'];
  readonly error: unknown;
  readonly artifactPaths: readonly string[];
  readonly isControl: boolean;
  readonly redactions: readonly { name: string; value: string }[];
  readonly resume:
    | { readonly allowed: true; readonly from: number; readonly planDigest: string }
    | {
        readonly allowed: false;
        readonly from: number;
        readonly planDigest: string;
        readonly reason: string;
      };
  readonly [failureCommand]: MaestroEngineEvent['command'];
  readonly [failurePlan]: MaestroReplayPlan;
};

export type MaestroExecutionObserver = {
  actionStarted?(event: MaestroActionEvent): void;
  actionCompleted?(event: MaestroCompletedActionEvent): void;
  actionFailed?(event: MaestroFailedAction): void;
};

export type MaestroExecutionOptions = {
  readonly defaults?: Readonly<Record<string, string | number | boolean>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: MaestroPlatform;
  readonly target?: string;
  readonly runtimeHints?: Readonly<SessionRuntimeHints>;
  readonly from?: number;
  readonly planDigest?: string;
  readonly signal?: AbortSignal;
  readonly observer?: MaestroExecutionObserver;
};

export type MaestroExecutionOutcome =
  | {
      readonly ok: true;
      readonly replayed: number;
      readonly planDigest: string;
      readonly startIndex: number;
      readonly artifactPaths: string[];
      readonly warnings?: string[];
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly failure?: MaestroFailedAction;
    };

export function inspectMaestroFlow(source: string, sourcePath: string): MaestroFlow {
  const program = parseMaestroProgram(source, { sourcePath });
  return {
    sourcePath,
    name: program.config.name,
    appTarget: readStaticAppTarget(program),
    [flowProgram]: program,
  };
}

export async function executeMaestroFlow(
  flow: MaestroFlow,
  port: MaestroRuntimePort,
  options: MaestroExecutionOptions = {},
): Promise<MaestroExecutionOutcome> {
  let failed: MaestroFailedAction | undefined;
  try {
    const loader = createMaestroProgramLoader(path.dirname(flow.sourcePath));
    const plan = await compileMaestroReplayPlan(flow[flowProgram], {
      defaults: options.defaults,
      env: options.env,
      platform: options.platform,
      target: options.target,
      runtimeHints: options.runtimeHints,
      loadProgram: loader,
      signal: options.signal,
    });
    const startIndex = resolveMaestroReplayStartIndex(plan, {
      from: options.from,
      planDigest: options.planDigest,
    });
    const result = await executeMaestroPlan(plan, port, {
      defaults: options.defaults,
      env: options.env,
      platform: options.platform,
      target: options.target,
      loadProgram: loader,
      signal: options.signal,
      startIndex,
      observer: createObserver(plan, options.observer, (event) => {
        failed = event;
      }),
    });
    return {
      ok: true,
      replayed: plan.total - startIndex,
      planDigest: plan.digest,
      startIndex,
      artifactPaths: result.artifactPaths,
      ...(result.warnings ? { warnings: result.warnings } : {}),
    };
  } catch (error) {
    return { ok: false, error: failed?.error ?? error, ...(failed ? { failure: failed } : {}) };
  }
}

/**
 * Converts a failed execution into report-ready values while retaining
 * selector interpretation and ranking policy inside the Maestro package.
 */
export function collectMaestroFailureSuggestions(
  failure: MaestroFailedAction,
  snapshot: SnapshotState,
): ReadonlyArray<{
  readonly node: SnapshotNode;
  readonly basis: 'id' | 'label' | 'other';
}> {
  const query = suggestionQuery(failure[failureCommand]);
  const platform = failure[failurePlan].platform;
  if (!query || (platform !== 'android' && platform !== 'ios')) return [];
  return rankMaestroCandidates(snapshot, query.selector, platform, query.childOf).ranked.map(
    (node) => ({ node, basis: suggestionBasis(query.selector, node) }),
  );
}

function createObserver(
  plan: MaestroReplayPlan,
  observer: MaestroExecutionObserver | undefined,
  onFailure: (failure: MaestroFailedAction) => void,
): MaestroEngineObserver {
  return {
    commandStarted: (event) => observer?.actionStarted?.(actionView(event)),
    commandCompleted: (event) =>
      observer?.actionCompleted?.({
        ...actionView(event),
        durationMs: event.durationMs,
        runtimeMetrics: event.runtimeMetrics,
        data: event.data,
      }),
    commandFailed: (event) => {
      const resume = evaluateMaestroReplayResume(plan, {
        from: event.stepIndex,
        planDigest: plan.digest,
      });
      const failure: MaestroFailedAction = {
        ...actionView(event),
        durationMs: event.durationMs,
        error: event.error,
        artifactPaths: event.artifactPaths,
        isControl: isMaestroControlCommandDescriptor(event.command),
        redactions:
          event.command.kind === 'inputText' && event.command.text.length > 0
            ? [{ name: 'inputText.text', value: event.command.text }]
            : [],
        resume: resume.allowed
          ? { allowed: true, from: event.stepIndex, planDigest: plan.digest }
          : {
              allowed: false,
              from: event.stepIndex,
              planDigest: plan.digest,
              reason: resume.reason,
            },
        [failureCommand]: event.command,
        [failurePlan]: plan,
      };
      onFailure(failure);
      observer?.actionFailed?.(failure);
    },
  };
}

function actionView(event: MaestroEngineEvent): MaestroActionEvent {
  const progress = formatMaestroCommandProgress(event.command);
  return {
    action: progress.command,
    ...(progress.value ? { value: progress.value } : {}),
    source: event.source,
    generation: event.generation,
    stepIndex: event.stepIndex,
    stepTotal: event.stepTotal,
  };
}

function readStaticAppTarget(program: MaestroProgram): string | undefined {
  const candidates = [
    program.config.appId,
    ...[...(program.config.onFlowStart ?? []), ...program.commands]
      .filter((command) => command.kind === 'launchApp')
      .map((command) => (command.kind === 'launchApp' ? command.appId : undefined)),
  ];
  return candidates.find(isStaticAppTarget);
}

function isStaticAppTarget(value: string | undefined): value is string {
  return Boolean(value?.trim() && !value.includes('$') && !isDeepLinkTarget(value));
}

type SuggestionQuery = {
  selector: Extract<MaestroCommand, { kind: 'assertVisible' }>['target'];
  childOf?: Extract<MaestroCommand, { kind: 'tapOn' }>['childOf'];
};

function suggestionQuery(command: MaestroEngineEvent['command']): SuggestionQuery | undefined {
  switch (command.kind) {
    case 'tapOn':
      return command.target.space === 'target'
        ? { selector: command.target.selector, childOf: command.childOf }
        : undefined;
    case 'doubleTapOn':
    case 'longPressOn':
      return command.target.space === 'target' ? { selector: command.target.selector } : undefined;
    case 'assertVisible':
    case 'assertNotVisible':
      return { selector: command.target };
    case 'extendedWaitUntil':
      return command.visible
        ? { selector: command.visible }
        : command.notVisible
          ? { selector: command.notVisible }
          : undefined;
    case 'scrollUntilVisible':
      return { selector: command.element };
    case 'swipe':
      return command.gesture.kind === 'target' ? { selector: command.gesture.from } : undefined;
    default:
      return undefined;
  }
}

function suggestionBasis(
  selector: SuggestionQuery['selector'],
  node: SnapshotNode,
): 'id' | 'label' | 'other' {
  if (selector.id !== undefined) return 'id';
  if (
    selector.text !== undefined &&
    matchesMaestroTypedSelector(
      { ...node, label: undefined, value: undefined },
      { text: selector.text },
    )
  ) {
    return 'id';
  }
  return selector.text !== undefined || selector.label !== undefined ? 'label' : 'other';
}
