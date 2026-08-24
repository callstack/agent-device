import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { selectorContainsValue } from '@agent-device/selectors';

const STRUCTURAL_ROOT_OUTPUT_KEYS = new Set([
  'action',
  'backend',
  'cost',
  'delayMs',
  'evidence',
  'gesture',
  'hint',
  'kind',
  'maestroFallbackReason',
  'maestroNonHittableCoordinateFallbackAllowed',
  'maestroNonHittableCoordinateFallbackUsed',
  'message',
  'platform',
  'ref',
  'referenceHeight',
  'referenceWidth',
  'refLabel',
  'resolution',
  'selector',
  'selectorChain',
  'settle',
  'targetHittable',
  'targetKind',
  'text',
  'warning',
  'x',
  'y',
]);
const STABLE_ROOT_OUTPUT_STRING_KEYS = new Set([
  'action',
  'backend',
  'gesture',
  'kind',
  'platform',
  'ref',
  'selector',
  'targetKind',
]);
const STRUCTURED_OUTPUT_KEYS = new Set(['cost', 'evidence', 'resolution', 'settle']);
const STRUCTURAL_KEYS_BY_PATH = new Map<string, ReadonlySet<string>>([
  ['cost', new Set(['nodeCount', 'runnerRoundTrips', 'wallClockMs'])],
  [
    'evidence',
    new Set(['changedFromBefore', 'digest', 'foregroundApp', 'interactiveNodeCount', 'nodeCount']),
  ],
  [
    'resolution',
    new Set([
      'alternatives',
      'kind',
      'matchCount',
      'phase',
      'source',
      'tiebreak',
      'winnerDiagnostic',
    ]),
  ],
  ['resolution.alternatives', new Set(['diagnosticRef', 'label', 'role'])],
  ['resolution.winnerDiagnostic', new Set(['diagnosticRef', 'label', 'role'])],
  [
    'settle',
    new Set([
      'captures',
      'diff',
      'hint',
      'quietMs',
      'refs',
      'refsGeneration',
      'settled',
      'tail',
      'tailTruncated',
      'timeoutMs',
      'waitedMs',
    ]),
  ],
  ['settle.diff', new Set(['lines', 'summary', 'truncated'])],
  ['settle.diff.lines', new Set(['kind', 'ref', 'text'])],
  ['settle.diff.summary', new Set(['additions', 'removals', 'unchanged'])],
  ['settle.refs', new Set(['ref'])],
  ['settle.tail', new Set(['label', 'ref', 'role'])],
]);
const STABLE_STRUCTURAL_STRING_PATHS = new Set([
  'evidence.digest',
  'evidence.foregroundApp',
  'resolution.alternatives.diagnosticRef',
  'resolution.alternatives.role',
  'resolution.kind',
  'resolution.phase',
  'resolution.source',
  'resolution.tiebreak',
  'resolution.winnerDiagnostic.diagnosticRef',
  'resolution.winnerDiagnostic.role',
  'settle.diff.lines.kind',
  'settle.diff.lines.ref',
  'settle.refs.ref',
  'settle.tail.ref',
  'settle.tail.role',
]);

/**
 * Parameterize only fields whose contract says they carry the fill value.
 * Stable identity/provenance strings stay byte-for-byte unchanged. Untrusted
 * backend extras and nested settle output keys and values are scrubbed
 * recursively; a derived selector candidate is dropped only when a parsed
 * text/label/value term semantically contains the supplied literal. Repeated
 * application preserves placeholders already inserted by an earlier response
 * boundary.
 */
export function parameterizeRecordedFillPayload<
  TPayload extends Record<string, unknown> | undefined,
>(payload: TPayload, literal: string, placeholder: string): TPayload {
  if (!payload) return payload;
  const selectorChain = readStringArray(payload.selectorChain);
  const carries = (candidate: string) => selectorCandidateCarriesFillValue(candidate, literal);
  return {
    ...parameterizeBackendOutput(
      payload,
      (value) => parameterizeSensitiveString(value, literal, placeholder),
      carries,
    ),
    ...(typeof payload.text === 'string' ? { text: placeholder } : {}),
    ...(selectorChain
      ? { selectorChain: selectorChain.filter((candidate) => !carries(candidate)) }
      : {}),
  } as TPayload;
}

/**
 * #1398: content-aware echo redaction for a LATER, unrelated action's own
 * recorded result payload, against every literal registered so far in the
 * recording session. Unlike `parameterizeRecordedFillPayload`, this never
 * force-replaces a field just because it holds a string — that shortcut is
 * only valid for a fill's OWN semantic `text` field, which by construction
 * equals the literal. Here every literal belongs to a DIFFERENT, earlier
 * action, so every string field must be checked for actually containing one
 * before anything is rewritten. Delegates to `parameterizeAgainstLiteralMap`
 * for the actual substitution, so redacting one literal can never corrupt a
 * placeholder another literal (or an earlier stage) already inserted.
 */
export function parameterizeRecordedResultEcho<
  TPayload extends Record<string, unknown> | undefined,
>(payload: TPayload, literals: ReadonlyMap<string, string>): TPayload {
  if (!payload) return payload;
  const pairs = sortedLiteralPairs(literals);
  return parameterizeBackendOutput(
    payload,
    (value) => parameterizeAgainstLiteralMap(value, pairs),
    (candidate) => selectorCandidateCarriesAnyLiteral(candidate, literals),
  ) as TPayload;
}

/**
 * #1398: content-aware label redaction for a LATER, unrelated action's own
 * identity evidence, against every literal registered so far in the
 * recording session. Unlike `parameterizeRecordedFillTargetEvidence` (which
 * matches only an EXACT value-bearing label, correct for the originating
 * fill's own field), a cross-step echo is typically a label that CONTAINS a
 * literal inside app-authored surrounding text — a search result, a
 * confirmation banner, a destination landmark ("Welcome, <value>") — so this
 * does a substring-aware replacement, exactly like the result-payload echo
 * scrub above, over `label`/`ancestry[].label`/`scrollRegion.label` only.
 */
export function parameterizeTargetEvidenceEcho(
  evidence: TargetAnnotationV1,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1;
export function parameterizeTargetEvidenceEcho(
  evidence: TargetAnnotationV1 | undefined,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1 | undefined;
export function parameterizeTargetEvidenceEcho(
  evidence: TargetAnnotationV1 | undefined,
  literals: ReadonlyMap<string, string>,
): TargetAnnotationV1 | undefined {
  if (!evidence) return evidence;
  const pairs = sortedLiteralPairs(literals);
  return {
    ...evidence,
    ...(evidence.label !== undefined
      ? { label: parameterizeAgainstLiteralMap(evidence.label, pairs) }
      : {}),
    ancestry: evidence.ancestry.map((entry) => ({
      ...entry,
      ...(entry.label !== undefined
        ? { label: parameterizeAgainstLiteralMap(entry.label, pairs) }
        : {}),
    })),
    ...(evidence.scrollRegion
      ? {
          scrollRegion: {
            ...evidence.scrollRegion,
            ...(evidence.scrollRegion.label !== undefined
              ? { label: parameterizeAgainstLiteralMap(evidence.scrollRegion.label, pairs) }
              : {}),
          },
        }
      : {}),
  };
}

/** Whether any label tier of the evidence carries any registered literal as a substring. */
export function targetEvidenceCarriesAnyLiteral(
  evidence: TargetAnnotationV1,
  literals: ReadonlyMap<string, string>,
): boolean {
  if (evidence.label !== undefined && labelCarriesAnyLiteral(evidence.label, literals)) {
    return true;
  }
  if (
    evidence.ancestry.some((entry) => entry.label && labelCarriesAnyLiteral(entry.label, literals))
  ) {
    return true;
  }
  if (
    evidence.scrollRegion?.label &&
    labelCarriesAnyLiteral(evidence.scrollRegion.label, literals)
  ) {
    return true;
  }
  return false;
}

function labelCarriesAnyLiteral(value: string, literals: ReadonlyMap<string, string>): boolean {
  for (const literal of literals.keys()) {
    if (value.includes(literal)) return true;
  }
  return false;
}

function selectorCandidateCarriesAnyLiteral(
  candidate: string,
  literals: ReadonlyMap<string, string>,
): boolean {
  for (const literal of literals.keys()) {
    if (selectorCandidateCarriesFillValue(candidate, literal)) return true;
  }
  return false;
}

/** Parameterize exact accessibility labels without rewriting identity fragments. */
export function parameterizeRecordedFillTargetEvidence(
  evidence: TargetAnnotationV1,
  literal: string,
  placeholder: string,
): TargetAnnotationV1;
export function parameterizeRecordedFillTargetEvidence(
  evidence: TargetAnnotationV1 | undefined,
  literal: string,
  placeholder: string,
): TargetAnnotationV1 | undefined;
export function parameterizeRecordedFillTargetEvidence(
  evidence: TargetAnnotationV1 | undefined,
  literal: string,
  placeholder: string,
): TargetAnnotationV1 | undefined {
  if (!evidence) return evidence;
  return {
    ...evidence,
    ...(evidence.label === literal ? { label: placeholder } : {}),
    ancestry: evidence.ancestry.map((entry) => ({
      ...entry,
      ...(entry.label === literal ? { label: placeholder } : {}),
    })),
    ...(evidence.scrollRegion
      ? {
          scrollRegion: {
            ...evidence.scrollRegion,
            ...(evidence.scrollRegion.label === literal ? { label: placeholder } : {}),
          },
        }
      : {}),
  };
}

function selectorCandidateCarriesFillValue(candidate: string, literal: string): boolean {
  return selectorContainsValue(candidate, literal);
}

/** A leaf string rewrite rule injected into the shared structural walk below. */
type LeafTransform = (value: string) => string;
/** Whether a selector-chain candidate carries whatever this call's leaf transform redacts. */
type CarriesSensitiveValue = (candidate: string) => boolean;

function parameterizeBackendOutput(
  value: Record<string, unknown>,
  transform: LeafTransform,
  carries: CarriesSensitiveValue,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const outputKey = STRUCTURAL_ROOT_OUTPUT_KEYS.has(key) ? key : transform(key);
      return [outputKey, parameterizeRootOutputValue(entry, key, transform, carries)];
    }),
  );
}

function parameterizeRootOutputValue(
  value: unknown,
  key: string,
  transform: LeafTransform,
  carries: CarriesSensitiveValue,
): unknown {
  if (typeof value === 'string') {
    if (STABLE_ROOT_OUTPUT_STRING_KEYS.has(key)) return value;
  }
  if (key === 'selectorChain' && isStringArray(value)) {
    return filterSensitiveSelectorCandidates(value, carries);
  }
  return parameterizeBackendOutputValue(
    value,
    transform,
    carries,
    STRUCTURED_OUTPUT_KEYS.has(key) ? key : undefined,
  );
}

function parameterizeBackendOutputValue(
  value: unknown,
  transform: LeafTransform,
  carries: CarriesSensitiveValue,
  structuralPath: string | undefined,
): unknown {
  if (typeof value === 'string') {
    if (structuralPath && STABLE_STRUCTURAL_STRING_PATHS.has(structuralPath)) return value;
    return transform(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      parameterizeBackendOutputValue(entry, transform, carries, structuralPath),
    );
  }
  if (!value || typeof value !== 'object') return value;
  const structuralKeys = structuralPath ? STRUCTURAL_KEYS_BY_PATH.get(structuralPath) : undefined;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, entry]) => {
      const isStructural = structuralKeys?.has(nestedKey) === true;
      const outputKey = isStructural ? nestedKey : transform(nestedKey);
      return [
        outputKey,
        parameterizeBackendOutputValue(
          entry,
          transform,
          carries,
          isStructural ? `${structuralPath}.${nestedKey}` : undefined,
        ),
      ];
    }),
  );
}

function filterSensitiveSelectorCandidates(
  value: string[],
  carries: CarriesSensitiveValue,
): string[] {
  return value.filter((candidate) => !carries(candidate));
}

function parameterizeSensitiveString(value: string, literal: string, placeholder: string): string {
  if (!literal) return value === literal ? placeholder : value;

  const unparameterizedSegments = placeholder ? value.split(placeholder) : [value];
  if (unparameterizedSegments.every((segment) => !segment.includes(literal))) return value;

  // Replacing whitespace inline would make every ordinary separator look like
  // authored secret data. Collapse the whole untrusted string/key instead.
  if (!literal.trim()) return placeholder;

  return unparameterizedSegments
    .map((segment) => segment.replaceAll(literal, placeholder))
    .join(placeholder);
}

/**
 * Mirrors the `${VAR}` grammar `@agent-device/ad-script`'s `REPLAY_VAR_KEY_RE`
 * and `src/replay/recorded-input.ts`'s `RECORDED_INPUT_PLACEHOLDER_RE` define.
 * The sticky (`y`) flag makes `exec` match only starting exactly at
 * `lastIndex` (never scanning ahead to find a later match), so the scan below
 * can test one position at a time without slicing a fresh substring per
 * character — an O(n) scan stays O(n), not O(n^2).
 */
const PLACEHOLDER_TOKEN_START_RE = /\$\{[A-Z_][A-Z0-9_]*\}/y;

/**
 * Sorts the session's literal registry longest-literal-first exactly once,
 * so a registered value that is a substring of another registered value (a
 * username that is a prefix of a password, say) is never partially consumed
 * by the shorter pair. Callers that walk many string leaves (the payload and
 * target-evidence echo scrubs below) sort once and thread the result down,
 * rather than re-sorting the same small map on every leaf.
 */
function sortedLiteralPairs(
  literals: ReadonlyMap<string, string>,
): readonly (readonly [string, string])[] {
  return [...literals].sort(([a], [b]) => b.length - a.length);
}

/**
 * #1398: the placeholder-safe multi-literal redaction primitive. A single
 * left-to-right pass — not N sequential full-string passes over the same
 * value. Sequential per-pair passes can corrupt an EARLIER pair's
 * just-inserted placeholder when a LATER pair's literal happens to be a
 * substring of it: register `somethinglong -> ${ABC}`, then `ABC -> ${OTHER}`,
 * and a naive second pass over a value already rewritten to `${ABC}` matches
 * "ABC" *inside* that placeholder token, producing the corrupted
 * `${${OTHER}}`. This never re-scans text it has already emitted in THIS
 * call — `index` only ever advances forward through the source `value`, so a
 * placeholder just appended to `result` is never fed back through the match
 * loop.
 *
 * A registered literal is matched BEFORE checking whether an existing
 * placeholder token starts here, so a literal whose own text happens to look
 * like `${SOMETHING}` (an edge case, but a real typed value can be shaped
 * like that) is still redacted correctly. The placeholder-token check exists
 * for the OTHER direction: text already rewritten to `${VAR}` by an earlier
 * stage (the fill's own single-pair boundary, or the parser's own replay
 * source) before this pass ever ran, where no current literal matches at
 * that position — that existing token is left untouched rather than
 * partially matched.
 *
 * `pairs` must already be sorted longest-literal-first (`sortedLiteralPairs`)
 * — this is the hot leaf-level primitive, invoked once per string field
 * during a payload/evidence walk, so the sort happens once at the caller
 * rather than being repeated on every leaf.
 */
function parameterizeAgainstLiteralMap(
  value: string,
  pairs: readonly (readonly [string, string])[],
): string {
  if (!value || pairs.length === 0) return value;

  let result = '';
  let index = 0;
  scan: while (index < value.length) {
    for (const [literal, placeholder] of pairs) {
      if (value.startsWith(literal, index)) {
        result += placeholder;
        index += literal.length;
        continue scan;
      }
    }
    if (value[index] === '$') {
      PLACEHOLDER_TOKEN_START_RE.lastIndex = index;
      const existingPlaceholder = PLACEHOLDER_TOKEN_START_RE.exec(value);
      if (existingPlaceholder) {
        result += existingPlaceholder[0];
        index += existingPlaceholder[0].length;
        continue;
      }
    }
    result += value[index];
    index += 1;
  }
  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readStringArray(value: unknown): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}
