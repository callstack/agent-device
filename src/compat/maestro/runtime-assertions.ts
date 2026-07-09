import fs from 'node:fs';
import path from 'node:path';
import { getSnapshotReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import { tryParseSelectorChain } from '../../daemon/selectors.ts';
import type { DaemonResponse } from '../../daemon/types.ts';
import type { DaemonFailureResponse } from '../../daemon/handlers/response.ts';
import type { ReplayVarScope } from '../../replay/vars.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { Point, SnapshotState } from '../../kernel/snapshot.ts';
import { buildSnapshotDisplayLines } from '../../snapshot/snapshot-lines.ts';
import { sleep } from '../../utils/timeouts.ts';
import { pointForMaestroTapOnTarget } from './runtime-geometry.ts';
import {
  captureMaestroSnapshot,
  consumeMaestroRecoverableInteraction,
  errorResponse,
  rememberMaestroVisibleContext,
  readSnapshotState,
  type MaestroRecoverableSwipe,
  type MaestroRecoverableTap,
  type MaestroRuntimeInvoke,
  type ReplayBaseRequest,
} from './runtime-support.ts';
import {
  extractMaestroVisibleTextQuery,
  hasMaestroSelectorMatchInSnapshot,
  readMaestroSelectorPlatform,
  resolveMaestroNodeFromSnapshot,
  resolveVisibleMaestroNodeFromSnapshot,
} from './runtime-targets.ts';

const MAESTRO_ASSERTION_POLICY = {
  animationPollMs: 250,
  assertVisibleGraceMs: 1000,
  assertVisiblePollMs: 250,
  assertVisibleRetryTimeoutMs: 5000,
  assertNotVisiblePollMs: 250,
  defaultAssertNotVisibleTimeoutMs: 3000,
} as const;

type MaestroVisibilitySample =
  | { visible: true; response: DaemonResponse }
  | {
      visible: false;
      response: DaemonResponse;
      infrastructureFailure: boolean;
      missKind?: 'missing' | 'notVisible';
      snapshot?: SnapshotState;
    };

type MaestroVisibilityAssertionArgs = {
  selector: string;
  timeoutMs: number;
};

type MaestroRetryTapTarget = { kind: 'point'; point: Point } | { kind: 'text'; query: string };

type MaestroVisibleRecoveryFlag = 'retryTap' | 'retrySwipe';

type MaestroAssertionRuntimeParams = {
  baseReq: ReplayBaseRequest;
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
};

type MaestroAssertionRequestParams = MaestroAssertionRuntimeParams & {
  positionals: string[];
};

export async function invokeMaestroAssertVisible(
  params: MaestroAssertionRequestParams,
): Promise<DaemonResponse> {
  const args = readVisibilityAssertionArgs(params.positionals, {
    command: 'assertVisible',
    defaultTimeoutMs: 17000,
  });
  if (!args.ok) return args.response;

  const nativeWaitQuery = readNativeVisibleWaitQuery(params.baseReq, args.selector);
  if (nativeWaitQuery) {
    return await invokeNativeMaestroVisibleWaitWithSnapshotFallback(params, args, nativeWaitQuery);
  }

  return await invokeSnapshotMaestroAssertVisible(params, args);
}

async function invokeNativeMaestroVisibleWaitWithSnapshotFallback(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  nativeWaitQuery: string,
): Promise<DaemonResponse> {
  const nativeStartedAt = Date.now();
  const nativeResponse = await runNativeVisibleWait(params, args, nativeWaitQuery);
  if (nativeResponse.ok) {
    if (shouldVerifyNativeVisibleWait(params.baseReq)) {
      const sample = await readMaestroVisibilitySample(params, args.selector, 'assertVisible');
      if (!sample.visible) {
        const failedSample = handleFailedVisibleSample(
          params.baseReq,
          args,
          sample,
          nativeStartedAt,
        );
        if (failedSample.kind === 'return') return failedSample.response;
        return await invokeSnapshotMaestroAssertVisible(params, visibleAssertionRetryArgs(args));
      }
    }
    rememberMaestroVisibleContext(params.scope, args.selector);
    return visibleAssertionResponse(
      {
        ok: true,
        data: {
          selector: args.selector,
          nativeWait: true,
          query: nativeWaitQuery,
          response: nativeResponse.data,
        },
      },
      args.selector,
      nativeStartedAt,
    );
  }

  return await invokeSingleSnapshotMaestroAssertVisible(
    params,
    args,
    nativeResponse,
    nativeStartedAt,
  );
}

function shouldVerifyNativeVisibleWait(baseReq: ReplayBaseRequest): boolean {
  return baseReq.flags?.platform === 'android';
}

async function runNativeVisibleWait(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  nativeWaitQuery: string,
): Promise<DaemonResponse> {
  return await params.invoke({
    ...params.baseReq,
    command: 'wait',
    positionals: [nativeWaitQuery, String(args.timeoutMs)],
  });
}

async function invokeSnapshotMaestroAssertVisible(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
): Promise<DaemonResponse> {
  // Native wait/is cannot replace this loop: wait only proves existence, while
  // is requires unique resolution and does not apply Maestro overlay filtering.
  const startedAt = Date.now();
  const deadlineMs = args.timeoutMs + MAESTRO_ASSERTION_POLICY.assertVisibleGraceMs;
  let lastResponse: DaemonResponse | undefined;
  let lastSnapshot: SnapshotState | undefined;
  let capturedAfterDeadline = false;
  while (true) {
    const captureStartedAt = Date.now();
    const sample = await readMaestroVisibilitySample(params, args.selector, 'assertVisible');
    if (sample.visible) return visibleAssertionResponse(sample.response, args.selector, startedAt);
    lastResponse = sample.response;
    lastSnapshot = sample.snapshot ?? lastSnapshot;
    const failedSample = handleFailedVisibleSample(params.baseReq, args, sample, startedAt);
    if (failedSample.kind === 'return') return failedSample.response;

    const deadline = readVisibleAssertionDeadlineAction({
      captureStartedAt,
      capturedAfterDeadline,
      startedAt,
      deadlineMs,
    });
    if (deadline === 'capture-again') {
      capturedAfterDeadline = true;
      continue;
    }
    if (deadline === 'finish') break;
    await sleep(MAESTRO_ASSERTION_POLICY.assertVisiblePollMs);
  }

  const response =
    lastResponse ??
    errorResponse('COMMAND_FAILED', `Expected visible but did not match: ${args.selector}`, {
      selector: args.selector,
      timeoutMs: args.timeoutMs,
    });
  const recoveryResponse = await recoverFromAndroidVisibleMiss(params, args, lastSnapshot);
  if (recoveryResponse) return recoveryResponse;
  return withMaestroFailureSnapshotArtifacts(response, lastSnapshot, params.baseReq);
}

async function invokeSingleSnapshotMaestroAssertVisible(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  fallbackResponse: DaemonFailureResponse,
  startedAt: number,
): Promise<DaemonResponse> {
  const sample = await readMaestroVisibilitySample(params, args.selector, 'assertVisible');
  if (sample.visible) return visibleAssertionResponse(sample.response, args.selector, startedAt);
  const failedSample = handleFailedVisibleSample(params.baseReq, args, sample, startedAt);
  if (failedSample.kind === 'return') return failedSample.response;
  const recoveryResponse = await recoverFromAndroidVisibleMiss(params, args, sample.snapshot);
  if (recoveryResponse) return recoveryResponse;
  return withMaestroFailureSnapshotArtifacts(fallbackResponse, sample.snapshot, params.baseReq);
}

async function recoverFromAndroidVisibleMiss(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  snapshot: SnapshotState | undefined,
): Promise<DaemonResponse | null> {
  if (params.baseReq.flags?.platform !== 'android') return null;

  const recoverableInteraction = consumeMaestroRecoverableInteraction(params.scope);
  if (!recoverableInteraction) return null;
  if (recoverableInteraction.kind === 'tap') {
    return await retryRecentAndroidTapAfterVisibleMiss(
      params,
      args,
      snapshot,
      recoverableInteraction,
    );
  }
  return await retryRecentAndroidSwipeAfterVisibleMiss(params, args, recoverableInteraction);
}

async function retryRecentAndroidTapAfterVisibleMiss(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  snapshot: SnapshotState | undefined,
  recentTap: MaestroRecoverableTap,
): Promise<DaemonResponse | null> {
  if (!snapshot) return null;

  const retryTarget = resolveRecentTapTarget(params, snapshot, recentTap);
  if (!retryTarget.ok) return null;

  emitDiagnostic({
    level: 'info',
    phase: 'maestro_assert_visible_retry_tap',
    data: {
      selector: args.selector,
      tapSelector: recentTap.selector,
      originalPoint: recentTap.point,
      retryTarget: retryTarget.target,
      timeoutMs: MAESTRO_ASSERTION_POLICY.assertVisibleRetryTimeoutMs,
    },
  });

  const clickResponse = await invokeRecentTapRetry(params, retryTarget.target);
  if (!clickResponse.ok) return null;
  return await confirmVisibleAfterAndroidRecovery(params, args, 'retryTap');
}

async function retryRecentAndroidSwipeAfterVisibleMiss(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  recentSwipe: MaestroRecoverableSwipe,
): Promise<DaemonResponse | null> {
  emitDiagnostic({
    level: 'info',
    phase: 'maestro_assert_visible_retry_swipe',
    data: {
      selector: args.selector,
      swipePositionals: recentSwipe.positionals,
      timeoutMs: MAESTRO_ASSERTION_POLICY.assertVisibleRetryTimeoutMs,
    },
  });

  const swipeResponse = await invokeRecentSwipeRetry(params, recentSwipe);
  if (!swipeResponse.ok) return null;
  return await confirmVisibleAfterAndroidRecovery(params, args, 'retrySwipe');
}

async function confirmVisibleAfterAndroidRecovery(
  params: MaestroAssertionRuntimeParams,
  args: MaestroVisibilityAssertionArgs,
  recoveryFlag: MaestroVisibleRecoveryFlag,
): Promise<DaemonResponse> {
  const retryArgs = {
    ...args,
    timeoutMs: visibleAssertionRetryTimeoutMs(args.timeoutMs),
  };
  const nativeWaitQuery = readNativeVisibleWaitQuery(params.baseReq, retryArgs.selector);
  if (!nativeWaitQuery) return await invokeSnapshotMaestroAssertVisible(params, retryArgs);

  const retryStartedAt = Date.now();
  const nativeResponse = await runNativeVisibleWait(params, retryArgs, nativeWaitQuery);
  if (nativeResponse.ok) {
    rememberMaestroVisibleContext(params.scope, retryArgs.selector);
    return visibleAssertionResponse(
      {
        ok: true,
        data: {
          selector: retryArgs.selector,
          nativeWait: true,
          [recoveryFlag]: true,
          query: nativeWaitQuery,
          response: nativeResponse.data,
        },
      },
      retryArgs.selector,
      retryStartedAt,
    );
  }

  return await invokeSingleSnapshotMaestroAssertVisible(
    params,
    retryArgs,
    nativeResponse,
    retryStartedAt,
  );
}

function resolveRecentTapTarget(
  params: MaestroAssertionRuntimeParams,
  snapshot: SnapshotState,
  tap: MaestroRecoverableTap,
): { ok: true; target: MaestroRetryTapTarget } | { ok: false } {
  const platform = readMaestroSelectorPlatform(params.baseReq.flags);
  const frame = getSnapshotReferenceFrame(snapshot);
  const tapTarget = resolveMaestroNodeFromSnapshot(
    snapshot,
    tap.selector,
    tap.options ?? {},
    platform,
    frame,
    { promoteTapTarget: true },
  );
  if (tapTarget.ok) {
    return { ok: true, target: { kind: 'point', point: pointForMaestroTapOnTarget(tapTarget) } };
  }

  const query = extractMaestroVisibleTextQuery(tap.selector);
  if (!query || !snapshotContainsTextQuery(snapshot, query)) return { ok: false };
  return { ok: true, target: { kind: 'text', query } };
}

async function invokeRecentTapRetry(
  params: MaestroAssertionRuntimeParams,
  target: MaestroRetryTapTarget,
): Promise<DaemonResponse> {
  if (target.kind === 'text') {
    return await params.invoke({
      ...params.baseReq,
      command: 'find',
      positionals: [target.query, 'click'],
      flags: {
        ...params.baseReq.flags,
        findFirst: true,
        postGestureStabilization: true,
      },
    });
  }

  return await params.invoke({
    ...params.baseReq,
    command: 'click',
    positionals: [String(target.point.x), String(target.point.y)],
    flags: {
      ...params.baseReq.flags,
      postGestureStabilization: true,
    },
  });
}

async function invokeRecentSwipeRetry(
  params: MaestroAssertionRuntimeParams,
  swipe: MaestroRecoverableSwipe,
): Promise<DaemonResponse> {
  return await params.invoke({
    ...params.baseReq,
    command: 'swipe',
    positionals: swipe.positionals,
  });
}

function snapshotContainsTextQuery(snapshot: SnapshotState, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return snapshot.nodes.some((node) =>
    [node.label, node.value, node.identifier].some((value) =>
      value?.trim().toLowerCase().includes(needle),
    ),
  );
}

function handleFailedVisibleSample(
  baseReq: ReplayBaseRequest,
  args: MaestroVisibilityAssertionArgs,
  sample: Exclude<MaestroVisibilitySample, { visible: true }>,
  startedAt: number,
): { kind: 'continue' } | { kind: 'return'; response: DaemonResponse } {
  if (isReactNativeOverlayBlockingAssertion(sample.response)) {
    return { kind: 'return', response: sample.response };
  }
  if (shouldPassAlreadyPastLoading(baseReq, args.selector, sample.snapshot)) {
    return {
      kind: 'return',
      response: alreadyPastLoadingResponse(args.selector, args.timeoutMs, startedAt),
    };
  }
  return { kind: 'continue' };
}

function shouldPassAlreadyPastLoading(
  baseReq: ReplayBaseRequest,
  selector: string,
  snapshot: SnapshotState | undefined,
): boolean {
  return (
    baseReq.flags?.maestro?.allowAlreadyPastLoading === true &&
    snapshot !== undefined &&
    isAlreadyPastLoadingState(selector, snapshot)
  );
}

function readVisibleAssertionDeadlineAction(params: {
  captureStartedAt: number;
  capturedAfterDeadline: boolean;
  startedAt: number;
  deadlineMs: number;
}): 'wait' | 'capture-again' | 'finish' {
  const elapsedMs = Date.now() - params.startedAt;
  if (elapsedMs < params.deadlineMs) return 'wait';
  return shouldCaptureOnceAfterDeadline(
    params.capturedAfterDeadline,
    params.captureStartedAt,
    params.startedAt,
    params.deadlineMs,
  )
    ? 'capture-again'
    : 'finish';
}

function visibleAssertionRetryArgs(
  args: MaestroVisibilityAssertionArgs,
): MaestroVisibilityAssertionArgs {
  return {
    ...args,
    timeoutMs: visibleAssertionRetryTimeoutMs(args.timeoutMs),
  };
}

function visibleAssertionRetryTimeoutMs(timeoutMs: number): number {
  return Math.min(timeoutMs, MAESTRO_ASSERTION_POLICY.assertVisibleRetryTimeoutMs);
}

function isReactNativeOverlayBlockingAssertion(response: DaemonResponse): boolean {
  return (
    !response.ok &&
    response.error.code === 'COMMAND_FAILED' &&
    response.error.message.includes('React Native overlay')
  );
}

function readNativeVisibleWaitQuery(baseReq: ReplayBaseRequest, selector: string): string | null {
  if (baseReq.flags?.platform !== 'ios' && baseReq.flags?.platform !== 'android') return null;
  return extractMaestroVisibleTextQuery(selector);
}

function alreadyPastLoadingResponse(
  selector: string,
  timeoutMs: number,
  startedAt: number,
): DaemonResponse {
  return {
    ok: true,
    data: {
      selector,
      alreadyPastLoading: true,
      waitedMs: Date.now() - startedAt,
      timeoutMs,
    },
  };
}

function readVisibilityAssertionArgs(
  positionals: string[],
  options: { command: string; defaultTimeoutMs: number },
): { ok: true; selector: string; timeoutMs: number } | { ok: false; response: DaemonResponse } {
  const [selector, timeoutValue = String(options.defaultTimeoutMs)] = positionals;
  if (!selector) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', `${options.command} requires a selector.`),
    };
  }
  const timeoutMs = Number(timeoutValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `${options.command} timeout must be a non-negative number.`,
      ),
    };
  }
  return { ok: true, selector, timeoutMs };
}

async function readMaestroVisibilitySample(
  params: MaestroAssertionRuntimeParams,
  selector: string,
  command: string,
): Promise<MaestroVisibilitySample> {
  const response = await captureMaestroSnapshot(params);
  const sample = readMaestroVisibilitySampleFromResponse(params, selector, command, response);
  if (!shouldRetryAndroidRawVisibilitySample(params.baseReq, selector, command, sample)) {
    return sample;
  }

  const rawResponse = await captureMaestroSnapshot({ ...params, raw: true });
  return readMaestroVisibilitySampleFromResponse(params, selector, command, rawResponse);
}

function readMaestroVisibilitySampleFromResponse(
  params: Pick<MaestroAssertionRuntimeParams, 'baseReq' | 'scope'>,
  selector: string,
  command: string,
  response: DaemonResponse,
): MaestroVisibilitySample {
  if (!response.ok) return { visible: false, response, infrastructureFailure: true };
  const snapshot = readSnapshotState(response.data);
  if (!snapshot) {
    return {
      visible: false,
      response: errorResponse('COMMAND_FAILED', `Unable to read snapshot data for ${command}.`),
      infrastructureFailure: true,
    };
  }
  const platform = readMaestroSelectorPlatform(params.baseReq.flags);
  const target = resolveVisibleMaestroNodeFromSnapshot(
    snapshot,
    selector,
    platform,
    getSnapshotReferenceFrame(snapshot),
  );
  if (!target.ok) {
    const missKind = readAndroidMaestroMissKind(snapshot, selector, platform);
    return {
      visible: false,
      response: errorResponse('COMMAND_FAILED', target.message, { selector }),
      infrastructureFailure: false,
      ...(missKind ? { missKind } : {}),
      snapshot,
    };
  }
  rememberMaestroVisibleContext(params.scope, selector);
  return {
    visible: true,
    response: {
      ok: true,
      data: {
        selector,
        matches: target.matches,
        nodeIndex: target.node.index,
        nodeType: target.node.type,
        nodeLabel: target.node.label,
        nodeIdentifier: target.node.identifier,
        rect: target.rect,
      },
    },
  };
}

function shouldRetryAndroidRawVisibilitySample(
  baseReq: ReplayBaseRequest,
  selector: string,
  command: string,
  sample: MaestroVisibilitySample,
): boolean {
  return (
    command === 'assertVisible' &&
    baseReq.flags?.platform === 'android' &&
    !sample.visible &&
    !sample.infrastructureFailure &&
    sample.missKind === 'missing' &&
    isIdOnlyMaestroSelector(selector)
  );
}

function isIdOnlyMaestroSelector(selector: string): boolean {
  const chain = tryParseSelectorChain(selector);
  if (!chain) return false;
  return (
    chain.selectors.length > 0 &&
    chain.selectors.every(
      (entry) =>
        entry.terms.length > 0 &&
        entry.terms.every((term) => term.key === 'id' && typeof term.value === 'string'),
    )
  );
}

function readAndroidMaestroMissKind(
  snapshot: SnapshotState,
  selector: string,
  platform: string,
): 'missing' | 'notVisible' | undefined {
  if (platform !== 'android') return undefined;
  return hasMaestroSelectorMatchInSnapshot(snapshot, selector, platform) ? 'notVisible' : 'missing';
}

function isAlreadyPastLoadingState(selector: string, snapshot: SnapshotState): boolean {
  const query = normalizeLoadingText(extractMaestroVisibleTextQuery(selector));
  if (!isLoadingText(query)) return false;

  // Maestro extendedWaitUntil is commonly used as a loading gate. If the exact
  // loading label is already gone and the current surface has other content,
  // treat the flow as past the transient state instead of timing out on stale text.
  const currentTexts = snapshot.nodes
    .flatMap((node) => [node.label, node.value, node.identifier])
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeLoadingText(value));

  if (currentTexts.some((text) => text.includes('something went wrong'))) return false;
  return currentTexts.some((text) => text !== query && !isLoadingText(text));
}

function normalizeLoadingText(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/\u2026/g, '...') ?? ''
  );
}

function isLoadingText(value: string): boolean {
  return value === 'loading' || value === 'loading...';
}

function visibleAssertionResponse(
  response: DaemonResponse,
  selector: string,
  startedAt: number,
): DaemonResponse {
  if (!response.ok) return response;
  return {
    ok: true,
    data: {
      selector,
      ...response.data,
      waitedMs: Date.now() - startedAt,
    },
  };
}

function withMaestroFailureSnapshotArtifacts(
  response: DaemonResponse,
  snapshot: SnapshotState | undefined,
  baseReq: ReplayBaseRequest,
): DaemonResponse {
  if (response.ok || !snapshot) return response;
  const artifactsDir =
    typeof baseReq.flags?.artifactsDir === 'string' ? baseReq.flags.artifactsDir : undefined;
  if (!artifactsDir) return response;

  const artifactPaths = writeMaestroFailureSnapshotArtifacts(snapshot, artifactsDir);
  if (artifactPaths.length === 0) return response;
  return {
    ok: false,
    error: {
      ...response.error,
      details: {
        ...(response.error.details ?? {}),
        artifactPaths: uniqueStrings([
          ...readExistingArtifactPaths(response.error.details?.artifactPaths),
          ...artifactPaths,
        ]),
      },
    },
  };
}

function writeMaestroFailureSnapshotArtifacts(
  snapshot: SnapshotState,
  artifactsDir: string,
): string[] {
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    const jsonPath = path.join(artifactsDir, 'failure-snapshot.json');
    const textPath = path.join(artifactsDir, 'failure-snapshot.txt');
    fs.writeFileSync(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    const lines = buildSnapshotDisplayLines(snapshot.nodes, {
      summarizeTextSurfaces: true,
    }).map((line) => line.text);
    fs.writeFileSync(textPath, `${lines.join('\n')}\n`);
    return [jsonPath, textPath];
  } catch {
    return [];
  }
}

function readExistingArtifactPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shouldCaptureOnceAfterDeadline(
  capturedAfterDeadline: boolean,
  captureStartedAt: number,
  startedAt: number,
  deadlineMs: number,
): boolean {
  return !capturedAfterDeadline && captureStartedAt - startedAt < deadlineMs;
}

export async function invokeMaestroAssertNotVisible(
  params: MaestroAssertionRequestParams,
): Promise<DaemonResponse> {
  const args = readVisibilityAssertionArgs(params.positionals, {
    command: 'assertNotVisible',
    defaultTimeoutMs: MAESTRO_ASSERTION_POLICY.defaultAssertNotVisibleTimeoutMs,
  });
  if (!args.ok) return args.response;

  // Native is hidden intentionally fails for absent selectors. Maestro
  // assertNotVisible treats absent and overlay-blocked targets as passing, so
  // this loop shares the visible resolver instead of delegating to native is.
  const startedAt = Date.now();
  let hiddenSamples = 0;
  let lastVisibleResponse: DaemonResponse | undefined;
  while (Date.now() - startedAt <= args.timeoutMs) {
    const sample = await readMaestroVisibilitySample(params, args.selector, 'assertNotVisible');
    if (!sample.visible && sample.infrastructureFailure) return sample.response;
    if (sample.visible) {
      hiddenSamples = 0;
      lastVisibleResponse = sample.response;
    } else {
      hiddenSamples += 1;
      const waitedMs = Date.now() - startedAt;
      if (hiddenSamples >= 2 || waitedMs >= args.timeoutMs) {
        return {
          ok: true,
          data: {
            pass: true,
            selector: args.selector,
            stableSamples: hiddenSamples,
            waitedMs,
            timeoutMs: args.timeoutMs,
          },
        };
      }
    }
    await sleep(MAESTRO_ASSERTION_POLICY.assertNotVisiblePollMs);
  }
  if (hiddenSamples > 0) {
    return {
      ok: true,
      data: {
        pass: true,
        selector: args.selector,
        stableSamples: hiddenSamples,
        waitedMs: Date.now() - startedAt,
        timeoutMs: args.timeoutMs,
      },
    };
  }
  return errorResponse('COMMAND_FAILED', `Expected not visible but matched: ${args.selector}`, {
    selector: args.selector,
    timeoutMs: args.timeoutMs,
    lastResponse: lastVisibleResponse,
  });
}

export async function invokeMaestroWaitForAnimationToEnd(
  params: MaestroAssertionRequestParams,
): Promise<DaemonResponse> {
  const timeoutMs = Number(params.positionals[0] ?? 15000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return errorResponse('INVALID_ARGS', 'waitForAnimationToEnd timeout must be a number.');
  }
  // There is no native wait/is equivalent for "animation has ended"; this is
  // snapshot stability polling by design.
  const startedAt = Date.now();
  let previousSignature: string | undefined;
  let lastResponse: DaemonResponse | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await captureMaestroSnapshot(params);
    const poll = readAnimationPollResult(response, previousSignature, timeoutMs);
    if (poll.done) return poll.response;
    previousSignature = poll.signature ?? previousSignature;
    lastResponse = response;
    await sleep(MAESTRO_ASSERTION_POLICY.animationPollMs);
  }

  return lastResponse?.ok === false
    ? lastResponse
    : { ok: true, data: { stable: false, timeoutMs } };
}

function readAnimationPollResult(
  response: DaemonResponse,
  previousSignature: string | undefined,
  timeoutMs: number,
): { done: true; response: DaemonResponse } | { done: false; signature?: string } {
  const signature = readSnapshotStabilitySignature(response);
  if (!response.ok) return { done: false };
  if (!signature) return { done: true, response };
  if (previousSignature === signature) {
    return { done: true, response: { ok: true, data: { stable: true, timeoutMs } } };
  }
  return { done: false, signature };
}

function readSnapshotStabilitySignature(response: DaemonResponse): string | null {
  if (!response.ok) return null;
  const snapshot = readSnapshotState(response.data);
  return snapshot ? snapshotStabilitySignature(snapshot) : null;
}

function snapshotStabilitySignature(snapshot: SnapshotState): string {
  return JSON.stringify(
    snapshot.nodes.map((node) => ({
      index: node.index,
      parentIndex: node.parentIndex,
      type: node.type,
      identifier: node.identifier,
      label: node.label,
      value: node.value,
      rect: node.rect
        ? {
            x: Math.round(node.rect.x),
            y: Math.round(node.rect.y),
            width: Math.round(node.rect.width),
            height: Math.round(node.rect.height),
          }
        : undefined,
    })),
  );
}
