import {
  findBestMatchesByLocator,
  parseFindSelectorExpression,
  type FindAction,
  type FindLocator,
} from '../../../selectors/find.ts';
import type { SnapshotNode } from '../../../kernel/snapshot.ts';
import { findNodeByRef, normalizeRef } from '../../../kernel/snapshot.ts';
import {
  isSparseSnapshotQualityVerdict,
  type SnapshotQualityVerdict,
} from '../../../snapshot/snapshot-quality.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { AppError } from '../../../kernel/errors.ts';
import { parseSelectorChain, type SelectorChain } from '../../../selectors/parse.ts';
import {
  findSelectorChainMatch,
  formatSelectorFailure,
  resolveSelectorChain,
  selectorFailureHint,
} from '../../../selectors/index.ts';
import { buildSelectorChainForNode } from '../../../selectors/build.ts';
import {
  evaluateIsPredicate,
  isSupportedPredicate,
  IS_PREDICATE_REQUIRED_MESSAGE,
} from '../../../selectors/predicates.ts';
import type {
  ElementTarget,
  RefTarget,
  ResolvedTarget,
  SelectorTarget,
} from '../../../contracts/interaction.ts';
import type { RuntimeCommand } from '../../runtime-types.ts';
import { assertExpectedResolvedTarget, type ExpectedResolvedTarget } from './resolution.ts';
import {
  type CapturedSnapshot,
  type SelectorSnapshotOptions,
  captureSelectorSnapshot,
  readText,
  requireSnapshotSession,
  resolveRefNode,
} from './selector-read-shared.ts';
import { findNodeByLabel, resolveRefLabel, shouldScopeFind } from './selector-read-utils.ts';
import {
  DEFAULT_STABLE_QUIET_MS,
  runStableCaptureLoop,
  TINY_STABLE_TREE_HINT,
  TINY_STABLE_TREE_NODE_COUNT,
} from './stable-capture.ts';
import { now, sleep, toBackendContext } from '../../runtime-common.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';

export type { SelectorSnapshotOptions } from './selector-read-shared.ts';
export type { ElementTarget, RefTarget, ResolvedTarget, SelectorTarget };

export type FindReadCommandOptions = CommandContext & {
  locator?: FindLocator;
  query: string;
  action: Extract<FindAction['kind'], 'exists' | 'wait' | 'get_text' | 'get_attrs'>;
  timeoutMs?: number;
} & SelectorSnapshotOptions;

export type FindReadCommandResult =
  | { kind: 'found'; found: true; waitedMs?: number }
  | { kind: 'text'; ref: string; text: string; node: SnapshotNode }
  | { kind: 'attrs'; ref: string; node: SnapshotNode };

export type GetCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    property: 'text' | 'attrs';
    target: ElementTarget;
    /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
    expectedResolvedTarget?: ExpectedResolvedTarget;
  };

export type GetCommandResult =
  | {
      kind: 'text';
      target: ResolvedTarget;
      text: string;
      node: SnapshotNode;
      selectorChain?: string[];
      /** ADR 0012 decision 3: the tree `node` was resolved from, for record-time evidence. */
      preActionNodes: SnapshotNode[];
    }
  | {
      kind: 'attrs';
      target: ResolvedTarget;
      node: SnapshotNode;
      selectorChain?: string[];
      /** ADR 0012 decision 3: the tree `node` was resolved from, for record-time evidence. */
      preActionNodes: SnapshotNode[];
    };

export type GetTextCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    target: ElementTarget;
  };

export type GetAttrsCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    target: ElementTarget;
  };

export type IsCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    predicate: 'visible' | 'hidden' | 'exists' | 'editable' | 'selected' | 'focused' | 'text';
    selector: string;
    expectedText?: string;
  };

export type IsCommandResult = {
  predicate: IsCommandOptions['predicate'];
  pass: true;
  selector: string;
  matches?: number;
  text?: string;
  selectorChain?: string[];
};

export type WaitCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    target:
      | { kind: 'sleep'; durationMs: number }
      | { kind: 'text'; text: string; timeoutMs?: number | null }
      | { kind: 'ref'; ref: string; timeoutMs?: number | null }
      | { kind: 'selector'; selector: string; timeoutMs?: number | null }
      | { kind: 'stable'; quietMs?: number | null; timeoutMs?: number | null };
  };

export type WaitCommandResult =
  | { kind: 'sleep'; waitedMs: number }
  | { kind: 'text'; waitedMs: number; text: string }
  | { kind: 'selector'; waitedMs: number; selector: string }
  | {
      kind: 'stable';
      waitedMs: number;
      captures: number;
      nodeCount: number;
      hint?: string;
    };

export type WaitForTextCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    text: string;
    timeoutMs?: number | null;
  };

export type IsSelectorCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    target: SelectorTarget;
  };

export function selector(expression: string): SelectorTarget {
  return { kind: 'selector', selector: expression };
}

export function ref(refInput: string, options: { fallbackLabel?: string } = {}): RefTarget {
  return {
    kind: 'ref',
    ref: refInput,
    ...(options.fallbackLabel ? { fallbackLabel: options.fallbackLabel } : {}),
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 300;

export const findCommand: RuntimeCommand<FindReadCommandOptions, FindReadCommandResult> = async (
  runtime,
  options,
): Promise<FindReadCommandResult> => {
  const locator = options.locator ?? 'any';
  if (!options.query) {
    throw new AppError('INVALID_ARGS', 'find requires a value');
  }
  if (options.action === 'wait') {
    return await waitForFindMatch(runtime, options, locator);
  }

  const { capture, match } = await findFirstLocatorMatch(runtime, options, locator);
  if (!match) {
    throw new AppError('COMMAND_FAILED', 'find did not match any element');
  }

  if (options.action === 'exists') return { kind: 'found', found: true };
  const ref = `@${match.ref}`;
  if (options.action === 'get_attrs') return { kind: 'attrs', ref, node: match };
  const text = await readText(runtime, capture, match);
  return { kind: 'text', ref, text, node: match };
};

export const getCommand: RuntimeCommand<GetCommandOptions, GetCommandResult> = async (
  runtime,
  options,
): Promise<GetCommandResult> => {
  if (options.target.kind === 'ref') {
    const capture = await requireSnapshotSession(runtime, options.session);
    const resolved = resolveRefNode(capture.snapshot.nodes, options.target.ref, {
      fallbackLabel: options.target.fallbackLabel ?? '',
      invalidRefMessage: 'get text requires a ref like @e2',
      notFoundMessage: `Ref ${options.target.ref} not found`,
    });
    assertExpectedResolvedTarget(
      resolved.node,
      capture.snapshot.nodes,
      options.expectedResolvedTarget,
      'get',
    );
    const selectorChain = buildSelectorChainForNode(resolved.node, runtime.backend.platform, {
      action: 'get',
    });
    const target = { kind: 'ref' as const, ref: `@${resolved.ref}` };
    const preActionNodes = capture.snapshot.nodes;
    if (options.property === 'attrs') {
      return { kind: 'attrs', target, node: resolved.node, selectorChain, preActionNodes };
    }
    const text = await readText(runtime, capture, resolved.node);
    return { kind: 'text', target, text, node: resolved.node, selectorChain, preActionNodes };
  }

  const resolved = await resolveSelectorNode(runtime, options, options.session ?? 'default', {
    selector: options.target.selector,
    disambiguateAmbiguous: options.property === 'text',
  });
  assertExpectedResolvedTarget(
    resolved.node,
    resolved.capture.snapshot.nodes,
    options.expectedResolvedTarget,
    'get',
  );

  const selectorChain = buildSelectorChainForNode(resolved.node, runtime.backend.platform, {
    action: 'get',
  });

  if (options.property === 'attrs') {
    return {
      kind: 'attrs',
      target: { kind: 'selector', selector: resolved.selector },
      node: resolved.node,
      selectorChain,
      preActionNodes: resolved.capture.snapshot.nodes,
    };
  }

  const text = await readText(runtime, resolved.capture, resolved.node);
  return {
    kind: 'text',
    target: { kind: 'selector', selector: resolved.selector },
    text,
    node: resolved.node,
    selectorChain,
    preActionNodes: resolved.capture.snapshot.nodes,
  };
};

export const getTextCommand: RuntimeCommand<
  GetTextCommandOptions,
  Extract<GetCommandResult, { kind: 'text' }>
> = async (runtime, options): Promise<Extract<GetCommandResult, { kind: 'text' }>> => {
  const result = await getCommand(runtime, {
    ...options,
    property: 'text',
    target: options.target,
  });
  if (result.kind !== 'text') {
    throw new AppError('COMMAND_FAILED', 'getText returned non-text result');
  }
  return result;
};

export const getAttrsCommand: RuntimeCommand<
  GetAttrsCommandOptions,
  Extract<GetCommandResult, { kind: 'attrs' }>
> = async (runtime, options): Promise<Extract<GetCommandResult, { kind: 'attrs' }>> => {
  const result = await getCommand(runtime, {
    ...options,
    property: 'attrs',
    target: options.target,
  });
  if (result.kind !== 'attrs') {
    throw new AppError('COMMAND_FAILED', 'getAttrs returned non-attrs result');
  }
  return result;
};

export const isCommand: RuntimeCommand<IsCommandOptions, IsCommandResult> = async (
  runtime,
  options,
): Promise<IsCommandResult> => {
  if (!isSupportedPredicate(options.predicate)) {
    throw new AppError('INVALID_ARGS', IS_PREDICATE_REQUIRED_MESSAGE);
  }
  if (options.predicate === 'text' && !options.expectedText) {
    throw new AppError('INVALID_ARGS', 'is text requires expected text value');
  }
  const chain = parseSelectorChain(options.selector);
  const capture = await captureSelectorSnapshot(runtime, options, {
    updateSession: true,
    ...deriveSelectorCapturePolicy({ predicate: options.predicate, selectorChain: chain }),
  });

  if (options.predicate === 'exists') {
    const matched = findSelectorChainMatch(capture.snapshot.nodes, chain, {
      platform: runtime.backend.platform,
    });
    if (!matched) {
      throw new AppError('COMMAND_FAILED', formatSelectorFailure(chain, [], { unique: false }), {
        hint: selectorFailureHint([]),
      });
    }
    return {
      predicate: options.predicate,
      pass: true,
      selector: matched.selector.raw,
      matches: matched.matches,
      selectorChain: chain.selectors.map((entry) => entry.raw),
    };
  }

  const resolved = resolveSelectorChain(capture.snapshot.nodes, chain, {
    platform: runtime.backend.platform,
    requireRect: false,
    requireUnique: true,
    disambiguateAmbiguous: false,
  });
  if (!resolved) {
    throw new AppError('COMMAND_FAILED', formatSelectorFailure(chain, [], { unique: true }), {
      command: 'is',
      reason: 'selector_not_found',
      predicate: options.predicate,
      selector: chain.raw,
      hint: selectorFailureHint([]),
    });
  }
  const result = evaluateIsPredicate({
    predicate: options.predicate,
    node: resolved.node,
    nodes: capture.snapshot.nodes,
    expectedText: options.expectedText,
    platform: runtime.backend.platform,
  });
  if (!result.pass) {
    throw new AppError(
      'COMMAND_FAILED',
      `is ${options.predicate} failed for selector ${resolved.selector.raw}: ${result.details}`,
      {
        command: 'is',
        reason: 'predicate_failed',
        predicate: options.predicate,
        selector: resolved.selector.raw,
        predicateDetails: result.details,
      },
    );
  }
  return {
    predicate: options.predicate,
    pass: true,
    selector: resolved.selector.raw,
    ...(options.predicate === 'text' ? { text: result.actualText } : {}),
    selectorChain: chain.selectors.map((entry) => entry.raw),
  };
};

export const isVisibleCommand: RuntimeCommand<IsSelectorCommandOptions, IsCommandResult> = async (
  runtime,
  options,
): Promise<IsCommandResult> =>
  await isCommand(runtime, {
    ...options,
    predicate: 'visible',
    selector: options.target.selector,
  });

export const isHiddenCommand: RuntimeCommand<IsSelectorCommandOptions, IsCommandResult> = async (
  runtime,
  options,
): Promise<IsCommandResult> =>
  await isCommand(runtime, {
    ...options,
    predicate: 'hidden',
    selector: options.target.selector,
  });

export const waitCommand: RuntimeCommand<WaitCommandOptions, WaitCommandResult> = async (
  runtime,
  options,
): Promise<WaitCommandResult> => {
  if (options.target.kind === 'sleep') {
    await sleep(runtime, options.target.durationMs);
    return { kind: 'sleep', waitedMs: options.target.durationMs };
  }
  if (options.target.kind === 'ref') {
    const capture = await requireSnapshotSession(runtime, options.session);
    const ref = normalizeRef(options.target.ref);
    if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${options.target.ref}`);
    const node = findNodeByRef(capture.snapshot.nodes, ref);
    const text = node ? resolveRefLabel(node, capture.snapshot.nodes) : undefined;
    if (!text) {
      throw new AppError('COMMAND_FAILED', `Ref ${options.target.ref} not found or has no label`);
    }
    return await waitForText(runtime, options, text, options.target.timeoutMs);
  }
  if (options.target.kind === 'selector') {
    return await waitForSelector(
      runtime,
      options,
      options.target.selector,
      options.target.timeoutMs,
    );
  }
  if (options.target.kind === 'stable') {
    return await waitForStable(runtime, options, options.target.quietMs, options.target.timeoutMs);
  }
  if (!options.target.text) throw new AppError('INVALID_ARGS', 'wait requires text');
  return await waitForText(runtime, options, options.target.text, options.target.timeoutMs);
};

export const waitForTextCommand: RuntimeCommand<
  WaitForTextCommandOptions,
  Extract<WaitCommandResult, { kind: 'text' }>
> = async (runtime, options): Promise<Extract<WaitCommandResult, { kind: 'text' }>> => {
  const result = await waitCommand(runtime, {
    ...options,
    target: { kind: 'text', text: options.text, timeoutMs: options.timeoutMs },
  });
  if (result.kind !== 'text') {
    throw new AppError('COMMAND_FAILED', 'waitForText returned non-text result');
  }
  return result;
};

async function waitForFindMatch(
  runtime: AgentDeviceRuntime,
  options: FindReadCommandOptions,
  locator: FindLocator,
): Promise<FindReadCommandResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = now(runtime);
  while (now(runtime) - start < timeout) {
    const { match } = await findFirstLocatorMatch(runtime, options, locator);
    if (match) return { kind: 'found', found: true, waitedMs: now(runtime) - start };
    await sleep(runtime, POLL_INTERVAL_MS);
  }
  throw new AppError('COMMAND_FAILED', 'find wait timed out');
}

async function findFirstLocatorMatch(
  runtime: AgentDeviceRuntime,
  options: FindReadCommandOptions,
  locator: FindLocator,
): Promise<{ capture: CapturedSnapshot; match: SnapshotNode | undefined }> {
  const selectorChain = parseFindSelectorExpression(locator, options.query);
  const capture = await captureSelectorSnapshot(runtime, options, {
    updateSession: true,
    scope: findSnapshotScope(runtime, locator, options.query, selectorChain),
    ...deriveSelectorCapturePolicy({ selectorChain }),
  });
  if (isSparseSnapshotQualityVerdict(capture.snapshot.snapshotQuality)) {
    throw sparseSelectorSnapshotError(capture.snapshot.snapshotQuality);
  }
  if (selectorChain) {
    const resolved = resolveSelectorChain(capture.snapshot.nodes, selectorChain, {
      platform: runtime.backend.platform,
      requireRect: false,
      requireUnique: false,
    });
    return { capture, match: resolved?.node };
  }
  const match = findBestMatchesByLocator(capture.snapshot.nodes, locator, options.query, {
    requireRect: false,
  }).matches[0];
  return { capture, match };
}

function findSnapshotScope(
  runtime: AgentDeviceRuntime,
  locator: FindLocator,
  query: string,
  selectorChain: SelectorChain | null,
): string | undefined {
  if (selectorChain) return undefined;
  if (runtime.backend.platform === 'web') return undefined;
  return shouldScopeFind(locator) ? query : undefined;
}

function sparseSelectorSnapshotError(verdict: SnapshotQualityVerdict): AppError {
  return new AppError('COMMAND_FAILED', 'find could not read the current accessibility tree', {
    reason: verdict.reason,
    hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth, navigate with coordinates if needed, then retry find after reaching a readable screen.',
  });
}

async function waitForSelector(
  runtime: AgentDeviceRuntime,
  options: WaitCommandOptions,
  selectorExpression: string,
  timeoutMs: number | null | undefined,
): Promise<WaitCommandResult> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = now(runtime);
  const chain = parseSelectorChain(selectorExpression);
  const capturePolicy = deriveSelectorCapturePolicy({ selectorChain: chain });
  while (now(runtime) - start < timeout) {
    const capture = await captureSelectorSnapshot(runtime, options, {
      updateSession: true,
      ...capturePolicy,
    });
    const match = findSelectorChainMatch(capture.snapshot.nodes, chain, {
      platform: runtime.backend.platform,
    });
    if (match)
      return { kind: 'selector', selector: match.selector.raw, waitedMs: now(runtime) - start };
    await sleep(runtime, POLL_INTERVAL_MS);
  }
  throw new AppError('COMMAND_FAILED', `wait timed out for selector: ${selectorExpression}`);
}

async function waitForText(
  runtime: AgentDeviceRuntime,
  options: WaitCommandOptions,
  text: string,
  timeoutMs: number | null | undefined,
): Promise<WaitCommandResult> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = now(runtime);
  while (now(runtime) - start < timeout) {
    const found = runtime.backend.findText
      ? (await runtime.backend.findText(toBackendContext(runtime, options), text)).found
      : await snapshotContainsText(runtime, options, text);
    if (found) return { kind: 'text', text, waitedMs: now(runtime) - start };
    await sleep(runtime, POLL_INTERVAL_MS);
  }
  throw new AppError('COMMAND_FAILED', `wait timed out for text: ${text}`);
}

async function snapshotContainsText(
  runtime: AgentDeviceRuntime,
  options: WaitCommandOptions,
  text: string,
): Promise<boolean> {
  const capture = await captureSelectorSnapshot(runtime, options, { updateSession: true });
  return Boolean(findNodeByLabel(capture.snapshot.nodes, text));
}

// The quiet-window loop itself lives in stable-capture.ts and is shared with
// the interaction `--settle` flag (#1101); this wrapper maps the loop outcome
// to wait's throwing semantics.
async function waitForStable(
  runtime: AgentDeviceRuntime,
  options: WaitCommandOptions,
  quietMs: number | null | undefined,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'stable' }>> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quiet = quietMs ?? DEFAULT_STABLE_QUIET_MS;
  const outcome = await runStableCaptureLoop(runtime, options, {
    quietMs: quiet,
    timeoutMs: timeout,
  });
  if (!outcome.settled) {
    throw new AppError('COMMAND_FAILED', 'wait timed out waiting for a stable UI', {
      reason: 'wait_stable_timeout',
      ...(outcome.stalled ? { captureStalled: true } : {}),
      quietMs: quiet,
      timeoutMs: timeout,
      captures: outcome.captures,
      nodeCount: outcome.nodeCount,
      ...(outcome.stalled
        ? {
            hint: 'A snapshot capture stalled past the wait timeout, so no settle verdict is available. The UI may still be readable: retry, or use screenshot to inspect the surface.',
          }
        : {}),
    });
  }
  return {
    kind: 'stable',
    waitedMs: outcome.waitedMs,
    captures: outcome.captures,
    nodeCount: outcome.nodeCount,
    ...(outcome.nodeCount < TINY_STABLE_TREE_NODE_COUNT ? { hint: TINY_STABLE_TREE_HINT } : {}),
  };
}

async function resolveSelectorNode(
  runtime: AgentDeviceRuntime,
  options: GetCommandOptions,
  sessionName: string,
  params: { selector: string; disambiguateAmbiguous: boolean },
): Promise<{ capture: CapturedSnapshot; node: SnapshotNode; selector: string; ref: string }> {
  const chain = parseSelectorChain(params.selector);
  const capture = await captureSelectorSnapshot(
    runtime,
    { ...options, session: sessionName },
    {
      updateSession: true,
      ...deriveSelectorCapturePolicy({ selectorChain: chain }),
    },
  );
  const resolved = resolveSelectorChain(capture.snapshot.nodes, chain, {
    platform: runtime.backend.platform,
    requireRect: false,
    requireUnique: true,
    disambiguateAmbiguous: params.disambiguateAmbiguous,
  });
  if (!resolved) {
    throw new AppError('COMMAND_FAILED', formatSelectorFailure(chain, [], { unique: true }), {
      hint: selectorFailureHint([]),
    });
  }
  return {
    capture,
    node: resolved.node,
    selector: resolved.selector.raw,
    ref: `@${resolved.node.ref}`,
  };
}
