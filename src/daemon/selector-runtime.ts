import { waitObservesDevice } from '@agent-device/contracts/wait-runtime-plan';
import { parseWaitPositionals } from '../core/wait-positionals.ts';
import type { WaitParsed } from '../core/wait-positionals.ts';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { queryAppleRunnerSelector } from '../platforms/apple/core/runner-selector-query.ts';
import type { AppleRunnerRequestOptions } from './apple-runner-options.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { errorResponse } from './handlers/response.ts';
import { markSessionPartialRefsIssued, resolveRefStalenessWarning } from './session-snapshot.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from './handlers/snapshot-session.ts';
import {
  checkElementTargetArgs,
  checkGetFormat,
  checkIsArgs,
  checkWaitText,
  checkFindArgs,
  isReadOnlyFindAction,
} from '@agent-device/selectors';
import { refSnapshotFlagGuardResponse } from './handlers/interaction-flags.ts';
import { parseVersionedRefPositional } from './handlers/interaction-touch-targets.ts';
import {
  describeAndroidEscapeSurface,
  detectAndroidEscapeSurface,
} from './handlers/interaction-android-escape.ts';
import {
  buildFindRecordResult,
  buildGetRecordResult,
  recordIfSession,
  stripResolutionPayload,
  stripSelectorChain,
  toDaemonFindData,
  toDaemonGetData,
  toDaemonWaitData,
} from './selector-recording.ts';
import type { RecordedTargetCapture } from './session-target-evidence.ts';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';
import { withSystemSurfaceDisclosure } from './handlers/system-surface-disclosure.ts';
import type { DirectIosSelectorTarget } from './direct-ios-selector.ts';
import {
  createBoundSelectorRuntime,
  createSelectorRuntimeForDevice,
  type SelectorRuntimeParams,
} from './selector-runtime-backend.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import {
  resolveBoundSelectorCapture,
  type BoundSelectorOperations,
} from './selector-capture-binding.ts';
import { dispatchConditionalWaitSelector } from './wait-conditional-selector.ts';

export type DirectIosSelectorQueryResult = {
  found: boolean;
  text?: string;
  node?: SnapshotNode;
};

export async function dispatchFindReadOnlyViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'find') return null;
  const args = req.positionals ?? [];
  const checked = checkFindArgs(args, req.flags);
  if (!checked.ok) return errorResponse(checked.code, checked.message);
  const parsed = checked.parsed;
  const action = parsed.action;
  if (!isReadOnlyFindAction(action)) return null;

  // Read-only `find` shares the element read with `get`, so it constructs a BOUND backend and
  // the two consume one bound operation instead of one binding it and the other dispatching the
  // legacy `read`. This moves find's READ LEG only: find's descriptor stays
  // `LEGACY_PLATFORM_EXECUTION`, it claims no cutover row, and its mutating actions are untouched.
  const resolvedRuntime = await createBoundSelectorRuntime(params, {
    requireSession: false,
    command: 'find',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

  const response = await toDaemonResponse(async () => {
    const result = await resolvedRuntime.runtime.selectors.find({
      session: params.sessionName,
      requestId: req.meta?.requestId,
      locator: parsed.locator,
      query: parsed.query,
      action,
      timeoutMs: parsed.timeoutMs,
    });
    recordIfSession(
      params.sessionStore,
      params.sessionName,
      req,
      buildFindRecordResult(result, action),
    );
    const data = toDaemonFindData(result);
    // #1076 clear choke point: this response returns a ref minted from the
    // freshly captured (and stored) session snapshot, so the client now holds
    // refs that match the stored tree again. As a ref-issuing response it also
    // carries the stored tree's generation ONCE (`refsGeneration`) so clients
    // can pin the ref (`@e12~s3`).
    const publishedRefs =
      typeof data.ref === 'string'
        ? [data.ref]
        : Array.isArray(data.matches)
          ? data.matches
              .map((match) => (match as { ref?: unknown }).ref)
              .filter((ref): ref is string => typeof ref === 'string')
          : [];
    if (publishedRefs.length > 0) {
      const session = params.sessionStore.get(params.sessionName);
      if (session) {
        // ADR 0014: a read-only find publishes exactly the refs it returned —
        // one for single-match actions, every listed ref for `list` — so it
        // activates a PARTIAL frame authorizing exactly those ref bodies.
        markSessionPartialRefsIssued(session, publishedRefs);
        params.sessionStore.set(params.sessionName, session);
        if (session.snapshotGeneration !== undefined) {
          return { ...data, refsGeneration: session.snapshotGeneration };
        }
      }
    }
    return data;
  });
  // The consumed capture was just stored on the session: when it is an occluding system surface,
  // both found and not-found outcomes must disclose that app content is occluded.
  return withSystemSurfaceDisclosure(response, consumedSessionSnapshot(params));
}

function consumedSessionSnapshot(params: SelectorRuntimeParams) {
  // The capture runtime reports the consumed snapshot directly; sessionless selector routes have
  // no session record, so the stored-session read is only a fallback for pre-captured snapshots.
  return params.consumedSnapshot?.state ?? params.sessionStore.get(params.sessionName)?.snapshot;
}

export async function dispatchGetViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'get') return null;
  const format = checkGetFormat(req.positionals?.[0]);
  if (!format.ok) return errorResponse(format.code, format.message);
  const sub = format.format;
  const target = parseGetTarget(req);
  if (!target.ok) return target.response;
  if (target.target.kind === 'ref') {
    const invalidRefFlagsResponse = refSnapshotFlagGuardResponse('get', req.flags);
    if (invalidRefFlagsResponse) return invalidRefFlagsResponse;
  }
  // ADR 0012 step 4: a guarded replay dispatch must resolve through the
  // snapshot path so the post-resolution identity guard runs.
  const replayTargetGuard = req.internal?.replayTargetGuard;

  // ADR 0019: `get` declares `device-runtime`, so its request path reaches the device ONLY
  // through operations R36 declares. Every target shape — including the simple iOS `id=` selector
  // a direct runner query used to answer without a capture — resolves through the bound capture.
  // Admission before a bypass is not the same as executing through the seam, so the bypass is
  // gone rather than merely ordered after admission.
  const resolvedRuntime = await createBoundSelectorRuntime(params, {
    requireSession: true,
    command: 'get',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

  const runtime = resolvedRuntime.runtime;

  // #1076 + ADR 0014: a get @ref binds against the retained ref-frame evidence,
  // so it never silently retargets to a newer positional tree. Its warning is
  // frame-derived: once the ref frame has expired any ref gets the frame-derived
  // warning, else a pinned `@e12~s3` ref whose epoch no longer matches gets the
  // precise generation-mismatch warning.
  const staleRefsWarning =
    target.target.kind === 'ref'
      ? resolveRefStalenessWarning({
          session: params.sessionStore.get(params.sessionName),
          ref: target.target.ref,
          mintedGeneration: target.refGeneration,
        })
      : undefined;
  const response = await toDaemonResponse(async () => {
    const result = await runtime.selectors.get({
      session: params.sessionName,
      requestId: req.meta?.requestId,
      property: sub,
      target: target.target,
      expectedResolvedTarget: replayTargetGuard,
    });
    recordIfSession(
      params.sessionStore,
      params.sessionName,
      req,
      buildGetRecordResult(result, sub),
      {
        node: result.node,
        preActionNodes: result.preActionNodes,
      },
    );
    const data = toDaemonGetData(result);
    return staleRefsWarning ? { ...data, warning: staleRefsWarning } : data;
  });
  return withSystemSurfaceDisclosure(response, consumedSessionSnapshot(params));
}

export async function dispatchIsViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'is') return null;
  const checked = checkIsArgs(req.positionals ?? []);
  if (!checked.ok) {
    return errorResponse(
      checked.code,
      checked.message,
      checked.hint ? { hint: checked.hint } : undefined,
    );
  }
  const { predicate, selectorExpression, expectedText } = checked;
  // ADR 0012 decision 3 / #1349: a guarded replay dispatch resolves through the snapshot path so
  // the post-resolution identity guard runs against the resolution tree.
  const replayTargetGuard = req.internal?.replayTargetGuard;

  // ADR 0019: `is` declares `device-runtime`, so its request path reaches the device ONLY through
  // the operations R37 declares. Every predicate — including the simple iOS `id=` selector a
  // direct runner query used to answer without a capture — resolves through the bound capture.
  // Admission before a bypass is not the same as executing through the seam, so the bypass is
  // gone rather than merely ordered after admission.
  const resolvedRuntime = await createBoundSelectorRuntime(params, {
    requireSession: true,
    command: 'is',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

  const response = await toDaemonResponse(async () => {
    const result = await resolvedRuntime.runtime.selectors.is({
      session: params.sessionName,
      requestId: req.meta?.requestId,
      predicate,
      selector: selectorExpression,
      expectedText,
      expectedResolvedTarget: replayTargetGuard,
    });
    const recordedTarget = readRecordedResolutionTarget(result);
    const strippedResult = stripResolutionPayload(result);
    recordIfSession(params.sessionStore, params.sessionName, req, strippedResult, recordedTarget);
    return stripSelectorChain(strippedResult);
  });
  return withSystemSurfaceDisclosure(
    await maybeAndroidForegroundBlockerResponse(params, response, `is ${predicate}`),
    consumedSessionSnapshot(params),
  );
}

export async function dispatchWaitViaRuntime(
  params: SelectorRuntimeParams &
    Readonly<{ inspectFacts?: InspectDeviceRuntimeFacts; bindDevice?: BindDeviceRuntime }>,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const parsed = parseWaitPositionals(req.positionals ?? []);
  if (!parsed) return errorResponse('INVALID_ARGS', 'wait requires a duration or text');
  if (parsed.kind === 'invalid') return errorResponse('INVALID_ARGS', parsed.message);
  const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
  // ADR 0019: facts are the only support authority, through the selector family's one
  // admit-then-bind entry. A duration wait observes nothing, so it never asks for a binding —
  // exactly the cell legacy admission skipped by testing `parsed.kind !== 'sleep'`.
  let waitOperations: BoundSelectorOperations | undefined;
  if (waitObservesDevice(parsed.kind)) {
    const bound = await resolveBoundSelectorCapture({
      command: 'wait',
      device,
      session,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (!bound.ok) return bound.response;
    waitOperations = bound.operations;
  }
  // ADR 0012 / #1349, replay-only: the recorded landmark identity this wait must observe.
  const recordedLandmark = req.internal?.replayLandmarkGuard;
  // #1076 + ADR 0014: a wait @ref names an element from the retained ref-frame
  // evidence, and its staleness is frame-derived rather than a property of the
  // live polling capture the condition is checked against. Once the ref frame
  // has expired any ref gets the frame-derived warning, else a pinned `@e12~s3`
  // ref whose epoch no longer matches gets the precise generation-mismatch
  // warning. The pin is split off HERE so the runtime and recording only ever
  // see the plain `@e12` form.
  let waitParsed = parsed;
  let staleRefsWarning: string | undefined;
  if (parsed.kind === 'ref') {
    const versionedRef = parseVersionedRefPositional(parsed.rawRef);
    if (!versionedRef.ok) return versionedRef.response;
    waitParsed = { ...parsed, rawRef: versionedRef.ref };
    staleRefsWarning = resolveRefStalenessWarning({
      session,
      ref: versionedRef.ref,
      mintedGeneration: versionedRef.generation,
    });
  }
  if (waitParsed.kind === 'selector') {
    const conditionalResponse = await dispatchConditionalWaitSelector({
      selectorExpression: waitParsed.selectorExpression,
      operation: waitOperations?.findSelector,
      recordedLandmark,
      req,
      session,
      sessionName,
      sessionStore,
      logPath: params.logPath,
      signal: params.signal,
    });
    if (conditionalResponse) return conditionalResponse;
  }
  // Wait builds its runtime directly (no createBoundSelectorRuntime), so the consumed-snapshot slot
  // must be initialized here too or sessionless waits have nowhere to report the capture from.
  params.consumedSnapshot ??= {};
  const execute = async () => {
    const runtime = createSelectorRuntimeForDevice({
      ...params,
      session,
      device,
      bound: waitOperations,
    });
    const response = await toDaemonResponse(async () => {
      const result = await runtime.selectors.wait({
        session: sessionName,
        requestId: req.meta?.requestId,
        target: toWaitTarget(waitParsed, session, recordedLandmark),
      });
      const recordedTarget = readRecordedResolutionTarget(result);
      recordIfSession(
        sessionStore,
        sessionName,
        req,
        stripResolutionPayload(result),
        recordedTarget,
        'landmark',
      );
      const data = toDaemonWaitData(result);
      return staleRefsWarning ? { ...data, warning: staleRefsWarning } : data;
    });
    // Only a polling wait can fail with `targetAbsent`/`stableTimeout`, and only it holds a
    // capture binding to describe the surface with. A duration wait has neither.
    const enrichedResponse = waitOperations
      ? await maybeWaitTimeoutSurfaceResponse(
          { req, logPath: params.logPath, session, device, capture: waitOperations.capture },
          response,
        )
      : response;
    // Keep generic wait-surface details first so Android blocker detection can own the top-level message.
    return await maybeAndroidForegroundBlockerResponse(params, enrichedResponse, 'wait');
  };
  // A pure sleep consumes no capture, so it never earns the system-surface disclosure below.
  if (parsed.kind === 'sleep') return await execute();
  // Both a satisfied wait and a timeout consumed the polled capture stored on the session:
  // when it is an occluding system surface, the outcome must disclose the occlusion.
  return withSystemSurfaceDisclosure(
    await withSessionlessRunnerCleanup(session, device, execute),
    consumedSessionSnapshot(params),
  );
}

/** ADR 0012 decision 3 / #1349: a wait/is result's resolution payload, when the tree path produced one. */
function readRecordedResolutionTarget(
  result: Record<string, unknown>,
): RecordedTargetCapture | undefined {
  const node = result.node;
  const preActionNodes = result.preActionNodes;
  if (!node || typeof node !== 'object' || !Array.isArray(preActionNodes)) return undefined;
  return { node: node as SnapshotNode, preActionNodes: preActionNodes as SnapshotNode[] };
}

/**
 * The single querySelector client for the local XCTest runner: a live,
 * tree-independent read (and its found/text/node shape) for exactly one
 * selector. Decoupled from `SelectorRuntimeParams` on purpose — the offscreen
 * refusal double-check (`src/daemon/offscreen-target-probe.ts`) reuses this
 * SAME function from a plain daemon session, not a selector-runtime request,
 * so it must not depend on that request bag.
 */
export async function queryDirectIosSelector(
  session: SessionState,
  selector: Pick<DirectIosSelectorTarget, 'key' | 'value'>,
  requestOptions: AppleRunnerRequestOptions,
): Promise<DirectIosSelectorQueryResult> {
  const data = await queryAppleRunnerSelector(
    session.device,
    selector,
    session.appBundleId,
    requestOptions,
  );
  const found = data.found === true;
  const node = readDirectIosSelectorNode(data);
  return {
    found,
    ...(typeof data.text === 'string' ? { text: data.text } : {}),
    ...(node ? { node } : {}),
  };
}

function readDirectIosSelectorNode(data: Record<string, unknown>): SnapshotNode | undefined {
  const nodes = data.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const node = nodes[0];
  if (!node || typeof node !== 'object') return undefined;
  return node as SnapshotNode;
}

function parseGetTarget(req: DaemonRequest):
  | {
      ok: true;
      target:
        | { kind: 'ref'; ref: string; fallbackLabel?: string }
        | { kind: 'selector'; selector: string };
      /** Minted generation from a pinned `@e12~s3` ref (#1076), split off the ref. */
      refGeneration?: number;
    }
  | { ok: false; response: DaemonResponse } {
  const refInput = req.positionals?.[1] ?? '';
  if (refInput.startsWith('@')) {
    const versionedRef = parseVersionedRefPositional(refInput);
    if (!versionedRef.ok) return { ok: false, response: versionedRef.response };
    return {
      ok: true,
      target: {
        kind: 'ref',
        ref: versionedRef.ref,
        fallbackLabel: req.positionals.length > 2 ? req.positionals.slice(2).join(' ').trim() : '',
      },
      refGeneration: versionedRef.generation,
    };
  }
  const target = checkElementTargetArgs(req.positionals?.slice(1) ?? []);
  if (!target.ok) {
    return { ok: false, response: errorResponse(target.code, target.message) };
  }
  const selector = 'selector' in target ? target.selector : '';
  return { ok: true, target: { kind: 'selector', selector } };
}

function toWaitTarget(
  // 'invalid' is rejected by the caller before this point; excluding it here makes the
  // kind-by-kind narrowing below exhaustive without a runtime fallback branch (#1800).
  parsed: Exclude<WaitParsed, { kind: 'invalid' }>,
  session: SessionState | undefined,
  recordedLandmark?: TargetAnnotationV1,
) {
  if (parsed.kind === 'sleep') return { kind: 'sleep' as const, durationMs: parsed.durationMs };
  if (parsed.kind === 'selector') {
    return {
      kind: 'selector' as const,
      selector: parsed.selectorExpression,
      timeoutMs: parsed.timeoutMs,
      ...(recordedLandmark ? { recordedLandmark } : {}),
    };
  }
  if (parsed.kind === 'ref') {
    if (!session?.snapshot) {
      throw new AppError('INVALID_ARGS', 'Ref wait requires an existing snapshot in session.');
    }
    return { kind: 'ref' as const, ref: parsed.rawRef, timeoutMs: parsed.timeoutMs };
  }
  if (parsed.kind === 'stable') {
    return {
      kind: 'stable' as const,
      quietMs: parsed.quietMs,
      timeoutMs: parsed.timeoutMs,
    };
  }
  const waitText = checkWaitText(parsed.text);
  if (!waitText.ok) throw new AppError(waitText.code, waitText.message);
  return { kind: 'text' as const, text: waitText.text, timeoutMs: parsed.timeoutMs };
}

async function toDaemonResponse(
  task: () => Promise<Record<string, unknown>>,
): Promise<DaemonResponse> {
  try {
    return { ok: true, data: await task() };
  } catch (error) {
    const appError = asAppError(error);
    return errorResponse(appError.code, appError.message, appError.details);
  }
}

async function maybeAndroidForegroundBlockerResponse(
  params: SelectorRuntimeParams,
  response: DaemonResponse,
  commandLabel: string,
): Promise<DaemonResponse> {
  if (response.ok) return response;
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return response;
  let surface: Awaited<ReturnType<typeof detectAndroidEscapeSurface>>;
  try {
    surface = await detectAndroidEscapeSurface(session);
  } catch {
    return response;
  }
  if (!surface) return response;
  return errorResponse(
    response.error.code,
    `${commandLabel} failed because ${describeAndroidEscapeSurface(surface)}.`,
    {
      ...(response.error.details ?? {}),
      ...surface,
      blockedBy: 'android_foreground_surface',
      originalMessage: response.error.message,
    },
  );
}
