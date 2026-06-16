import type {
  AgentDeviceBackend,
  BackendSnapshotOptions,
  BackendSnapshotResult,
} from '../backend.ts';
import { createAgentDevice } from '../runtime.ts';
import { parseWaitPositionals } from '../core/wait-positionals.ts';
import type { WaitParsed } from '../core/wait-positionals.ts';
import { isCommandSupportedOnDevice } from '../core/capabilities.ts';
import { resolveTargetDevice, type CommandFlags } from '../core/dispatch.ts';
import { isApplePlatform } from '../utils/device.ts';
import { AppError, asAppError, normalizeError } from '../utils/errors.ts';
import {
  buildSnapshotPresentationKey,
  snapshotPresentationOptionsFromFlags,
  type SnapshotNode,
} from '../utils/snapshot.ts';
import { runIosRunnerCommand } from '../platforms/ios/runner-client.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { SessionStore } from './session-store.ts';
import { contextFromFlags } from './context.ts';
import { ensureDeviceReady } from './device-ready.ts';
import { captureSnapshot } from './handlers/snapshot-capture.ts';
import { readTextForNode } from './handlers/interaction-read.ts';
import { errorResponse } from './handlers/response.ts';
import { findNodeByLabel } from '../utils/snapshot-processing.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from './handlers/snapshot-session.ts';
import { parseFindArgs, type FindAction } from '../utils/finders.ts';
import { splitIsSelectorArgs } from './selectors.ts';
import { refSnapshotFlagGuardResponse } from './handlers/interaction-flags.ts';
import {
  evaluateIsPredicate,
  isSupportedPredicate,
  type IsPredicate,
} from '../utils/selector-is-predicates.ts';
import type { ContextFromFlags } from './handlers/interaction-common.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import { getActiveAndroidSnapshotFreshness } from './android-snapshot-freshness.ts';
import { isSparseSnapshotQualityVerdict } from '../utils/snapshot-quality.ts';
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
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';
import {
  isDirectIosSelectorFallbackError,
  readSimpleIosSelectorTarget,
  type DirectIosSelectorTarget,
} from './direct-ios-selector.ts';

type SelectorRuntimeParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags?: ContextFromFlags;
};

type SnapshotFlagOverrides = Partial<
  Pick<CommandFlags, 'snapshotInteractiveOnly' | 'snapshotScope' | 'snapshotDepth' | 'snapshotRaw'>
>;

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
  if (parsed.kind !== 'sleep' && !isCommandSupportedOnDevice('wait', device)) {
    return errorResponse('UNSUPPORTED_OPERATION', 'wait is not supported on this device');
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
    {
      verbose: Boolean(params.req.flags?.verbose),
      logPath: params.logPath,
      traceLogPath: session.trace?.outPath,
      requestId: params.req.meta?.requestId,
      iosXctestrunFile: params.req.flags?.iosXctestrunFile,
      iosXctestDerivedDataPath: params.req.flags?.iosXctestDerivedDataPath,
      iosXctestEnvDir: params.req.flags?.iosXctestEnvDir,
    },
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

function createSelectorRuntimeForDevice(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags?: ContextFromFlags;
  session: SessionState | undefined;
  device: SessionState['device'];
}) {
  return createAgentDevice({
    backend: createSelectorBackend(params),
    ...createDaemonRuntimePolicy('selector commands', { plural: true }),
    sessions: createDaemonRuntimeSessionStore({
      sessionName: params.sessionName,
      getSession: () => params.session,
      recordOptions: { includeSnapshot: true },
      setRecord: (record) => {
        if (!params.session || !record.snapshot) return;
        setSessionSnapshot(params.session, record.snapshot);
        params.sessionStore.set(params.sessionName, params.session);
      },
    }),
  });
}

async function createSelectorRuntime(
  params: SelectorRuntimeParams,
  options: { requireSession: boolean; capability: 'find' | 'get' | 'is' },
): Promise<
  | { ok: true; runtime: ReturnType<typeof createSelectorRuntimeForDevice> }
  | { ok: false; response: DaemonResponse }
> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session && options.requireSession) {
    return {
      ok: false,
      response: errorResponse('SESSION_NOT_FOUND', 'No active session. Run open first.'),
    };
  }
  const device = session?.device ?? (await resolveTargetDevice(params.req.flags ?? {}));
  if (!session) await ensureDeviceReady(device);
  if (!isCommandSupportedOnDevice(options.capability, device)) {
    return {
      ok: false,
      response: errorResponse(
        'UNSUPPORTED_OPERATION',
        `${options.capability} is not supported on this device`,
      ),
    };
  }
  return {
    ok: true,
    runtime: createSelectorRuntimeForDevice({
      ...params,
      session,
      device,
    }),
  };
}

function createSelectorBackend(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags?: ContextFromFlags;
  session: SessionState | undefined;
  device: SessionState['device'];
}): AgentDeviceBackend {
  const { req, session, device, logPath, sessionName, sessionStore } = params;
  let lastSnapshotAt = 0;
  let lastSnapshotResult: BackendSnapshotResult | undefined;
  return {
    platform: device.platform,
    // fallow-ignore-next-line complexity
    captureSnapshot: async (_context, options): Promise<BackendSnapshotResult> => {
      const flags = {
        ...req.flags,
        ...snapshotFlagOverrides(options),
      };
      const snapshotScope = options?.scope ?? req.flags?.snapshotScope;
      const timestamp = Date.now();
      const presentationKey = buildSnapshotPresentationKey(
        snapshotPresentationOptionsFromFlags(flags),
      );
      const needsFreshSnapshot = req.command === 'wait' || req.command === 'find';
      if (
        !needsFreshSnapshot &&
        lastSnapshotResult &&
        timestamp - lastSnapshotAt < 750 &&
        !getActiveAndroidSnapshotFreshness(session) &&
        !session?.postGestureStabilization
      ) {
        return lastSnapshotResult;
      }
      if (
        !needsFreshSnapshot &&
        session?.snapshot &&
        timestamp - session.snapshot.createdAt < 750 &&
        session.snapshot.presentationKey === presentationKey &&
        !getActiveAndroidSnapshotFreshness(session) &&
        !session.postGestureStabilization
      ) {
        lastSnapshotAt = session.snapshot.createdAt;
        lastSnapshotResult = { snapshot: session.snapshot };
        return lastSnapshotResult;
      }
      const capture = await captureSnapshot({
        device,
        session,
        flags,
        outPath: req.flags?.out,
        logPath: logPath ?? '',
        snapshotScope,
      });
      if (session && !isSparseSnapshotQualityVerdict(capture.snapshot.snapshotQuality)) {
        setSessionSnapshot(session, capture.snapshot);
        sessionStore.set(sessionName, session);
      }
      lastSnapshotAt = timestamp;
      lastSnapshotResult = { snapshot: capture.snapshot };
      return lastSnapshotResult;
    },
    readText: async (_context, node: SnapshotNode) => ({
      text: await readTextForNode({
        device,
        node,
        flags: req.flags,
        appBundleId: session?.appBundleId,
        traceOutPath: session?.trace?.outPath,
        surface: session?.surface,
        contextFromFlags:
          params.contextFromFlags ??
          ((flags, appBundleId, traceLogPath) =>
            contextFromFlags(logPath ?? '', flags, appBundleId, traceLogPath)),
      }),
    }),
    findText: async (_context, text) => ({
      found: await findText(params, text),
    }),
  };
}

function snapshotFlagOverrides(options: BackendSnapshotOptions | undefined): SnapshotFlagOverrides {
  const flags: SnapshotFlagOverrides = {};
  if (options?.interactiveOnly !== undefined)
    flags.snapshotInteractiveOnly = options.interactiveOnly;
  if (options?.scope !== undefined) flags.snapshotScope = options.scope;
  if (options?.depth !== undefined) flags.snapshotDepth = options.depth;
  if (options?.raw !== undefined) flags.snapshotRaw = options.raw;
  return flags;
}

async function findText(
  params: {
    req: DaemonRequest;
    sessionName: string;
    logPath?: string;
    sessionStore: SessionStore;
    contextFromFlags?: ContextFromFlags;
    session: SessionState | undefined;
    device: SessionState['device'];
  },
  text: string,
): Promise<boolean> {
  const { device, session, req, logPath } = params;
  if (device.platform === 'macos' && session?.surface && session.surface !== 'app') {
    const snapshot = await captureWaitSnapshot(params);
    return Boolean(findNodeByLabel(snapshot.nodes, text));
  }
  if (isApplePlatform(device.platform) && session?.appBundleId) {
    const result = (await runIosRunnerCommand(
      device,
      { command: 'findText', text, appBundleId: session?.appBundleId },
      {
        verbose: req.flags?.verbose,
        logPath,
        traceLogPath: session?.trace?.outPath,
        requestId: req.meta?.requestId,
        iosXctestrunFile: req.flags?.iosXctestrunFile,
        iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
        iosXctestEnvDir: req.flags?.iosXctestEnvDir,
      },
    )) as { found?: boolean };
    return result?.found === true;
  }
  const snapshot = await captureWaitSnapshot(params);
  return Boolean(findNodeByLabel(snapshot.nodes, text));
}

async function captureWaitSnapshot(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags?: ContextFromFlags;
  session: SessionState | undefined;
  device: SessionState['device'];
}) {
  const capture = await captureSnapshot({
    device: params.device,
    session: params.session,
    flags: {
      ...params.req.flags,
      snapshotInteractiveOnly: false,
    },
    outPath: params.req.flags?.out,
    logPath: params.logPath ?? '',
  });
  if (params.session && !isSparseSnapshotQualityVerdict(capture.snapshot.snapshotQuality)) {
    setSessionSnapshot(params.session, capture.snapshot);
    params.sessionStore.set(params.sessionName, params.session);
  }
  return capture.snapshot;
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
