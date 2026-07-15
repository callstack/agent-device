import { parseWaitPositionals } from '../core/wait-positionals.ts';
import type { WaitParsed } from '../core/wait-positionals.ts';
import { AppError, asAppError, normalizeError } from '../kernel/errors.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { runAppleRunnerCommand } from '../platforms/apple/core/runner/runner-client.ts';
import { buildAppleRunnerRequestOptions } from './apple-runner-options.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { errorResponse, requireCommandSupported } from './handlers/response.ts';
import { markSessionPartialRefsIssued, resolveRefStalenessWarning } from './session-snapshot.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from './handlers/snapshot-session.ts';
import { parseFindArgs, type FindAction } from '../selectors/find.ts';
import { splitIsSelectorArgs } from '../selectors/index.ts';
import { refSnapshotFlagGuardResponse } from './handlers/interaction-flags.ts';
import { parseVersionedRefPositional } from './handlers/interaction-touch-targets.ts';
import {
  evaluateIsPredicate,
  isSupportedPredicate,
  IS_PREDICATE_REQUIRED_MESSAGE,
  IS_PREDICATE_USAGE_HINT,
  type IsPredicate,
} from '../selectors/predicates.ts';
import {
  describeAndroidEscapeSurface,
  detectAndroidEscapeSurface,
} from './handlers/interaction-android-escape.ts';
import {
  buildFindRecordResult,
  buildGetRecordResult,
  recordIfSession,
  stripSelectorChain,
  toDaemonFindData,
  toDaemonGetData,
  toDaemonWaitData,
} from './selector-recording.ts';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';
import {
  isDirectIosSelectorFallbackError,
  readSimpleIosSelectorTarget,
  type DirectIosSelectorTarget,
} from './direct-ios-selector.ts';
import {
  createSelectorRuntime,
  createSelectorRuntimeForDevice,
  type SelectorRuntimeParams,
} from './selector-runtime-backend.ts';

type DirectIosSelectorQueryResult = {
  found: boolean;
  text?: string;
  node?: SnapshotNode;
};

type DirectIosSelectorErrorResult = { kind: 'error'; response: DaemonResponse };

type DirectIosSelectorFallbackResult =
  | DirectIosSelectorQueryResult
  | DirectIosSelectorErrorResult
  | null;

type ResolvedDirectIosSelectorQuery =
  | {
      session: SessionState;
      selector: DirectIosSelectorTarget;
      result: DirectIosSelectorQueryResult;
    }
  | DirectIosSelectorErrorResult
  | null;

export async function dispatchFindReadOnlyViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'find') return null;
  const args = req.positionals ?? [];
  if (args.length === 0) return errorResponse('INVALID_ARGS', 'find requires a locator or text');
  const parsed = parseFindArgs(args);
  if (!parsed.query) return errorResponse('INVALID_ARGS', 'find requires a value');
  if (req.flags?.findFirst && req.flags?.findLast) {
    return errorResponse('INVALID_ARGS', 'find accepts only one of --first or --last');
  }
  const action = parsed.action;
  if (!isReadOnlyFindAction(action)) return null;

  const resolvedRuntime = await createSelectorRuntime(params, {
    requireSession: false,
    capability: 'find',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

  return await toDaemonResponse(async () => {
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
    if (typeof data.ref === 'string') {
      const session = params.sessionStore.get(params.sessionName);
      if (session) {
        // ADR 0014: a read-only find publishes exactly its one returned ref, so
        // it activates a PARTIAL frame authorizing only that ref body.
        markSessionPartialRefsIssued(session, [data.ref]);
        params.sessionStore.set(params.sessionName, session);
        if (session.snapshotGeneration !== undefined) {
          return { ...data, refsGeneration: session.snapshotGeneration };
        }
      }
    }
    return data;
  });
}

export async function dispatchGetViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'get') return null;
  const sub = req.positionals?.[0];
  if (sub !== 'text' && sub !== 'attrs') {
    return errorResponse('INVALID_ARGS', 'get only supports text or attrs');
  }
  const target = parseGetTarget(req);
  if (!target.ok) return target.response;
  if (target.target.kind === 'ref') {
    const invalidRefFlagsResponse = refSnapshotFlagGuardResponse('get', req.flags);
    if (invalidRefFlagsResponse) return invalidRefFlagsResponse;
  }
  // ADR 0012 step 4: a guarded replay dispatch must resolve through the
  // snapshot path so the post-resolution identity guard runs.
  const replayTargetGuard = req.internal?.replayTargetGuard;
  if (target.target.kind === 'selector' && !replayTargetGuard) {
    const directResponse = await dispatchDirectIosSelectorGet(params, sub, target.target.selector);
    if (directResponse) return directResponse;
  }

  const resolvedRuntime = await createSelectorRuntime(params, {
    requireSession: true,
    capability: 'get',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

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
  return await toDaemonResponse(async () => {
    const result = await resolvedRuntime.runtime.selectors.get({
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
}

export async function dispatchIsViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'is') return null;
  const { predicate: rawPredicate, split } = splitIsSelectorArgs(req.positionals ?? []);
  const predicate = rawPredicate.toLowerCase();
  if (!isSupportedPredicate(predicate)) {
    return errorResponse('INVALID_ARGS', IS_PREDICATE_REQUIRED_MESSAGE, {
      hint: IS_PREDICATE_USAGE_HINT,
    });
  }
  if (!split) return errorResponse('INVALID_ARGS', 'is requires a selector expression');
  const expectedText = split.rest.join(' ').trim();
  if (predicate === 'text' && !expectedText) {
    return errorResponse('INVALID_ARGS', 'is text requires expected text value');
  }
  if (predicate !== 'text' && split.rest.length > 0) {
    return errorResponse('INVALID_ARGS', `is ${predicate} does not accept trailing values`);
  }
  const directResponse = await dispatchDirectIosSelectorIs(
    params,
    predicate as IsPredicate,
    split.selectorExpression,
    expectedText,
  );
  if (directResponse) return directResponse;

  const resolvedRuntime = await createSelectorRuntime(params, {
    requireSession: true,
    capability: 'is',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

  const response = await toDaemonResponse(async () => {
    const result = await resolvedRuntime.runtime.selectors.is({
      session: params.sessionName,
      requestId: req.meta?.requestId,
      predicate: predicate as IsPredicate,
      selector: split.selectorExpression,
      expectedText,
    });
    recordIfSession(params.sessionStore, params.sessionName, req, result);
    return stripSelectorChain(result);
  });
  return await maybeAndroidForegroundBlockerResponse(params, response, `is ${predicate}`);
}

export async function dispatchWaitViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const parsed = parseWaitPositionals(req.positionals ?? []);
  if (!parsed) return errorResponse('INVALID_ARGS', 'wait requires a duration or text');
  const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
  if (parsed.kind !== 'sleep') {
    const unsupported = requireCommandSupported('wait', device);
    if (unsupported) return unsupported;
  }
  if (parsed.kind === 'selector') {
    const directResponse = await dispatchDirectIosSelectorWait({
      ...params,
      session,
      device,
      selectorExpression: parsed.selectorExpression,
      timeoutMs: parsed.timeoutMs,
    });
    if (directResponse) return directResponse;
  }
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
  const execute = async () => {
    const runtime = createSelectorRuntimeForDevice({
      ...params,
      session,
      device,
    });
    const response = await toDaemonResponse(async () => {
      const result = await runtime.selectors.wait({
        session: sessionName,
        requestId: req.meta?.requestId,
        target: toWaitTarget(waitParsed, session),
      });
      recordIfSession(sessionStore, sessionName, req, result);
      const data = toDaemonWaitData(result);
      return staleRefsWarning ? { ...data, warning: staleRefsWarning } : data;
    });
    const enrichedResponse = await maybeWaitTimeoutSurfaceResponse(
      { req, logPath: params.logPath, session, device },
      response,
    );
    // Keep generic wait-surface details first so Android blocker detection can own the top-level message.
    return await maybeAndroidForegroundBlockerResponse(params, enrichedResponse, 'wait');
  };
  if (parsed.kind === 'sleep') return await execute();
  return await withSessionlessRunnerCleanup(session, device, execute);
}

function readDirectIosGetSelector(
  session: SessionState | undefined,
  property: 'text' | 'attrs',
  selectorExpression: string,
): DirectIosSelectorTarget | null {
  // ADR 0012 decision 3: recording requires the snapshot path so target
  // evidence can be computed from the resolution tree.
  if (!session || session.recordSession) return null;
  const selector = readSimpleIosSelectorTarget({ session, selectorExpression });
  // get text intentionally disambiguates label/text/value triplets from snapshots; the runner
  // direct query rejects those ambiguous matches before the shared selector resolver can rank them.
  if (property === 'text' && selector?.key !== 'id') return null;
  return selector;
}

async function dispatchDirectIosSelectorGet(
  params: SelectorRuntimeParams,
  property: 'text' | 'attrs',
  selectorExpression: string,
): Promise<DaemonResponse | null> {
  const session = params.sessionStore.get(params.sessionName);
  const selector = readDirectIosGetSelector(session, property, selectorExpression);
  if (!session || !selector) return null;

  const result = await queryDirectIosSelectorOrFallback(params, session, selector);
  if (isDirectIosSelectorErrorResult(result)) return result.response;
  if (!result) return null;
  const payload = buildDirectIosGetResult(property, selector.raw, result);
  if (!payload) return null;
  recordIfSession(
    params.sessionStore,
    params.sessionName,
    params.req,
    buildGetRecordResult(payload, property),
  );
  return { ok: true, data: toDaemonGetData(payload) };
}

async function dispatchDirectIosSelectorIs(
  params: SelectorRuntimeParams,
  predicate: IsPredicate,
  selectorExpression: string,
  expectedText: string,
): Promise<DaemonResponse | null> {
  if (predicate === 'hidden') return null;
  const directQuery = await resolveDirectIosSelectorQuery(params, selectorExpression);
  if (isDirectIosSelectorErrorResult(directQuery)) return directQuery.response;
  if (!directQuery?.result.found || !directQuery.result.node) return null;

  const payload =
    predicate === 'exists'
      ? {
          predicate,
          pass: true,
          selector: directQuery.selector.raw,
          matches: 1,
          selectorChain: [directQuery.selector.raw],
        }
      : buildDirectIosIsResult(
          predicate,
          expectedText,
          directQuery.selector.raw,
          directQuery.session,
          directQuery.result.node,
        );
  if (!payload) return null;
  recordIfSession(params.sessionStore, params.sessionName, params.req, payload);
  return { ok: true, data: stripSelectorChain(payload) };
}

async function dispatchDirectIosSelectorWait(
  params: SelectorRuntimeParams & {
    session: SessionState | undefined;
    device: SessionState['device'];
    selectorExpression: string;
    timeoutMs: number | null;
  },
): Promise<DaemonResponse | null> {
  const selector = readSimpleIosSelectorTarget({
    session: params.session,
    selectorExpression: params.selectorExpression,
  });
  if (!params.session || !selector) return null;
  const startedAt = Date.now();
  const result = await queryDirectIosSelectorOrFallback(params, params.session, selector);
  if (isDirectIosSelectorErrorResult(result)) return result.response;
  if (!result?.found) return null;
  const payload = {
    kind: 'selector',
    selector: selector.raw,
    waitedMs: Date.now() - startedAt,
    selectorChain: [selector.raw],
  };
  recordIfSession(params.sessionStore, params.sessionName, params.req, payload);
  const response: DaemonResponse = { ok: true, data: stripSelectorChain(payload) };
  return await maybeWaitTimeoutSurfaceResponse(
    { req: params.req, logPath: params.logPath, session: params.session, device: params.device },
    response,
  );
}

async function resolveDirectIosSelectorQuery(
  params: SelectorRuntimeParams,
  selectorExpression: string,
): Promise<ResolvedDirectIosSelectorQuery> {
  const session = params.sessionStore.get(params.sessionName);
  const selector = readSimpleIosSelectorTarget({ session, selectorExpression });
  if (!session || !selector) return null;
  const result = await queryDirectIosSelectorOrFallback(params, session, selector);
  if (isDirectIosSelectorErrorResult(result)) return result;
  if (!result) return null;
  return { session, selector, result };
}

async function queryDirectIosSelector(
  params: SelectorRuntimeParams,
  session: SessionState,
  selector: DirectIosSelectorTarget,
): Promise<DirectIosSelectorQueryResult> {
  const data = await runAppleRunnerCommand(
    session.device,
    {
      command: 'querySelector',
      selectorKey: selector.key,
      selectorValue: selector.value,
      appBundleId: session.appBundleId,
    },
    buildAppleRunnerRequestOptions({
      req: params.req,
      logPath: params.logPath,
      traceLogPath: session.trace?.outPath,
    }),
  );
  const found = data.found === true;
  const node = readDirectIosSelectorNode(data);
  return {
    found,
    ...(typeof data.text === 'string' ? { text: data.text } : {}),
    ...(node ? { node } : {}),
  };
}

async function queryDirectIosSelectorOrFallback(
  params: SelectorRuntimeParams,
  session: SessionState,
  selector: DirectIosSelectorTarget,
): Promise<DirectIosSelectorFallbackResult> {
  try {
    return await queryDirectIosSelector(params, session, selector);
  } catch (error) {
    if (isDirectIosSelectorFallbackError(error, { allowElementNotFound: true })) return null;
    return { kind: 'error', response: { ok: false, error: normalizeError(error) } };
  }
}

function isDirectIosSelectorErrorResult(
  result: DirectIosSelectorFallbackResult | ResolvedDirectIosSelectorQuery,
): result is DirectIosSelectorErrorResult {
  return result !== null && 'kind' in result && result.kind === 'error';
}

function buildDirectIosGetResult(
  property: 'text' | 'attrs',
  selector: string,
  result: DirectIosSelectorQueryResult,
): Record<string, unknown> | null {
  if (!result.found || !result.node) return null;
  const base = {
    target: { kind: 'selector' as const, selector },
    node: result.node,
    selectorChain: [selector],
  };
  if (property === 'attrs') return { kind: 'attrs', ...base };
  if (typeof result.text !== 'string') return null;
  return { kind: 'text', ...base, text: result.text };
}

function buildDirectIosIsResult(
  predicate: Exclude<IsPredicate, 'exists' | 'hidden'>,
  expectedText: string,
  selector: string,
  session: SessionState,
  node: SnapshotNode,
): Record<string, unknown> | null {
  const result = evaluateIsPredicate({
    predicate,
    node,
    nodes: [node],
    expectedText,
    platform: session.device.platform,
  });
  return {
    predicate,
    pass: result.pass,
    selector,
    ...(predicate === 'text' ? { text: result.actualText } : {}),
    selectorChain: [selector],
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
  const selector = req.positionals?.slice(1).join(' ').trim() ?? '';
  if (!selector) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'get requires @ref or selector expression'),
    };
  }
  return { ok: true, target: { kind: 'selector', selector } };
}

function toWaitTarget(parsed: WaitParsed, session: SessionState | undefined) {
  if (parsed.kind === 'sleep') return { kind: 'sleep' as const, durationMs: parsed.durationMs };
  if (parsed.kind === 'selector') {
    return {
      kind: 'selector' as const,
      selector: parsed.selectorExpression,
      timeoutMs: parsed.timeoutMs,
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
  if (!parsed.text) throw new AppError('INVALID_ARGS', 'wait requires text');
  return { kind: 'text' as const, text: parsed.text, timeoutMs: parsed.timeoutMs };
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

function isReadOnlyFindAction(
  action: FindAction['kind'],
): action is 'exists' | 'wait' | 'get_text' | 'get_attrs' {
  return (
    action === 'exists' || action === 'wait' || action === 'get_text' || action === 'get_attrs'
  );
}
