import type { SettleObservation } from '@agent-device/contracts/interaction';
import { readElementMatchCandidateRefs } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isCommandName, type CommandName } from '../commands/command-metadata.ts';
import type { CommandExecutionResult } from '../commands/command-surface.ts';
import {
  commandDescriptors,
  commandSupportsSettleObservation,
} from '../core/command-descriptor/registry.ts';
import { asOptionalRecord } from '@agent-device/kernel/record';

export type ToolRefPinStore = {
  pinInput(
    name: CommandName,
    input: Record<string, unknown>,
    stateDir: string | undefined,
  ): Record<string, unknown>;
  mergeCommandResult(
    name: CommandName,
    result: CommandExecutionResult,
    stateDir: string | undefined,
    session: unknown,
  ): void;
  mergeErrorDetails(
    details: Record<string, unknown> | undefined,
    stateDir: string | undefined,
    session: unknown,
  ): void;
};

export function createToolRefPinStore(): ToolRefPinStore {
  const refPinsByScope = new Map<string, Map<string, number>>();
  return {
    pinInput: (name, input, stateDir) =>
      pinPlainRefArguments(name, input, getScopePins(refPinsByScope, stateDir, input.session)),
    mergeCommandResult: (name, result, stateDir, session) =>
      mergeCommandResult(refPinsByScope, name, result, stateDir, session),
    mergeErrorDetails: (details, stateDir, session) => {
      const scopeKey = makeScopeKey(stateDir, session);
      mergeErrorCandidateRefPins(refPinsByScope, scopeKey, details);
      mergeDivergenceScreenRefPins(refPinsByScope, scopeKey, details);
    },
  };
}

function mergeErrorCandidateRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  details: Record<string, unknown> | undefined,
): void {
  const refsGeneration = details?.refsGeneration;
  if (typeof refsGeneration !== 'number') return;
  mergeIntoScopedPins(
    refPinsByScope,
    scopeKey,
    readElementMatchCandidateRefs(details),
    refsGeneration,
  );
}

/**
 * #1076 versioned refs — MCP auto-pinning. Snapshot trees and find outputs
 * keep plain `e12` refs (snapshots are the most token-expensive artifact the
 * model consumes); the issuing response carries the tree's generation ONCE as
 * `refsGeneration`. This layer sees those responses before the model does and
 * keeps PER-REF provenance: every ref present in a ref-issuing response is
 * recorded at that response's generation, and refs absent from it KEEP their
 * older pins. That per-ref memory is the point — after snapshot(s12) then
 * find(s13), a plain `@e37` from the pre-find snapshot must still forward as
 * `@e37~s12` so the daemon warns precisely; a single last-seen generation
 * would silently re-bless it at s13 (the exact find-blessing hole #1076
 * describes). Refs never seen in an issuing response pass through unpinned
 * (the coarse #1093 warning is the floor). The model never sees or types
 * suffixes.
 */
const REF_ISSUING_TOOLS: ReadonlySet<CommandName> = new Set(['snapshot', 'find'] as const);

/**
 * `--settle` (#1101) makes a response CONDITIONALLY ref-issuing: when it
 * carries `settle.diff` + `settle.refsGeneration`, the diff's added lines hand
 * out refs minted from the freshly stored settled tree. These tools are NOT in
 * REF_ISSUING_TOOLS on purpose — a plain (non-settle) press carries no
 * generation, and treating that as "issuing response without a generation"
 * would clear the scope's pins on every ordinary tap. Absent or diff-less
 * settle payloads leave pins untouched.
 *
 * Derived from the descriptor trait rather than hand-listed: a command that
 * grows `--settle` (scroll/back, #1638) issues refs the moment it can produce a
 * settled diff, and a hand list would silently stop pinning them.
 */
const SETTLE_REF_ISSUING_TOOLS: ReadonlySet<CommandName> = new Set(
  commandDescriptors
    .map((descriptor) => descriptor.name)
    .filter(isCommandName)
    .filter((name) => commandSupportsSettleObservation(name)),
);

const TARGET_REF_TOOLS: ReadonlySet<CommandName> = new Set([
  'press',
  'click',
  'fill',
  'longpress',
  'hover',
  'get',
] as const);

/**
 * Bound on remembered pins per scope. Refs still alive keep getting re-merged
 * at the latest generation by every snapshot, so evicting the least recently
 * ISSUED pins only degrades stale-ref precision back to the coarse floor.
 */
const MAX_REF_PINS_PER_SCOPE = 1000;

function getScopePins(
  refPinsByScope: Map<string, Map<string, number>>,
  stateDir: string | undefined,
  session: unknown,
): Map<string, number> | undefined {
  return refPinsByScope.get(makeScopeKey(stateDir, session));
}

/**
 * Pin scope: state dir + session name. `stateDir` is a per-tool-call MCP
 * config field, so one MCP server process can serve daemons in different
 * state dirs — two same-named sessions there are different sessions and must
 * not cross-pollinate generations.
 */
function makeScopeKey(stateDir: string | undefined, session: unknown): string {
  const sessionName = typeof session === 'string' && session.length > 0 ? session : 'default';
  // NUL separator: neither state-dir paths nor session names contain it.
  return `${stateDir ?? ''}\u0000${sessionName}`;
}

function mergeCommandResult(
  refPinsByScope: Map<string, Map<string, number>>,
  name: CommandName,
  result: CommandExecutionResult,
  stateDir: string | undefined,
  session: unknown,
): void {
  const scopeKey = makeScopeKey(stateDir, session);
  if (SETTLE_REF_ISSUING_TOOLS.has(name)) {
    mergeSettleIssuedRefPins(refPinsByScope, scopeKey, readSettleObservation(result));
    return;
  }
  if (!REF_ISSUING_TOOLS.has(name)) return;
  if (name === 'find') {
    mergeFindRefPins(refPinsByScope, scopeKey, result as CommandExecutionResult<'find'>);
  } else {
    mergeSnapshotRefPins(refPinsByScope, scopeKey, result as CommandExecutionResult<'snapshot'>);
  }
}

/**
 * MERGE-ONLY update rule: refs present in the issuing response move to its
 * generation; absent refs keep their older pins (an old pin on a replaced
 * tree is exactly what makes the daemon warn). A ref-issuing response WITHOUT
 * a `refsGeneration` (older remote daemon, find with no ref match) clears the
 * whole scope — never guess. (A local daemon always matches the client
 * version; see the version-skew invariant in CONTEXT.md.)
 */
type SnapshotPinView = {
  refsGeneration?: number;
  refs?: Array<{ ref: string }>;
  nodes?: SnapshotNode[];
};

function mergeSnapshotRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  result: SnapshotPinView,
): void {
  const refsGeneration = result.refsGeneration;
  if (typeof refsGeneration !== 'number') {
    refPinsByScope.delete(scopeKey);
    return;
  }
  const bodies: string[] = [];
  for (const { ref } of result.refs ?? []) {
    bodies.push(ref);
  }
  for (const node of result.nodes ?? []) {
    bodies.push(node.ref);
  }
  mergeIntoScopedPins(refPinsByScope, scopeKey, bodies, refsGeneration);
}

function mergeFindRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  result: CommandExecutionResult<'find'>,
): void {
  // ADR 0014: a MUTATING find returns its acted ref as diagnostic pre-action
  // identity WITHOUT `refsGeneration` — it is explicitly non-issuing and must
  // leave remembered pins untouched (forwarding the old pin on a later ref is
  // how the daemon produces a precise stale rejection). Only a read-only find
  // that genuinely found refs with a generation gets pinned: the singular
  // `ref` for single-match actions, every `matches[]` ref for `list` (the
  // daemon published a partial frame for exactly those bodies, so an unpinned
  // plain `@eN` follow-up would be rejected with
  // `plain_ref_requires_complete_frame`).
  const refsGeneration = result.refsGeneration;
  if (typeof refsGeneration !== 'number') return;
  const issued: string[] = [];
  if (typeof result.ref === 'string' && result.ref.startsWith('@')) {
    issued.push(result.ref.slice(1));
  }
  for (const match of result.matches ?? []) {
    if (typeof match.ref === 'string' && match.ref.length > 0) {
      issued.push(match.ref.startsWith('@') ? match.ref.slice(1) : match.ref);
    }
  }
  mergeIntoScopedPins(refPinsByScope, scopeKey, issued, refsGeneration);
}

/**
 * MERGE-ONLY, like the snapshot/find rule: refs on the settled diff's added
 * lines (plus the unchanged-interactive `tail`, when present) move to the
 * settle generation; every other pin stays put (the settle capture replaced
 * the tree, so an old pin on an unchanged-looking element is exactly what
 * makes the daemon warn precisely). No settle payload, no diff, no digest
 * refs, or no generation → not an issuing response; pins are left untouched.
 */
function mergeSettleIssuedRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  settle: SettleObservation | undefined,
): void {
  if (settle?.refsGeneration === undefined) return;
  const issuedRefs = [...(settle.diff?.lines ?? []), ...(settle.refs ?? []), ...(settle.tail ?? [])]
    .map((entry) => entry.ref)
    .filter((ref): ref is string => typeof ref === 'string');
  mergeIntoScopedPins(refPinsByScope, scopeKey, issuedRefs, settle.refsGeneration);
}

/**
 * The settle payload as this layer reads it. `scroll`/`back` results are not in
 * the typed-result spine (CommandResultMap), so the field is read structurally
 * rather than through a per-command result union.
 */
function readSettleObservation(result: CommandExecutionResult): SettleObservation | undefined {
  const settle = (result as { settle?: unknown }).settle;
  return settle !== null && typeof settle === 'object' ? (settle as SettleObservation) : undefined;
}

/** Shared merge-only tail: skip empty issuance, else create-or-reuse the scope's pin map and record. */
function mergeIntoScopedPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  issuedRefs: string[],
  refsGeneration: number,
): void {
  if (issuedRefs.length === 0) return;
  const pins = refPinsByScope.get(scopeKey) ?? new Map<string, number>();
  refPinsByScope.set(scopeKey, pins);
  recordIssuedPins(pins, issuedRefs, refsGeneration);
}

function recordIssuedPins(
  pins: Map<string, number>,
  issuedRefs: string[],
  refsGeneration: number,
): void {
  for (const ref of issuedRefs) {
    // delete-then-set keeps Map insertion order = issue recency for the cap.
    pins.delete(ref);
    pins.set(ref, refsGeneration);
  }
  while (pins.size > MAX_REF_PINS_PER_SCOPE) {
    pins.delete(pins.keys().next().value!);
  }
}

function mergeDivergenceScreenRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  details: Record<string, unknown> | undefined,
): void {
  const divergence = asOptionalRecord(details?.divergence);
  const screen = asOptionalRecord(divergence?.screen);
  if (screen?.state !== 'available') return;
  const refsGeneration = screen.refsGeneration;
  if (typeof refsGeneration !== 'number') return;
  const issuedRefs: string[] = [];
  collectDivergenceRefs(screen.refs, issuedRefs);
  mergeIntoScopedPins(refPinsByScope, scopeKey, issuedRefs, refsGeneration);
}

function collectDivergenceRefs(refs: unknown, into: string[]): void {
  if (!Array.isArray(refs)) return;
  for (const entry of refs) {
    const ref = asOptionalRecord(entry)?.ref;
    if (typeof ref === 'string' && ref.length > 0) into.push(ref);
  }
}

function pinPlainRefArguments(
  name: CommandName,
  input: Record<string, unknown>,
  pins: Map<string, number> | undefined,
): Record<string, unknown> {
  // No remembered pins for this scope → pass refs through unpinned.
  if (pins === undefined || pins.size === 0) return input;
  if (name === 'wait') return pinWaitRef(input, pins) ?? input;
  if (TARGET_REF_TOOLS.has(name)) return pinTargetRef(input, pins) ?? input;
  return input;
}

function pinWaitRef(
  record: Record<string, unknown>,
  pins: Map<string, number>,
): Record<string, unknown> | undefined {
  if (typeof record.ref !== 'string') return undefined;
  const pinned = pinRef(record.ref, pins);
  return pinned === record.ref ? undefined : { ...record, ref: pinned };
}

function pinTargetRef(
  record: Record<string, unknown>,
  pins: Map<string, number>,
): Record<string, unknown> | undefined {
  const target = asOptionalRecord(record.target);
  if (target?.kind !== 'ref' || typeof target.ref !== 'string') return undefined;
  const pinned = pinRef(target.ref, pins);
  return pinned === target.ref ? undefined : { ...record, target: { ...target, ref: pinned } };
}

function pinRef(ref: string, pins: Map<string, number>): string {
  // Only pin the canonical plain form `@e12`: an existing `~` means the ref is
  // already pinned (or malformed — the daemon owns rejecting that), and a
  // missing `@` prefix is not a ref the daemon would accept anyway. Refs with
  // no recorded provenance pass through unpinned — never guess.
  if (!ref.startsWith('@') || ref.includes('~')) return ref;
  const generation = pins.get(ref.slice(1));
  return generation === undefined ? ref : `${ref}~s${generation}`;
}
