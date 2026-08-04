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
  return {
    ...parameterizeBackendOutput(payload, literal, placeholder),
    ...(typeof payload.text === 'string' ? { text: placeholder } : {}),
    ...(selectorChain
      ? {
          selectorChain: selectorChain.filter(
            (candidate) => !selectorCandidateCarriesFillValue(candidate, literal),
          ),
        }
      : {}),
  } as TPayload;
}

/** Parameterize exact accessibility labels without rewriting identity fragments. */
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

function parameterizeBackendOutput(
  value: Record<string, unknown>,
  literal: string,
  placeholder: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const outputKey = STRUCTURAL_ROOT_OUTPUT_KEYS.has(key)
        ? key
        : parameterizeSensitiveString(key, literal, placeholder);
      return [outputKey, parameterizeRootOutputValue(entry, key, literal, placeholder)];
    }),
  );
}

function parameterizeRootOutputValue(
  value: unknown,
  key: string,
  literal: string,
  placeholder: string,
): unknown {
  if (typeof value === 'string') {
    if (STABLE_ROOT_OUTPUT_STRING_KEYS.has(key)) return value;
  }
  if (key === 'selectorChain' && isStringArray(value)) {
    return filterSensitiveSelectorCandidates(value, literal);
  }
  return parameterizeBackendOutputValue(
    value,
    literal,
    placeholder,
    STRUCTURED_OUTPUT_KEYS.has(key) ? key : undefined,
  );
}

function parameterizeBackendOutputValue(
  value: unknown,
  literal: string,
  placeholder: string,
  structuralPath: string | undefined,
): unknown {
  if (typeof value === 'string') {
    if (structuralPath && STABLE_STRUCTURAL_STRING_PATHS.has(structuralPath)) return value;
    return parameterizeSensitiveString(value, literal, placeholder);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      parameterizeBackendOutputValue(entry, literal, placeholder, structuralPath),
    );
  }
  if (!value || typeof value !== 'object') return value;
  const structuralKeys = structuralPath ? STRUCTURAL_KEYS_BY_PATH.get(structuralPath) : undefined;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, entry]) => {
      const isStructural = structuralKeys?.has(nestedKey) === true;
      const outputKey = isStructural
        ? nestedKey
        : parameterizeSensitiveString(nestedKey, literal, placeholder);
      return [
        outputKey,
        parameterizeBackendOutputValue(
          entry,
          literal,
          placeholder,
          isStructural ? `${structuralPath}.${nestedKey}` : undefined,
        ),
      ];
    }),
  );
}

function filterSensitiveSelectorCandidates(value: string[], literal: string): string[] {
  return value.filter((candidate) => !selectorCandidateCarriesFillValue(candidate, literal));
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readStringArray(value: unknown): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}
