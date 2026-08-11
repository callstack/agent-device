import {
  FIND_VALUE_REQUIRED_MESSAGE,
  findBestMatchesByLocator,
  formatSelectorFailure,
  selectorFailureHint,
  buildSelectorChainForNode,
  checkIsPredicate,
  evaluateIsPredicate,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  readSelectorAlternatives,
  parseFindSelectorExpression,
  type FindAction,
  type FindLocator,
} from '@agent-device/selectors';
import {
  listSelectorPipelineMatches,
  resolveSelectorPipeline,
  type SelectorPipelineHooks,
} from '../../../core/selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isSparseSnapshotQualityVerdict } from '../../../snapshot-quality/verdict.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { AppError } from '@agent-device/kernel/errors';
import type {
  ElementTarget,
  FindReadResult,
  ResolvedTarget,
  SelectorTarget,
} from '@agent-device/contracts/interaction';
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
import { findSnapshotScope, sparseSelectorSnapshotError } from './selector-read-utils.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';
import { createWaitPolling, type WaitPollDeadline, waitTimeoutError } from './wait-polling.ts';
import {
  createSelectorWaitCommands,
  type WaitCommandOptions,
  type WaitCommandResult,
  type WaitForTextCommandOptions,
} from './selector-wait.ts';
import {
  DEFAULT_STABLE_QUIET_MS,
  runStableCaptureLoop,
  TINY_STABLE_TREE_HINT,
  TINY_STABLE_TREE_NODE_COUNT,
} from './stable-capture.ts';

export type { SelectorSnapshotOptions } from './selector-read-shared.ts';
export type {
  WaitCommandOptions,
  WaitCommandResult,
  WaitForTextCommandOptions,
} from './selector-wait.ts';
export type { ElementTarget, ResolvedTarget, SelectorTarget };

export type FindReadCommandOptions = CommandContext & {
  locator?: FindLocator;
  query: string;
  action: Extract<FindAction['kind'], 'exists' | 'wait' | 'get_text' | 'get_attrs' | 'list'>;
  timeoutMs?: number;
} & SelectorSnapshotOptions;

export type FindReadCommandResult = FindReadResult;

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
    /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
    expectedResolvedTarget?: ExpectedResolvedTarget;
  };

export type IsCommandResult = {
  predicate: IsCommandOptions['predicate'];
  pass: true;
  selector: string;
  matches?: number;
  text?: string;
  selectorChain?: string[];
  /** ADR 0012 decision 3 / #1349: the resolved node and its tree, for record-time evidence (absent for `exists`). */
  node?: SnapshotNode;
  preActionNodes?: SnapshotNode[];
};

export type IsSelectorCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    target: SelectorTarget;
  };

const selectorWaitCommands = createSelectorWaitCommands<AgentDeviceRuntime>({
  captureSnapshot: captureSelectorSnapshot,
  requireSnapshot: requireSnapshotSession,
  stable: {
    defaultQuietMs: DEFAULT_STABLE_QUIET_MS,
    tinyTreeHint: TINY_STABLE_TREE_HINT,
    tinyTreeNodeCount: TINY_STABLE_TREE_NODE_COUNT,
    capture: runStableCaptureLoop,
  },
});

export const waitCommand: RuntimeCommand<WaitCommandOptions, WaitCommandResult> =
  selectorWaitCommands.waitCommand;

export const waitForTextCommand: RuntimeCommand<
  WaitForTextCommandOptions,
  Extract<WaitCommandResult, { kind: 'text' }>
> = selectorWaitCommands.waitForTextCommand;

export const findCommand: RuntimeCommand<FindReadCommandOptions, FindReadCommandResult> = async (
  runtime,
  options,
): Promise<FindReadCommandResult> => {
  const locator = options.locator ?? 'any';
  if (!options.query) {
    throw new AppError('INVALID_ARGS', FIND_VALUE_REQUIRED_MESSAGE);
  }
  if (options.action === 'wait') {
    return await waitForFindMatch(runtime, options, locator);
  }
  if (options.action === 'list') {
    return await listFindMatches(runtime, options, locator);
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
      nodes: capture.snapshot.nodes,
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
    policy:
      options.property === 'text'
        ? SELECTOR_PIPELINE_POLICIES.readText
        : SELECTOR_PIPELINE_POLICIES.readUnique,
    hooks: {
      onResolved: (node, nodes) =>
        assertExpectedResolvedTarget(node, nodes, options.expectedResolvedTarget, 'get'),
    },
  });

  const selectorChain = buildSelectorChainForNode(resolved.node, runtime.backend.platform, {
    action: 'get',
    nodes: resolved.capture.snapshot.nodes,
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
  const admitted = checkIsPredicate(options.predicate);
  if (!admitted.ok) throw new AppError(admitted.code, admitted.message, { hint: admitted.hint });
  // Admission normalizes case, so every decision below reads the ADMITTED value: the raw
  // option would send an uppercase predicate past the gate and then evaluate it against
  // lower-case branches, admitting `EXISTS`/`TEXT` and returning the wrong answer.
  const predicate = admitted.predicate;
  if (predicate === 'text' && !options.expectedText) {
    throw new AppError('INVALID_ARGS', IS_TEXT_VALUE_REQUIRED_MESSAGE);
  }
  const selectorExpression = options.selector;
  const capture = await captureSelectorSnapshot(runtime, options, {
    updateSession: true,
    ...deriveSelectorCapturePolicy(predicate),
  });

  if (predicate === 'exists') {
    // `readAny`, the same row find's read actions use: presence is the
    // question, so any match count passes and the first one answers. The row
    // already documented itself as serving `exists`, but this branch used to
    // reach the engine directly — the claim was true of the docs and not of
    // the code (#1630).
    const matched = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES.readAny,
      capture.snapshot.nodes,
      selectorExpression,
      { platform: runtime.backend.platform },
    );
    if (matched.kind !== 'target') {
      throw new AppError(
        'COMMAND_FAILED',
        formatSelectorFailure(selectorExpression, [], { unique: false }),
        {
          hint: selectorFailureHint([]),
        },
      );
    }
    return {
      predicate: predicate,
      pass: true,
      selector: matched.selector,
      matches: matched.matches,
      selectorChain: readSelectorAlternatives(selectorExpression),
    };
  }

  // `readUnique` is the fail-closed row: an ambiguous screen reports the same
  // refusal as no match at all, because `is` must never guess which duplicate
  // it answered about.
  const outcome = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.readUnique,
    capture.snapshot.nodes,
    selectorExpression,
    { platform: runtime.backend.platform },
    {
      onResolved: (node, nodes) =>
        assertExpectedResolvedTarget(node, nodes, options.expectedResolvedTarget, 'is'),
    },
  );
  if (outcome.kind !== 'target') {
    throw new AppError(
      'COMMAND_FAILED',
      formatSelectorFailure(selectorExpression, [], { unique: true }),
      {
        command: 'is',
        reason: 'selector_not_found',
        predicate: predicate,
        selector: selectorExpression,
        hint: selectorFailureHint([]),
      },
    );
  }
  const resolved = outcome;
  const result = evaluateIsPredicate({
    predicate: predicate,
    node: resolved.node,
    nodes: capture.snapshot.nodes,
    expectedText: options.expectedText,
    platform: runtime.backend.platform,
  });
  if (!result.pass) {
    throw new AppError(
      'COMMAND_FAILED',
      `is ${predicate} failed for selector ${resolved.selector}: ${result.details}`,
      {
        command: 'is',
        reason: 'predicate_failed',
        predicate: predicate,
        selector: resolved.selector,
        predicateDetails: result.details,
      },
    );
  }
  return {
    predicate: predicate,
    pass: true,
    selector: resolved.selector,
    ...(predicate === 'text' ? { text: result.actualText } : {}),
    selectorChain: readSelectorAlternatives(selectorExpression),
    node: resolved.node,
    preActionNodes: capture.snapshot.nodes,
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

async function waitForFindMatch(
  runtime: AgentDeviceRuntime,
  options: FindReadCommandOptions,
  locator: FindLocator,
): Promise<FindReadCommandResult> {
  const polling = createWaitPolling(
    runtime,
    options,
    options.timeoutMs,
    SELECTOR_PIPELINE_POLICIES.findWait,
  );
  let deadline: WaitPollDeadline | undefined;
  while (polling.hasTimeRemaining()) {
    // A presence check never consumes scroll hints, so every poll skips deriving them —
    // otherwise a single pathological `dumpsys activity top` call can eat the whole wait
    // budget from inside this loop (#1270).
    const poll = await polling.capture(
      async (signal) =>
        await findFirstLocatorMatch(runtime, { ...options, signal }, locator, {
          includeHiddenContentHints: false,
        }),
    );
    if (poll.timedOut) {
      deadline = poll.deadline;
      break;
    }
    if (poll.value?.match) {
      return { kind: 'found', found: true, waitedMs: polling.waitedMs() };
    }
    await polling.sleepUntilNextPoll();
  }
  throw waitTimeoutError('find wait timed out', polling, deadline);
}

/**
 * `find <q> list` (#1625): the inspection path. Returns EVERY match — unique
 * included — with its ref, and never narrows or taps. The old recovery hint
 * told agents to run bare `find` to "list matches", which clicks a unique
 * match; this is the surface that guidance actually needed.
 */
async function listFindMatches(
  runtime: AgentDeviceRuntime,
  options: FindReadCommandOptions,
  locator: FindLocator,
): Promise<Extract<FindReadCommandResult, { kind: 'list' }>> {
  const selectorExpression = parseFindSelectorExpression(locator, options.query);
  // Deliberately UNSCOPED: findSnapshotScope narrows the capture to the first
  // label match, which is exactly wrong for an action whose purpose is to show
  // every match.
  const capture = await captureSelectorSnapshot(runtime, options, {
    updateSession: true,
    ...deriveSelectorCapturePolicy(),
  });
  if (isSparseSnapshotQualityVerdict(capture.snapshot.snapshotQuality)) {
    throw sparseSelectorSnapshotError(capture.snapshot.snapshotQuality);
  }
  const matched = selectorExpression
    ? (listSelectorPipelineMatches(
        SELECTOR_PIPELINE_POLICIES.readList,
        capture.snapshot.nodes,
        selectorExpression,
        { platform: runtime.backend.platform },
      ).list?.matchedNodes ?? [])
    : findBestMatchesByLocator(capture.snapshot.nodes, locator, options.query, {}).matches;
  return {
    kind: 'list',
    matches: matched.map((node) => ({ ref: `@${node.ref}`, node })),
  };
}

async function findFirstLocatorMatch(
  runtime: AgentDeviceRuntime,
  options: FindReadCommandOptions,
  locator: FindLocator,
  captureOverrides?: { includeHiddenContentHints?: boolean },
): Promise<{ capture: CapturedSnapshot; match: SnapshotNode | undefined }> {
  const selectorExpression = parseFindSelectorExpression(locator, options.query);
  const capture = await captureSelectorSnapshot(runtime, options, {
    updateSession: true,
    scope: findSnapshotScope(runtime.backend.platform, locator, options.query, selectorExpression),
    includeHiddenContentHints: captureOverrides?.includeHiddenContentHints,
    ...deriveSelectorCapturePolicy(),
  });
  if (isSparseSnapshotQualityVerdict(capture.snapshot.snapshotQuality)) {
    throw sparseSelectorSnapshotError(capture.snapshot.snapshotQuality);
  }
  if (selectorExpression) {
    const outcome = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES.readAny,
      capture.snapshot.nodes,
      selectorExpression,
      { platform: runtime.backend.platform },
    );
    return { capture, match: outcome.kind === 'target' ? outcome.node : undefined };
  }
  const match = findBestMatchesByLocator(capture.snapshot.nodes, locator, options.query, {
    requireRect: false,
  }).matches[0];
  return { capture, match };
}

/**
 * `get` names the two pipeline rows it may consume by type: `readText`
 * disambiguates through the same tiebreak acting uses, `readUnique` fails
 * closed, and both observe rather than act. Any other row is a compile error
 * here rather than a silent change to what `get` binds to — or, since #1656,
 * to which structural stages a read would start running.
 */
type GetPipelinePolicy = (typeof SELECTOR_PIPELINE_POLICIES)['readText' | 'readUnique'];

async function resolveSelectorNode(
  runtime: AgentDeviceRuntime,
  options: GetCommandOptions,
  sessionName: string,
  params: { selector: string; policy: GetPipelinePolicy; hooks?: SelectorPipelineHooks },
): Promise<{ capture: CapturedSnapshot; node: SnapshotNode; selector: string; ref: string }> {
  const capture = await captureSelectorSnapshot(
    runtime,
    { ...options, session: sessionName },
    {
      updateSession: true,
      ...deriveSelectorCapturePolicy(),
    },
  );
  const outcome = await resolveSelectorPipeline(
    params.policy,
    capture.snapshot.nodes,
    params.selector,
    { platform: runtime.backend.platform },
    params.hooks,
  );
  if (outcome.kind !== 'target') {
    throw new AppError(
      'COMMAND_FAILED',
      formatSelectorFailure(params.selector, [], { unique: true }),
      {
        hint: selectorFailureHint([]),
      },
    );
  }
  return {
    capture,
    node: outcome.node,
    selector: outcome.selector,
    ref: `@${outcome.node.ref}`,
  };
}
