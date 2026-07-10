import type { ResponseLevel } from '../kernel/contracts.ts';
import { redactDiagnosticData } from '../kernel/redaction.ts';

/**
 * ADR 0012 migration step 2: structured replay divergence report.
 *
 * `kind` is scoped to `'action-failure'` in this step — the target-binding
 * kinds (`selector-miss`/`identity-mismatch`/`identity-unverifiable`) are
 * decision 3/step 4 territory and are not produced here. `targetBinding` is
 * likewise out of scope (step 4).
 */
export type ReplayDivergenceKind = 'action-failure';

export type ReplayDivergenceStepSource = {
  path: string;
  line: number;
};

export type ReplayDivergenceStep = {
  /** 1-based executable-plan ordinal, not a source line. */
  index: number;
  source: ReplayDivergenceStepSource;
};

export type ReplayDivergenceCause = {
  code: string;
  message: string;
  hint?: string;
};

export type ReplayDivergenceScreenRef = {
  ref: string;
  role: string;
  label?: string;
};

/**
 * Discriminated per the ADR: `available` is a fresh, healthy snapshot digest
 * and the only form that issues actionable refs; `unavailable` is returned
 * when capture fails or is sparse and must never fall back to the old
 * session tree or mask the original replay cause.
 */
export type ReplayDivergenceScreen =
  | {
      state: 'available';
      refsGeneration: number;
      refs: ReplayDivergenceScreenRef[];
      truncated?: true;
    }
  | {
      state: 'unavailable';
      reason: string;
      hint?: string;
    };

/** Strongest recorded-identity component the suggestion's selector matched on. */
export type ReplayDivergenceSuggestionBasis = 'id' | 'role-label' | 'label' | 'other';

export type ReplayDivergenceSuggestion = {
  selector: string;
  basis: ReplayDivergenceSuggestionBasis;
  ref?: string;
  role?: string;
  label?: string;
};

/**
 * Resume is decision 4's / migration step 5's territory. Step 2 attaches the
 * object with `allowed: false` and a clear reason per the ADR ("include the
 * object... WITHOUT --from existing yet"); `planDigest` is omitted entirely
 * until step 5 lands (not even as `undefined` — the key is absent).
 */
export type ReplayDivergenceResume = {
  allowed: false;
  reason: string;
};

export type ReplayDivergenceOverflow = {
  omittedBytes: number;
  artifactPath: string;
};

export type ReplayDivergence = {
  version: 1;
  kind: ReplayDivergenceKind;
  step: ReplayDivergenceStep;
  action: string;
  cause: ReplayDivergenceCause;
  screen: ReplayDivergenceScreen;
  suggestions: ReplayDivergenceSuggestion[];
  /** Suggestions available at default/full, independent of how many are carried at this level. */
  suggestionCount: number;
  resume: ReplayDivergenceResume;
  overflow?: ReplayDivergenceOverflow;
  artifactUnavailable?: true;
};

export const REPLAY_DIVERGENCE_RESUME_NOT_SUPPORTED: ReplayDivergenceResume = {
  allowed: false,
  reason: 'resume not yet supported',
};

type BoundedResponseLevel = 'digest' | 'default' | 'full';

export const REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS: Record<BoundedResponseLevel, number> = {
  digest: 8 * 1024,
  default: 24 * 1024,
  full: 64 * 1024,
};

export const REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT = 20;
export const REPLAY_DIVERGENCE_DIGEST_REF_LIMIT = 8;
export const REPLAY_DIVERGENCE_SUGGESTION_LIMIT = 5;
// ADR 0012's 256-UTF-8-byte per-field cap. Not exported: truncateUtf8Field's
// default parameter is the only sanctioned way callers reach this value —
// every field truncation call site should go through that function so the
// cap stays enforced in exactly one place.
const REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT = 256;

function levelForResponseLevel(level: ResponseLevel | undefined): BoundedResponseLevel {
  return level === 'digest' || level === 'full' ? level : 'default';
}

/**
 * UTF-8 byte-accurate truncation with a marker, never splitting a multi-byte
 * codepoint. Used for every individual string field the ADR caps at 256 bytes
 * (labels, ids, selectors, source paths, mismatch values, cause messages,
 * hints).
 */
export function truncateUtf8Field(
  value: string,
  limit = REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT,
): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return value;
  const marker = '…<truncated>';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, limit - markerBytes);
  let sliceEnd = budget;
  // Back off until we are not mid-codepoint (UTF-8 continuation bytes are 10xxxxxx).
  while (sliceEnd > 0 && (bytes[sliceEnd]! & 0xc0) === 0x80) sliceEnd -= 1;
  return `${bytes.subarray(0, sliceEnd).toString('utf8')}${marker}`;
}

/**
 * The sanctioned field sanitizer for divergence report strings, in the
 * ADR-specified order: central diagnostics redactor FIRST, byte-accurate
 * truncation (with marker) second. Truncating first could split a secret
 * across the cut so the redactor's patterns no longer match the surviving
 * fragment — redact-then-truncate makes the ordering guarantee structural
 * rather than relying on the redactor's incidental robustness to partial
 * tokens.
 */
export function sanitizeReplayDivergenceField(
  value: string,
  limit = REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT,
): string {
  return truncateUtf8Field(redactDiagnosticData(value), limit);
}

function boundScreenRefs(screen: ReplayDivergenceScreen, limit: number): ReplayDivergenceScreen {
  if (screen.state !== 'available' || screen.refs.length <= limit) return screen;
  return { ...screen, refs: screen.refs.slice(0, limit), truncated: true };
}

/**
 * Applies one level's array caps only (ref count, suggestion presence/count).
 * Field-level 256-byte truncation is expected to already be applied by the
 * caller at construction time — this function only bounds array shape.
 */
export function applyReplayDivergenceLevelCaps(
  divergence: ReplayDivergence,
  level: ResponseLevel | undefined,
): ReplayDivergence {
  const bounded = levelForResponseLevel(level);
  const refLimit =
    bounded === 'digest' ? REPLAY_DIVERGENCE_DIGEST_REF_LIMIT : REPLAY_DIVERGENCE_DEFAULT_REF_LIMIT;
  const screen = boundScreenRefs(divergence.screen, refLimit);
  const suggestions =
    bounded === 'digest' ? [] : divergence.suggestions.slice(0, REPLAY_DIVERGENCE_SUGGESTION_LIMIT);
  return { ...divergence, screen, suggestions };
}

export function measureReplayDivergenceBytes(divergence: ReplayDivergence): number {
  return Buffer.byteLength(JSON.stringify(divergence), 'utf8');
}

/**
 * Bounds the FULL divergence object to the requested response level's byte
 * ceiling. When the level-capped shape still overflows the ceiling (rare,
 * given per-field 256-byte caps and the 5/20 array caps), the daemon writes
 * the fuller (`full`-level-capped) detail to a session-scoped artifact via
 * `writeOverflowArtifact` and returns a minimal divergence carrying only
 * `overflow`/`artifactUnavailable` plus the always-cheap fields — the
 * original cause is never dropped, only the screen digest and suggestions.
 */
export function boundReplayDivergence(params: {
  divergence: ReplayDivergence;
  level: ResponseLevel | undefined;
  writeOverflowArtifact: (
    fullDivergence: ReplayDivergence,
  ) => { artifactPath: string } | { artifactUnavailable: true };
}): ReplayDivergence {
  const { divergence, level, writeOverflowArtifact } = params;
  const bounded = levelForResponseLevel(level);
  const limit = REPLAY_DIVERGENCE_LEVEL_BYTE_LIMITS[bounded];
  const capped = applyReplayDivergenceLevelCaps(divergence, level);
  const cappedBytes = measureReplayDivergenceBytes(capped);
  if (cappedBytes <= limit) return capped;

  const omittedBytes = cappedBytes - limit;
  const full = applyReplayDivergenceLevelCaps(divergence, 'full');
  const artifactResult = writeOverflowArtifact(full);
  const minimal = buildMinimalReplayDivergence(capped);
  return 'artifactPath' in artifactResult
    ? { ...minimal, overflow: { omittedBytes, artifactPath: artifactResult.artifactPath } }
    : { ...minimal, artifactUnavailable: true };
}

// Defensively re-truncates every string field to the 256-byte cap, even
// though callers are expected to have already done so at construction time
// (session-replay-divergence.ts): this is the function responsible for the
// "the minimal fallback always fits the budget" guarantee, so it must not
// depend on caller discipline to hold.
function buildMinimalReplayDivergence(capped: ReplayDivergence): ReplayDivergence {
  return {
    version: capped.version,
    kind: capped.kind,
    step: {
      index: capped.step.index,
      source: {
        path: sanitizeReplayDivergenceField(capped.step.source.path),
        line: capped.step.source.line,
      },
    },
    action: sanitizeReplayDivergenceField(capped.action),
    cause: {
      code: capped.cause.code,
      message: sanitizeReplayDivergenceField(capped.cause.message),
      ...(capped.cause.hint ? { hint: sanitizeReplayDivergenceField(capped.cause.hint) } : {}),
    },
    screen: {
      state: 'unavailable',
      reason: 'omitted-for-size',
      hint:
        'The screen digest and suggestions were omitted to stay within the response byte budget. ' +
        'See overflow.artifactPath (or retry at --level full) for the complete report.',
    },
    suggestions: [],
    suggestionCount: capped.suggestionCount,
    resume: capped.resume,
  };
}
