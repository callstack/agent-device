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

/** Always `allowed: false` until migration step 5; `from`/`planDigest` keys absent until then. */
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
// ADR 0012's 256-UTF-8-byte per-field cap; reached only through the field
// sanitizers below so it is enforced in one place.
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

/** Field sanitizer in the ADR-mandated order: redact first, then truncate. */
export function sanitizeReplayDivergenceField(
  value: string,
  limit = REPLAY_DIVERGENCE_FIELD_BYTE_LIMIT,
): string {
  return truncateUtf8Field(redactDiagnosticData(value), limit);
}

export type ReplayVarScrubEntry = { name: string; value: string };

/**
 * Categorical expanded-variable exclusion (ADR 0012): every occurrence of a
 * replay-scope value is replaced with a `<var:NAME>` marker, whatever the
 * value looks like — this is not shape-based secret redaction.
 */
export function scrubReplayVarValues(value: string, entries: ReplayVarScrubEntry[]): string {
  let output = value;
  for (const entry of entries) {
    if (!entry.value) continue;
    output = output.split(entry.value).join(`<var:${entry.name}>`);
  }
  return output;
}

/** Per-report field sanitizer: variable scrub, then redact, then truncate. */
export function createReplayDivergenceSanitizer(
  scrubVars: ReplayVarScrubEntry[],
): (value: string, limit?: number) => string {
  return (value, limit) =>
    sanitizeReplayDivergenceField(scrubReplayVarValues(value, scrubVars), limit);
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
 * Bounds the divergence to the response level's byte ceiling. On overflow,
 * the fuller detail goes to a session-scoped artifact and a minimal
 * divergence is returned; the cause is never dropped, only the screen digest
 * and suggestions.
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

// Owns the "the minimal fallback always fits the budget" guarantee, so it
// sanitizes every field itself rather than trusting the caller did.
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

// Compact human-readable divergence report for text surfaces (CLI, MCP text,
// `test` failures). Repair data (step location, screen availability, ranked
// suggestions, overflow pointer) that the --json/structuredContent paths
// carry must not be dropped on a text path. Reads the loose `details` bag so
// every surface (which holds an error `details` record) can share it.
export function formatReplayDivergenceReport(
  details: Record<string, unknown> | undefined,
): string | null {
  const divergence = details?.divergence;
  if (!divergence || typeof divergence !== 'object') return null;
  const record = divergence as Record<string, unknown>;
  const lines = [
    ...divergenceStepLine(record.step),
    ...divergenceScreenLine(record.screen),
    ...divergenceSuggestionLines(record.suggestions, record.suggestionCount),
    ...divergenceOverflowLine(record.overflow, record.artifactUnavailable),
  ];
  return lines.length > 0 ? lines.join('\n') : null;
}

function divergenceStepLine(step: unknown): string[] {
  const record = step as Record<string, unknown> | undefined;
  if (typeof record?.index !== 'number') return [];
  const source = record.source as Record<string, unknown> | undefined;
  const location =
    typeof source?.path === 'string' && typeof source.line === 'number'
      ? ` (${source.path}:${source.line})`
      : '';
  return [`Divergence at step ${record.index}${location}`];
}

// Bound on ref lines in the TEXT report (matches the digest ref cap); the
// full list rides in the structured payload.
const TEXT_REPORT_REF_LINE_LIMIT = 8;

function divergenceScreenLine(screen: unknown): string[] {
  const record = screen as Record<string, unknown> | undefined;
  if (record?.state === 'available' && Array.isArray(record.refs)) {
    return availableScreenLines(record.refs, record.refsGeneration);
  }
  if (record?.state === 'unavailable') {
    return [unavailableScreenLine(record)];
  }
  return [];
}

function availableScreenLines(refs: unknown[], refsGeneration: unknown): string[] {
  const shown = refs.slice(0, TEXT_REPORT_REF_LINE_LIMIT).map(divergenceScreenRefLine);
  const remaining = refs.length - shown.length;
  return [
    `Screen: ${refs.length} actionable ref(s) captured (refsGeneration ${refsGeneration}).`,
    ...shown,
    ...(remaining > 0 ? [`  ... ${remaining} more`] : []),
  ];
}

function unavailableScreenLine(record: Record<string, unknown>): string {
  const hint = typeof record.hint === 'string' && record.hint.length > 0 ? ` ${record.hint}` : '';
  return `Screen: unavailable (${String(record.reason ?? 'unknown')}).${hint}`;
}

function divergenceScreenRefLine(entry: unknown): string {
  const ref = entry as Record<string, unknown>;
  const label = typeof ref.label === 'string' ? ` "${ref.label}"` : '';
  return `  @${String(ref.ref)} [${String(ref.role)}]${label}`;
}

function divergenceSuggestionLines(suggestions: unknown, suggestionCount: unknown): string[] {
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    return ['Suggestions:', ...suggestions.slice(0, 5).map(divergenceSuggestionLine)];
  }
  if (typeof suggestionCount === 'number' && suggestionCount > 0) {
    return [
      `Suggestions: ${suggestionCount} available (omitted at this response level; rerun with --json for the full report).`,
    ];
  }
  return [];
}

function divergenceSuggestionLine(entry: unknown): string {
  const suggestion = entry as Record<string, unknown>;
  const label = typeof suggestion.label === 'string' ? ` "${suggestion.label}"` : '';
  return `  - [${String(suggestion.basis)}]${label} ${String(suggestion.selector)}`;
}

function divergenceOverflowLine(overflow: unknown, artifactUnavailable: unknown): string[] {
  if (overflow && typeof overflow === 'object') {
    return [
      `Full report written to ${String((overflow as Record<string, unknown>).artifactPath)}.`,
    ];
  }
  if (artifactUnavailable === true) {
    return [
      'Full report exceeded the response budget and the overflow artifact could not be written.',
    ];
  }
  return [];
}
