import { getSnapshotReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import type { DaemonInvokeFn, DaemonResponse } from '../../daemon/types.ts';
import {
  pointFromPercentInFrame,
  type GestureReferenceFrame,
  type ScrollDirection,
} from '../../contracts/scroll-gesture.ts';
import type { ReplayVarScope } from '../../replay/vars.ts';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { sleep } from '../../utils/timeouts.ts';
import { invokeMaestroClickPoint } from './runtime-click.ts';
import { pointForMaestroTapOnTarget, swipeCoordinatesFromTarget } from './runtime-geometry.ts';
import {
  captureMaestroSnapshot,
  clearMaestroRecoverableInteraction,
  clearMaestroVisibleContext,
  errorResponse,
  readMaestroVisibleContext,
  readSnapshotState,
  rememberMaestroRecoverableInteraction,
  type FailedDaemonResponse,
  type MaestroRuntimeInvoke,
  type ReplayBaseRequest,
} from './runtime-support.ts';
import {
  extractMaestroVisibleTextQuery,
  readMaestroSelectorPlatform,
  resolveMaestroFuzzyTextNodeFromSnapshot,
  resolveMaestroNodeFromSnapshot,
  resolveVisibleMaestroNodeFromSnapshot,
  type MaestroPreferredContext,
  type MaestroSnapshotTarget,
  type MaestroTapOnOptions,
} from './runtime-targets.ts';

const MAESTRO_INTERACTION_POLICY = {
  scrollUntilVisibleProbeMs: 500,
  tapOnRetryMs: 250,
  tapOnTimeoutMs: 30000,
  optionalTapOnTimeoutMs: 3000,
} as const;

type MaestroScrollUntilVisibleParams = {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: MaestroRuntimeInvoke;
};

type MaestroTapOnParams = {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
};

type MaestroScreenSwipeResolution =
  | {
      ok: true;
      start: { x: number; y: number };
      end: { x: number; y: number };
      durationMs?: string;
    }
  | { ok: false; response: DaemonResponse };

type ResolvedMaestroInteractionTarget = MaestroSnapshotTarget;

export async function invokeMaestroScrollUntilVisible(
  params: MaestroScrollUntilVisibleParams,
): Promise<DaemonResponse> {
  const [selector, timeoutValue = '5000', direction = 'down'] = params.positionals;
  if (!selector) {
    return errorResponse('INVALID_ARGS', 'scrollUntilVisible requires a selector.');
  }
  const timeoutMs = Number(timeoutValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return errorResponse('INVALID_ARGS', 'scrollUntilVisible timeout must be a positive number.');
  }
  const fuzzyTextQuery = extractMaestroVisibleTextQuery(selector);
  const attempts = Math.max(
    1,
    Math.ceil(timeoutMs / MAESTRO_INTERACTION_POLICY.scrollUntilVisibleProbeMs),
  );
  let lastWaitResponse: FailedDaemonResponse | null = null;

  for (let index = 0; index < attempts; index += 1) {
    const probeResponse = await probeMaestroScrollVisibility(
      params,
      selector,
      fuzzyTextQuery,
      scrollProbeMs(timeoutMs, index),
    );
    if (probeResponse.ok) return probeResponse;
    lastWaitResponse = probeResponse;

    if (index === attempts - 1) break;

    const scrollResponse = await params.invoke({
      ...params.baseReq,
      command: 'scroll',
      positionals: [direction],
    });
    if (!scrollResponse.ok) return scrollResponse;
  }

  return withMaestroScrollTimeoutContext(lastWaitResponse, selector, timeoutMs);
}

export async function invokeMaestroTapPointPercent(params: {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: DaemonInvokeFn;
  scope?: ReplayVarScope;
}): Promise<DaemonResponse> {
  const [xValue, yValue] = params.positionals;
  const xPercent = Number(xValue);
  const yPercent = Number(yValue);
  if (!Number.isFinite(xPercent) || !Number.isFinite(yPercent)) {
    return errorResponse('INVALID_ARGS', 'tapOn percentage point requires numeric x/y values.');
  }

  const snapshotResponse = await captureMaestroSnapshot(params);
  if (!snapshotResponse.ok) return snapshotResponse;

  const snapshot = readSnapshotState(snapshotResponse.data);
  if (!snapshot) {
    return errorResponse(
      'COMMAND_FAILED',
      'Unable to read snapshot data for Maestro percentage point tap.',
    );
  }

  const frame = getSnapshotReferenceFrame(snapshot);
  if (!frame) {
    return errorResponse(
      'COMMAND_FAILED',
      'Unable to resolve screen size for Maestro percentage point tap.',
    );
  }

  const point = pointFromPercentInFrame(frame, xPercent, yPercent);
  const response = await invokeMaestroClickPoint({ ...params, point });
  if (response.ok) clearMaestroRecoverableInteraction(params.scope);
  return response;
}

export async function invokeMaestroSwipeScreen(params: {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
}): Promise<DaemonResponse> {
  const presetResponse = await maybeInvokeMaestroDirectionalSwipePreset(params);
  if (presetResponse) return presetResponse;
  const swipe = await resolveMaestroScreenSwipe(params);
  if (!swipe.ok) return swipe.response;

  return await invokeSwipeGesture(params, swipe, swipe.durationMs);
}

async function maybeInvokeMaestroDirectionalSwipePreset(params: {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
}): Promise<DaemonResponse | undefined> {
  const [mode, direction, durationMs] = params.positionals;
  if (mode !== 'direction') return undefined;
  if (!isMaestroSwipeDirection(direction)) {
    return errorResponse(
      'INVALID_ARGS',
      'Maestro swipe direction must be UP, DOWN, LEFT, or RIGHT.',
    );
  }
  const input = {
    kind: 'swipe',
    preset: direction,
    ...(durationMs === undefined ? {} : { durationMs: Number(durationMs) }),
  };
  const response = await params.invoke({
    ...params.baseReq,
    command: 'gesture',
    positionals: [],
    input,
  });
  if (response.ok) {
    rememberMaestroRecoverableInteraction(params.scope, {
      kind: 'swipe',
      command: 'gesture',
      input,
    });
  }
  return response;
}

export async function invokeMaestroTapOn(params: MaestroTapOnParams): Promise<DaemonResponse> {
  const [selector, rawOptions] = params.positionals;
  if (!selector) {
    return errorResponse('INVALID_ARGS', 'tapOn requires a selector.');
  }
  const options = readMaestroTapOnOptions(rawOptions);
  if (!options.ok) return options.response;
  const startedAt = Date.now();
  const timeoutMs = maestroTapOnTimeoutMs(params);
  let lastResponse: DaemonResponse | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const attempt = await attemptMaestroTapOn(params, selector, options.value ?? {});
    if (!attempt.retry) return attempt.response;
    lastResponse = attempt.response;
    await sleep(MAESTRO_INTERACTION_POLICY.tapOnRetryMs);
  }

  return maestroTapOnTimeoutResponse(params, selector, lastResponse);
}

export async function invokeMaestroSwipeOn(params: {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
}): Promise<DaemonResponse> {
  const [selector, direction = 'up', durationMs] = params.positionals;
  if (!selector) return errorResponse('INVALID_ARGS', 'swipe.label requires a label selector.');
  const target = await resolveMaestroInteractionTarget(params, selector, {}, 'swipe.label', {
    promoteTapTarget: false,
  });
  if (!target.ok) return target.response;
  const swipe = swipeCoordinatesFromTarget(target.target, direction);
  if (!swipe.ok) return errorResponse('INVALID_ARGS', swipe.message);
  return await invokeSwipeGesture(params, swipe, durationMs);
}

async function invokeSwipeGesture(
  params: {
    baseReq: ReplayBaseRequest;
    invoke: MaestroRuntimeInvoke;
    scope?: ReplayVarScope;
  },
  swipe: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  },
  durationMs: string | undefined,
): Promise<DaemonResponse> {
  const input = {
    from: swipe.start,
    to: swipe.end,
    ...(durationMs === undefined ? {} : { durationMs: Number(durationMs) }),
  };
  const response = await params.invoke({
    ...params.baseReq,
    command: 'swipe',
    positionals: [],
    input,
  });
  if (response.ok) {
    rememberMaestroRecoverableInteraction(params.scope, {
      kind: 'swipe',
      command: 'swipe',
      input,
    });
  }
  return response;
}

async function resolveMaestroScreenSwipe(params: {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
}): Promise<MaestroScreenSwipeResolution> {
  const frame = await captureFrameForMaestroScreenSwipe(params);
  if (!frame) {
    return {
      ok: false,
      response: errorResponse('COMMAND_FAILED', 'Unable to resolve screen size for Maestro swipe.'),
    };
  }

  const [mode, ...args] = params.positionals;
  if (mode === 'percent') {
    return resolvePercentScreenSwipe(args, frame);
  }
  return {
    ok: false,
    response: errorResponse('INVALID_ARGS', 'Maestro screen swipe requires direction or percent.'),
  };
}

async function captureFrameForMaestroScreenSwipe(params: {
  baseReq: ReplayBaseRequest;
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
}): Promise<GestureReferenceFrame | undefined> {
  const snapshotResponse = await captureMaestroSnapshot(params);
  if (!snapshotResponse.ok) return undefined;
  const snapshot = readSnapshotState(snapshotResponse.data);
  return getSnapshotReferenceFrame(snapshot);
}

function isMaestroSwipeDirection(direction: string | undefined): direction is ScrollDirection {
  return (
    direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right'
  );
}

function resolvePercentScreenSwipe(
  args: string[],
  frame: GestureReferenceFrame,
): MaestroScreenSwipeResolution {
  const [startX, startY, endX, endY, durationMs] = args;
  const values = [startX, startY, endX, endY].map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'Maestro percentage swipe requires numeric points.'),
    };
  }
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  return {
    ok: true,
    start: pointFromPercentInFrame(frame, x1, y1),
    end: pointFromPercentInFrame(frame, x2, y2),
    durationMs,
  };
}

async function probeMaestroScrollVisibility(
  params: MaestroScrollUntilVisibleParams,
  selector: string,
  fuzzyTextQuery: string | null,
  probeMs: number,
): Promise<DaemonResponse> {
  const waitResponse = await params.invoke({
    ...params.baseReq,
    command: 'wait',
    positionals: [selector, String(probeMs)],
  });
  if (waitResponse.ok || !fuzzyTextQuery) return waitResponse;

  const fuzzyResponse = await params.invoke({
    ...params.baseReq,
    command: 'find',
    positionals: [fuzzyTextQuery, 'wait', String(probeMs)],
  });
  return fuzzyResponse;
}

function scrollProbeMs(timeoutMs: number, index: number): number {
  return Math.min(
    MAESTRO_INTERACTION_POLICY.scrollUntilVisibleProbeMs,
    Math.max(1, timeoutMs - index * MAESTRO_INTERACTION_POLICY.scrollUntilVisibleProbeMs),
  );
}

function maestroTapOnTimeoutMs(params: MaestroTapOnParams): number {
  return params.baseReq.flags?.maestro?.optional === true
    ? MAESTRO_INTERACTION_POLICY.optionalTapOnTimeoutMs
    : MAESTRO_INTERACTION_POLICY.tapOnTimeoutMs;
}

function maestroTapOnTimeoutResponse(
  params: MaestroTapOnParams,
  selector: string,
  lastResponse: DaemonResponse | undefined,
): DaemonResponse {
  if (params.baseReq.flags?.maestro?.optional === true) {
    return { ok: true, data: { skipped: true, optional: true, selector } };
  }
  return (
    lastResponse ?? errorResponse('COMMAND_FAILED', `tapOn timed out for selector: ${selector}`)
  );
}

async function attemptMaestroTapOn(
  params: MaestroTapOnParams,
  selector: string,
  options: MaestroTapOnOptions,
): Promise<
  { retry: false; response: DaemonResponse } | { retry: true; response: FailedDaemonResponse }
> {
  const fuzzyTextQuery = extractMaestroVisibleTextQuery(selector);
  const attempt = await invokeMaestroResolvedTapOn(params, selector, options);
  if (attempt.response.ok) return { retry: false, response: attempt.response };
  if (attempt.targetResolved && fuzzyTextQuery) {
    return await invokeMaestroFuzzyTapOn(params, fuzzyTextQuery);
  }
  return { retry: true, response: attempt.response };
}

async function invokeMaestroResolvedTapOn(
  params: MaestroTapOnParams,
  selector: string,
  options: MaestroTapOnOptions,
): Promise<{ response: DaemonResponse; targetResolved: boolean }> {
  const target = await resolveMaestroInteractionTarget(params, selector, options, 'tapOn', {
    promoteTapTarget: true,
  });
  if (!target.ok) return { response: target.response, targetResolved: false };
  return await clickMaestroResolvedTarget(params, selector, target.target, options);
}

async function clickMaestroResolvedTarget(
  params: MaestroTapOnParams,
  selector: string,
  target: ResolvedMaestroInteractionTarget,
  options: MaestroTapOnOptions,
): Promise<{ response: DaemonResponse; targetResolved: true }> {
  const point = pointForMaestroTapOnTarget(target);
  emitDiagnostic({
    level: 'debug',
    phase: 'maestro_tap_target',
    data: {
      selector,
      node: {
        index: target.node.index,
        type: target.node.type,
        label: target.node.label,
        value: target.node.value,
        identifier: target.node.identifier,
        visibleToUser: target.node.visibleToUser,
      },
      rect: target.rect,
      point,
    },
  });
  const response = await invokeMaestroClickPoint({ ...params, point });
  if (response.ok) {
    clearMaestroVisibleContext(params.scope);
    rememberMaestroRecoverableInteraction(params.scope, {
      kind: 'tap',
      selector,
      point,
      options: { ...options },
    });
  }
  return {
    response,
    targetResolved: true,
  };
}

async function invokeMaestroFuzzyTapOn(
  params: MaestroTapOnParams,
  query: string,
): Promise<
  { retry: false; response: DaemonResponse } | { retry: true; response: FailedDaemonResponse }
> {
  const findResponse = await params.invoke({
    ...params.baseReq,
    command: 'find',
    positionals: [query, 'click'],
    flags: {
      ...params.baseReq.flags,
      findFirst: true,
      postGestureStabilization: true,
    },
  });
  emitDiagnostic({
    level: findResponse.ok ? 'info' : 'debug',
    phase: 'maestro_fuzzy_tap_fallback',
    data: {
      query,
      ok: findResponse.ok,
    },
  });
  if (findResponse.ok) {
    clearMaestroRecoverableInteraction(params.scope);
    return { retry: false, response: findResponse };
  }
  return { retry: true, response: findResponse };
}

async function resolveMaestroInteractionTarget(
  params: {
    baseReq: ReplayBaseRequest;
    invoke: MaestroRuntimeInvoke;
    scope?: ReplayVarScope;
  },
  selector: string,
  options: MaestroTapOnOptions,
  commandLabel: string,
  resolutionOptions: { promoteTapTarget: boolean },
): Promise<
  | { ok: true; target: ResolvedMaestroInteractionTarget; snapshot: SnapshotState }
  | { ok: false; response: DaemonResponse }
> {
  const snapshotResponse = await captureMaestroSnapshot({ ...params, raw: true });
  return resolveMaestroInteractionTargetFromResponse(
    params,
    selector,
    options,
    commandLabel,
    resolutionOptions,
    snapshotResponse,
  );
}

function resolveMaestroInteractionTargetFromResponse(
  params: {
    baseReq: ReplayBaseRequest;
    scope?: ReplayVarScope;
  },
  selector: string,
  options: MaestroTapOnOptions,
  commandLabel: string,
  resolutionOptions: { promoteTapTarget: boolean },
  snapshotResponse: DaemonResponse,
):
  | { ok: true; target: ResolvedMaestroInteractionTarget; snapshot: SnapshotState }
  | { ok: false; response: DaemonResponse } {
  if (!snapshotResponse.ok) return { ok: false, response: snapshotResponse };
  const snapshot = readSnapshotState(snapshotResponse.data);
  if (!snapshot) {
    return {
      ok: false,
      response: errorResponse(
        'COMMAND_FAILED',
        `Unable to read snapshot data for ${commandLabel}.`,
      ),
    };
  }

  const frame = getSnapshotReferenceFrame(snapshot);
  const platform = readMaestroSelectorPlatform(params.baseReq.flags);
  const preferredContext = resolvePreferredMaestroContext(params, snapshot, platform, frame);
  const resolution = resolveMaestroNodeFromSnapshot(snapshot, selector, options, platform, frame, {
    ...resolutionOptions,
    preferredContext,
    requireOnScreen: true,
  });
  if (!resolution.ok) {
    const fuzzyTextQuery = extractMaestroVisibleTextQuery(selector);
    if (fuzzyTextQuery) {
      const fuzzyResolution = resolveMaestroFuzzyTextNodeFromSnapshot(
        snapshot,
        fuzzyTextQuery,
        platform,
        frame,
        { ...resolutionOptions, preferredContext, requireOnScreen: true },
      );
      if (fuzzyResolution.ok) {
        return {
          ok: true,
          target: {
            node: fuzzyResolution.node,
            rect: fuzzyResolution.rect,
            frame,
          },
          snapshot,
        };
      }
    }
  }
  if (!resolution.ok) {
    return {
      ok: false,
      response: errorResponse('ELEMENT_NOT_FOUND', resolution.message, {
        selector,
        options,
        command: commandLabel,
      }),
    };
  }
  return {
    ok: true,
    target: {
      node: resolution.node,
      rect: resolution.rect,
      frame,
    },
    snapshot,
  };
}

function resolvePreferredMaestroContext(
  params: { baseReq: ReplayBaseRequest; scope?: ReplayVarScope },
  snapshot: NonNullable<ReturnType<typeof readSnapshotState>>,
  platform: ReturnType<typeof readMaestroSelectorPlatform>,
  frame: ReturnType<typeof getSnapshotReferenceFrame>,
): MaestroPreferredContext | undefined {
  const context = readMaestroVisibleContext(params.scope);
  if (!context) return undefined;
  const target = resolveVisibleMaestroNodeFromSnapshot(snapshot, context.selector, platform, frame);
  if (!target.ok) return undefined;
  emitDiagnostic({
    level: 'debug',
    phase: 'maestro_preferred_context',
    data: {
      selector: context.selector,
      node: {
        index: target.node.index,
        type: target.node.type,
        label: target.node.label,
        value: target.node.value,
        identifier: target.node.identifier,
      },
      rect: target.rect,
    },
  });
  return { node: target.node, rect: target.rect };
}

function readMaestroTapOnOptions(
  rawOptions: string | undefined,
): { ok: true; value: MaestroTapOnOptions | null } | { ok: false; response: DaemonResponse } {
  if (!rawOptions) return { ok: true, value: null };
  try {
    const value = JSON.parse(rawOptions) as MaestroTapOnOptions;
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'tapOn runtime options must be valid JSON.'),
    };
  }
}

function withMaestroScrollTimeoutContext(
  response: FailedDaemonResponse | null,
  selector: string,
  timeoutMs: number,
): DaemonResponse {
  if (!response) {
    return errorResponse(
      'COMMAND_FAILED',
      `scrollUntilVisible timed out after ${timeoutMs}ms for selector: ${selector}`,
    );
  }
  return {
    ok: false,
    error: {
      ...response.error,
      message: `scrollUntilVisible timed out after ${timeoutMs}ms for selector: ${selector}. Last wait: ${response.error.message}`,
    },
  };
}
