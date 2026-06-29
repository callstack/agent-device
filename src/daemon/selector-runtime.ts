import { parseWaitPositionals } from '../core/wait-positionals.ts';
import type { WaitParsed } from '../core/wait-positionals.ts';
import { AppError, asAppError, normalizeError } from '../kernel/errors.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { runIosRunnerCommand } from '../platforms/ios/runner-client.ts';
import { buildAppleRunnerRequestOptions } from './apple-runner-options.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { errorResponse, requireCommandSupported } from './handlers/response.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from './handlers/snapshot-session.ts';
import { parseFindArgs, type FindAction } from '../utils/finders.ts';
import { splitIsSelectorArgs } from './selectors.ts';
import { refSnapshotFlagGuardResponse } from './handlers/interaction-flags.ts';
import {
  evaluateIsPredicate,
  isSupportedPredicate,
  type IsPredicate,
} from '../utils/selector-is-predicates.ts';
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
    return toDaemonFindData(result);
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
  if (target.target.kind === 'selector') {
    const directResponse = await dispatchDirectIosSelectorGet(params, sub, target.target.selector);
    if (directResponse) return directResponse;
  }

  const resolvedRuntime = await createSelectorRuntime(params, {
    requireSession: true,
    capability: 'get',
  });
  if (!resolvedRuntime.ok) return resolvedRuntime.response;

  return await toDaemonResponse(async () => {
    const result = await resolvedRuntime.runtime.selectors.get({
      session: params.sessionName,
      requestId: req.meta?.requestId,
      property: sub,
      target: target.target,
    });
    recordIfSession(
      params.sessionStore,
      params.sessionName,
      req,
      buildGetRecordResult(result, sub),
    );
    return toDaemonGetData(result);
  });
}

export async function dispatchIsViaRuntime(
  params: SelectorRuntimeParams,
): Promise<DaemonResponse | null> {
  const { req } = params;
  if (req.command !== 'is') return null;
  const predicate = (req.positionals?.[0] ?? '').toLowerCase();
  if (!isSupportedPredicate(predicate)) {
    return errorResponse(
      'INVALID_ARGS',
      'is requires predicate: visible|hidden|exists|editable|selected|text',
    );
  }
  const { split } = splitIsSelectorArgs(req.positionals ?? []);
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
        target: toWaitTarget(parsed, session),
      });
      recordIfSession(sessionStore, sessionName, req, result);
      return toDaemonWaitData(result);
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

async function dispatchDirectIosSelectorGet(
  params: SelectorRuntimeParams,
  property: 'text' | 'attrs',
  selectorExpression: string,
): Promise<DaemonResponse | null> {
  const session = params.sessionStore.get(params.sessionName);
  const selector = readSimpleIosSelectorTarget({ session, selectorExpression });
  if (!session || !selector) return null;
  // get text intentionally disambiguates label/text/value triplets from snapshots; the runner
  // direct query rejects those ambiguous matches before the shared selector resolver can rank them.
  if (property === 'text' && selector.key !== 'id') return null;

  const result = await queryDirectIosSelectorOrFallback(params, session, selector);
  if (isDirectIosSelectorErrorResult(result)) return result.response;
  if (!result) return null;
  const directQuery = { session, selector, result };
  const payload = buildDirectIosGetResult(property, directQuery.selector.raw, directQuery.result);
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
  const response: DaemonResponse = { ok: true, data: payload };
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
  const data = await runIosRunnerCommand(
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
    }
  | { ok: false; response: DaemonResponse } {
  const refInput = req.positionals?.[1] ?? '';
  if (refInput.startsWith('@')) {
    return {
      ok: true,
      target: {
        kind: 'ref',
        ref: refInput,
        fallbackLabel: req.positionals.length > 2 ? req.positionals.slice(2).join(' ').trim() : '',
      },
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
