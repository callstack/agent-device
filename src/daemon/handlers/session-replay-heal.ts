import { dispatchCommand } from '../../core/dispatch.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';
import type { RawSnapshotNode, SnapshotBackend, SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildSelectorChainForNode,
  resolveSelectorChain,
  splitIsSelectorArgs,
  splitSelectorFromArgs,
  tryParseSelectorChain,
} from '../../selectors/index.ts';
import { uniqueStrings } from '../../kernel/collections.ts';
import { inferFillText } from '../action-utils.ts';
import type { SessionAction, SessionState } from '../types.ts';
import { isTouchTargetCommand } from '../../replay/script-utils.ts';
import { contextFromFlags } from '../context.ts';
import { SessionStore } from '../session-store.ts';
import { buildSnapshotState } from './snapshot-capture.ts';

function parseSelectorWaitPositionals(positionals: string[]): {
  selectorExpression: string | null;
  selectorTimeout: string | null;
} {
  if (positionals.length === 0) return { selectorExpression: null, selectorTimeout: null };
  const maybeTimeout = positionals[positionals.length - 1];
  const selectorTimeout =
    maybeTimeout !== undefined && /^\d+$/.test(maybeTimeout) ? maybeTimeout : null;
  const hasTimeout = selectorTimeout !== null;
  const selectorTokens = hasTimeout ? positionals.slice(0, -1) : positionals.slice();
  const split = splitSelectorFromArgs(selectorTokens);
  if (!split || split.rest.length > 0) {
    return { selectorExpression: null, selectorTimeout: null };
  }
  return {
    selectorExpression: split.selectorExpression,
    selectorTimeout,
  };
}

// fallow-ignore-next-line complexity
export function collectReplaySelectorCandidates(action: SessionAction): string[] {
  const result: string[] = [];
  const explicitChain =
    Array.isArray(action.result?.selectorChain) &&
    action.result?.selectorChain.every((entry) => typeof entry === 'string')
      ? (action.result.selectorChain as string[])
      : [];
  result.push(...explicitChain);

  if (isTouchTargetCommand(action.command)) {
    const positionals = readTargetSelectorPositionals(action);
    const first = positionals[0] ?? '';
    if (first && !first.startsWith('@')) {
      result.push(positionals.join(' '));
    }
  }
  if (action.command === 'fill') {
    const first = action.positionals?.[0] ?? '';
    if (first && !first.startsWith('@') && Number.isNaN(Number(first))) {
      result.push(first);
    }
  }
  if (action.command === 'get') {
    const selector = action.positionals?.[1] ?? '';
    if (selector && !selector.startsWith('@')) {
      result.push(action.positionals.slice(1).join(' '));
    }
  }
  if (action.command === 'is') {
    const { split } = splitIsSelectorArgs(action.positionals);
    if (split) {
      result.push(split.selectorExpression);
    }
  }
  if (action.command === 'wait') {
    const { selectorExpression } = parseSelectorWaitPositionals(action.positionals ?? []);
    if (selectorExpression) {
      result.push(selectorExpression);
    }
  }

  return uniqueStrings(result).filter((entry) => entry.trim().length > 0);
}

function collectReplaySelectorChains(action: SessionAction) {
  return collectReplaySelectorCandidates(action)
    .map((candidate) => tryParseSelectorChain(candidate))
    .filter((chain) => chain !== null);
}

// fallow-ignore-next-line complexity
export async function healReplayAction(params: {
  action: SessionAction;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<SessionAction | null> {
  const { action, sessionName, logPath, sessionStore } = params;
  if (
    !(
      isTouchTargetCommand(action.command) || ['fill', 'get', 'is', 'wait'].includes(action.command)
    )
  ) {
    return null;
  }

  const session = sessionStore.get(sessionName);
  if (!session) return null;
  const selectorChains = collectReplaySelectorChains(action);
  if (selectorChains.length === 0) return null;

  const requiresRect = isTouchTargetCommand(action.command) || action.command === 'fill';
  const allowDisambiguation =
    isTouchTargetCommand(action.command) ||
    action.command === 'fill' ||
    (action.command === 'get' && action.positionals?.[0] === 'text');
  const snapshot = await captureSnapshotForReplay(
    session,
    action,
    logPath,
    requiresRect,
    sessionStore,
  );
  for (const chain of selectorChains) {
    const resolved = resolveSelectorChain(snapshot.nodes, chain, {
      platform: session.device.platform,
      requireRect: requiresRect,
      requireUnique: true,
      disambiguateAmbiguous: allowDisambiguation,
    });
    if (!resolved) continue;

    const selectorChain = buildSelectorChainForNode(resolved.node, session.device.platform, {
      action:
        action.command === 'fill' ? 'fill' : isTouchTargetCommand(action.command) ? 'click' : 'get',
    });
    const selectorExpression = selectorChain.join(' || ');

    if (isTouchTargetCommand(action.command)) {
      return {
        ...action,
        positionals:
          action.command === 'longpress'
            ? withLongPressDuration(action, selectorExpression)
            : [selectorExpression],
      };
    }
    if (action.command === 'fill') {
      const fillText = inferFillText(action);
      if (!fillText) continue;
      return { ...action, positionals: [selectorExpression, fillText] };
    }
    if (action.command === 'get') {
      const sub = action.positionals?.[0];
      if (sub !== 'text' && sub !== 'attrs') continue;
      return { ...action, positionals: [sub, selectorExpression] };
    }
    if (action.command === 'is') {
      const { predicate, split } = splitIsSelectorArgs(action.positionals);
      if (!predicate) continue;
      const expectedText = split?.rest.join(' ').trim() ?? '';
      const nextPositionals = [predicate, selectorExpression];
      if (predicate === 'text' && expectedText.length > 0) {
        nextPositionals.push(expectedText);
      }
      return { ...action, positionals: nextPositionals };
    }
    if (action.command === 'wait') {
      const { selectorTimeout } = parseSelectorWaitPositionals(action.positionals ?? []);
      const nextPositionals = [selectorExpression];
      if (selectorTimeout) nextPositionals.push(selectorTimeout);
      return { ...action, positionals: nextPositionals };
    }
  }
  return null;
}

function readTargetSelectorPositionals(action: SessionAction): string[] {
  const positionals = action.positionals ?? [];
  if (action.command !== 'longpress') return positionals;
  const last = positionals.at(-1);
  return positionals.length > 1 && isFiniteNumberString(last)
    ? positionals.slice(0, -1)
    : positionals;
}

function withLongPressDuration(action: SessionAction, selectorExpression: string): string[] {
  const durationMs =
    typeof action.result?.durationMs === 'number'
      ? String(action.result.durationMs)
      : readLongPressDurationFromPositionals(action.positionals ?? []);
  return durationMs ? [selectorExpression, durationMs] : [selectorExpression];
}

function readLongPressDurationFromPositionals(positionals: string[]): string | undefined {
  const last = positionals.at(-1);
  return positionals.length > 1 && isFiniteNumberString(last) ? last : undefined;
}

function isFiniteNumberString(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

async function captureSnapshotForReplay(
  session: SessionState,
  action: SessionAction,
  logPath: string,
  interactiveOnly: boolean,
  sessionStore: SessionStore,
): Promise<SnapshotState> {
  const data = (await dispatchCommand(session.device, 'snapshot', [], action.flags?.out, {
    ...contextFromFlags(
      logPath,
      {
        ...(action.flags ?? {}),
        snapshotInteractiveOnly: interactiveOnly,
      },
      session.appBundleId,
      session.trace?.outPath,
    ),
  })) as {
    nodes?: RawSnapshotNode[];
    truncated?: boolean;
    backend?: SnapshotBackend;
  };
  const snapshot = buildSnapshotState(data, {
    ...(action.flags ?? {}),
    snapshotInteractiveOnly: interactiveOnly,
  });
  setSessionSnapshot(session, snapshot);
  sessionStore.set(session.name, session);
  return snapshot;
}
