import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  ReplayRecordedTargetDisambiguation,
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetResolution,
  ReplaySelectorCandidateOptions,
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySelectorPort,
} from '@agent-device/ad-replay';

/**
 * #1478 P5 stage B: a deterministic, dependency-free `ReplaySelectorPort`
 * adapter for `packages/ad-replay`'s own contract suite
 * (`replay-selector-port-contract.test.ts`). It honors the SAME contract as
 * the production adapter (`src/daemon/replay-selector-port.ts`) — result
 * shapes, tagged reasons, and the same-alternative winner+domain invariant —
 * over a tiny in-memory matcher instead of the real `src/selectors` grammar
 * and resolution engine. Deliberately NOT reproduced: quoting edge cases
 * beyond `key="value"`, every selector key, and `options.action`'s
 * `editable=true` modifier — the contract is about shapes and invariants,
 * not grammar richness. The #1269 shared-id demotion IS reproduced (see
 * `buildSelectorCandidates`'s doc below).
 *
 * #1478 P5 stage D: relocated here from
 * `packages/ad-replay/src/internal/testing/in-memory-selector-port.ts`. It
 * only ever needed the `ReplaySelectorPort` port type and kernel snapshot
 * types — never a package-internal module — so once its only consumer
 * (`src/daemon/__tests__/replay-selector-port-contract.test.ts`) turned out
 * to be a root test (R11: only root may import the production adapter, since
 * a workspace package may never reach back into root `src/`), keeping the
 * adapter itself inside `packages/ad-replay` bought nothing: it moved
 * alongside its only caller, following the same `src/__tests__/test-utils/`
 * convention as `store-factory.ts` and `session-factories.ts`.
 *
 * #1555 structural-quality review ("typed façade replaces the zero-type
 * rule"): the `ReplaySelectorPort` family above is exported by name from
 * `@agent-device/ad-replay` directly — no intermediate root-derivation
 * module.
 *
 * Mini expression grammar: `key="value"` terms (space-separated, ANDed),
 * alternatives joined by ` || ` (first-match-wins, same as the real chain).
 * Supported keys: `id`, `label`, `role`, `value`, `text` (text matches either
 * label or value, a stand-in for the real `extractNodeText` fallback).
 *
 * `buildSelectorCandidates`'s `ReplaySelectorCandidateOptions` coverage:
 * `options.nodes` IS honored, for the #1269 shared-id demotion — an `id`
 * candidate is dropped (never appended, not merely reordered) when two or
 * more nodes in `options.nodes` carry the same `identifier`, mirroring
 * `src/selectors/build.ts`'s `selectableId`/`idMatchCountInTree` decision
 * (mini-grammar simplification: raw trimmed `node.identifier` equality
 * rather than the production NFC+256-byte-cap canonical identity — the two
 * agree for every ASCII fixture id this suite uses). `options.action`'s
 * `editable=true` modifier is deliberately NOT reproduced, same as the other
 * grammar-richness gaps noted above.
 */
export function createInMemoryReplaySelectorPort(): ReplaySelectorPort {
  return {
    readSelectorExpression,
    resolveRecordedTarget,
    buildSelectorCandidates,
  };
}

// ---------------------------------------------------------------------------
// Mini expression grammar
// ---------------------------------------------------------------------------

type MiniTermKey = 'id' | 'label' | 'role' | 'value' | 'text';
type MiniTerm = { readonly key: MiniTermKey; readonly value: string };
type MiniAlternative = readonly MiniTerm[];

const TERM_PATTERN = /^(id|label|role|value|text)=(?:"([^"]*)"|(\S+))$/;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ' ' && !inQuotes) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseTerm(token: string): MiniTerm | null {
  const match = TERM_PATTERN.exec(token);
  if (!match) return null;
  const key = match[1] as MiniTermKey;
  const value = match[2] ?? match[3] ?? '';
  return { key, value };
}

function parseAlternative(raw: string): MiniAlternative | null {
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) return null;
  const terms: MiniTerm[] = [];
  for (const token of tokens) {
    const term = parseTerm(token);
    if (!term) return null;
    terms.push(term);
  }
  return terms;
}

/** The in-memory stand-in for `tryParseSelectorChain`: `null` on any malformed alternative. */
function parseExpression(expression: string): MiniAlternative[] | null {
  const rawAlternatives = expression.split('||');
  const alternatives: MiniAlternative[] = [];
  for (const raw of rawAlternatives) {
    const alt = parseAlternative(raw);
    if (!alt) return null;
    alternatives.push(alt);
  }
  return alternatives.length > 0 ? alternatives : null;
}

function matchesTerm(node: SnapshotNode, term: MiniTerm): boolean {
  switch (term.key) {
    case 'id':
      return node.identifier === term.value;
    case 'label':
      return node.label === term.value;
    case 'role':
      return (node.type ?? '').toLowerCase() === term.value.toLowerCase();
    case 'value':
      return node.value === term.value;
    case 'text':
      return node.label === term.value || node.value === term.value;
  }
}

function matchesAlternative(node: SnapshotNode, alt: MiniAlternative): boolean {
  return alt.every((term) => matchesTerm(node, term));
}

function looksSelectorShaped(candidate: string): boolean {
  return /\b(id|label|role|value|text)=/.test(candidate);
}

// ---------------------------------------------------------------------------
// Operation 1: readSelectorExpression
// ---------------------------------------------------------------------------

function readSelectorExpression(
  grammar: ReplaySelectorGrammar,
  positionals: readonly string[],
): ReplaySelectorExpressionOutcome {
  if (positionals.length === 0) return { kind: 'not-applicable' };
  // 'is' may be predicate-first ("visible", "text ...") or selector-first;
  // a leading token with no '=' is treated as the predicate and dropped, the
  // same predicate-first/selector-first duality `splitIsSelectorArgs` covers.
  const first = positionals[0];
  const candidateTokens =
    grammar === 'is' && first !== undefined && !first.includes('=')
      ? positionals.slice(1)
      : positionals.slice();
  if (candidateTokens.length === 0) return { kind: 'not-applicable' };
  // Try the longest prefix first, shrinking until something selector-shaped
  // is found — mirrors `splitSelectorFromArgs`'s trailing-value handling.
  for (let end = candidateTokens.length; end > 0; end -= 1) {
    const candidate = candidateTokens.slice(0, end).join(' ');
    if (!looksSelectorShaped(candidate)) continue;
    if (!parseExpression(candidate)) return { kind: 'invalid' };
    return { kind: 'expression', expression: candidate, rest: candidateTokens.slice(end) };
  }
  return { kind: 'not-applicable' };
}

// ---------------------------------------------------------------------------
// Operation 2: resolveRecordedTarget
// ---------------------------------------------------------------------------

function rectOk(node: SnapshotNode, requireRect: boolean): boolean {
  return !requireRect || Boolean(node.rect);
}

function areaOf(node: SnapshotNode): number {
  return node.rect ? node.rect.width * node.rect.height : Number.POSITIVE_INFINITY;
}

/** Deepest-then-smallest-area, mirroring `compareDisambiguationCandidates`; `null` on an exact tie. */
function pickTiebreak(
  candidates: readonly SnapshotNode[],
): { winner: SnapshotNode; tiebreak: 'deepest' | 'smallest-area' } | null {
  let best: SnapshotNode | undefined;
  let tie = false;
  let decidingCriterion: 'deepest' | 'smallest-area' = 'deepest';
  for (const node of candidates) {
    if (!best) {
      best = node;
      continue;
    }
    const depthBest = best.depth ?? 0;
    const depthNode = node.depth ?? 0;
    if (depthNode !== depthBest) {
      if (depthNode > depthBest) {
        best = node;
        tie = false;
        decidingCriterion = 'deepest';
      }
      continue;
    }
    const areaBest = areaOf(best);
    const areaNode = areaOf(node);
    if (areaNode !== areaBest) {
      if (areaNode < areaBest) {
        best = node;
        tie = false;
        decidingCriterion = 'smallest-area';
      }
      continue;
    }
    tie = true;
  }
  if (!best || tie) return null;
  return { winner: best, tiebreak: decidingCriterion };
}

function resolveRecordedTarget(
  expression: string,
  nodes: SnapshotNode[],
  policy: ReplayRecordedTargetPolicy,
): ReplayRecordedTargetResolution {
  const chain = parseExpression(expression);
  if (!chain) {
    return { kind: 'unresolved', reason: 'parse-invalid', matchedNodes: [] };
  }
  for (const alt of chain) {
    const candidates = nodes.filter(
      (node) => rectOk(node, policy.requireRect) && matchesAlternative(node, alt),
    );
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      const [winner] = candidates;
      if (winner) return { kind: 'resolved', winner, matchedNodes: candidates, matchCount: 1 };
    }
    if (policy.allowDisambiguation) {
      const picked = pickTiebreak(candidates);
      if (picked) {
        const disambiguation: ReplayRecordedTargetDisambiguation = {
          tiebreak: picked.tiebreak,
          matchCount: candidates.length,
          alternatives: candidates.filter((node) => node !== picked.winner),
        };
        return {
          kind: 'resolved',
          winner: picked.winner,
          matchedNodes: candidates,
          matchCount: candidates.length,
          disambiguation,
        };
      }
    }
    // Ambiguous and unresolved on this alternative — try the next one, same
    // as `resolveSelectorChain`'s per-alternative `continue`.
  }
  // No alternative produced a winner. Report the diagnostic domain of the
  // first alternative with any match at all (mirrors `listSelectorChainMatches`).
  for (const alt of chain) {
    const candidates = nodes.filter(
      (node) => rectOk(node, policy.requireRect) && matchesAlternative(node, alt),
    );
    if (candidates.length > 0) {
      return { kind: 'unresolved', reason: 'ambiguous', matchedNodes: candidates };
    }
  }
  return { kind: 'unresolved', reason: 'no-match', matchedNodes: [] };
}

// ---------------------------------------------------------------------------
// Operation 3: buildSelectorCandidates
// ---------------------------------------------------------------------------

function quoted(value: string): string {
  return `"${value}"`;
}

function trimmedOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * #1269 shared-id demotion, mini-grammar form: mirrors
 * `src/selectors/build.ts`'s `selectableId` — an id that denotes more than
 * one node in the record-time tree is DROPPED (never appended to the
 * candidate list), not reordered or kept-but-deprioritized. The production
 * decision keys off `idMatchCountInTree`'s canonical (NFC + 256-byte-cap)
 * identity id; this mini form counts raw trimmed `node.identifier` equality
 * instead, which agrees with the canonical count for every plain-ASCII
 * fixture id this suite uses.
 */
function selectableId(
  node: SnapshotNode,
  nodes: readonly SnapshotNode[] | undefined,
): string | null {
  const id = trimmedOrNull(node.identifier);
  if (!id || !nodes) return id;
  let matchCount = 0;
  for (const candidate of nodes) {
    if (trimmedOrNull(candidate.identifier) === id) matchCount += 1;
  }
  return matchCount > 1 ? null : id;
}

function buildSelectorCandidates(
  node: SnapshotNode,
  _platform: unknown,
  options: ReplaySelectorCandidateOptions = {},
): readonly string[] {
  const id = selectableId(node, options.nodes);
  const role = (node.type ?? '').toLowerCase();
  const label = trimmedOrNull(node.label);
  const value = trimmedOrNull(node.value);
  const candidates: string[] = [];
  if (id) candidates.push(`id=${quoted(id)}`);
  if (role && label) candidates.push(`role=${quoted(role)} label=${quoted(label)}`);
  if (label) candidates.push(`label=${quoted(label)}`);
  if (value) candidates.push(`value=${quoted(value)}`);
  return Array.from(new Set(candidates));
}
