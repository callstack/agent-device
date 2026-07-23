import type { TargetAnnotationV1 } from '../replay/target-identity.ts';
import { tryParseSelectorChain } from '../selectors/parse.ts';

const VALUE_BEARING_SELECTOR_KEYS = new Set(['text', 'label', 'value']);
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
const STRUCTURAL_NESTED_STRING_KEYS = new Set([
  'digest',
  'foregroundApp',
  'id',
  'kind',
  'ref',
  'role',
  'source',
  'verification',
]);
const IDENTIFIER_CHAR = /^[A-Za-z0-9_]$/;

/**
 * Parameterize only fields whose contract says they carry the fill value.
 * Stable identity/provenance strings stay byte-for-byte unchanged. Untrusted
 * backend extras and nested settle output are scrubbed recursively; a derived
 * selector candidate is dropped only when a parsed text/label/value term
 * semantically contains the supplied literal.
 */
export function parameterizeRecordedFillPayload<
  TPayload extends Record<string, unknown> | undefined,
>(payload: TPayload, literal: string, placeholder: string): TPayload {
  if (!payload) return payload;
  const selectorChain = readStringArray(payload.selectorChain);
  return {
    ...parameterizeBackendOutput(payload, literal, placeholder),
    ...(typeof payload.text === 'string' ? { text: placeholder } : {}),
    ...(payload.refLabel === literal ? { refLabel: placeholder } : {}),
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
  const parsed = tryParseSelectorChain(candidate);
  return (
    parsed?.selectors.some((selector) =>
      selector.terms.some(
        (term) =>
          VALUE_BEARING_SELECTOR_KEYS.has(term.key) &&
          typeof term.value === 'string' &&
          parameterizeSensitiveString(term.value, literal, '') !== term.value,
      ),
    ) ?? false
  );
}

function parameterizeBackendOutput(
  value: Record<string, unknown>,
  literal: string,
  placeholder: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      parameterizeRootOutputValue(entry, key, literal, placeholder),
    ]),
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
    if (key === 'refLabel') return value === literal ? placeholder : value;
  }
  if (key === 'selectorChain' && isStringArray(value)) {
    return filterSensitiveSelectorCandidates(value, literal);
  }
  return parameterizeBackendOutputValue(
    value,
    key,
    literal,
    placeholder,
    STRUCTURED_OUTPUT_KEYS.has(key),
  );
}

function parameterizeBackendOutputValue(
  value: unknown,
  key: string,
  literal: string,
  placeholder: string,
  preserveStructuralStrings: boolean,
): unknown {
  if (typeof value === 'string') {
    if (preserveStructuralStrings && STRUCTURAL_NESTED_STRING_KEYS.has(key)) return value;
    return parameterizeSensitiveString(value, literal, placeholder);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      parameterizeBackendOutputValue(entry, key, literal, placeholder, preserveStructuralStrings),
    );
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, entry]) => [
      nestedKey,
      parameterizeBackendOutputValue(
        entry,
        nestedKey,
        literal,
        placeholder,
        preserveStructuralStrings,
      ),
    ]),
  );
}

function filterSensitiveSelectorCandidates(value: string[], literal: string): string[] {
  return value.filter((candidate) => !selectorCandidateCarriesFillValue(candidate, literal));
}

function parameterizeSensitiveString(value: string, literal: string, placeholder: string): string {
  if (!literal.trim()) return value === literal ? placeholder : value;
  if (!isIdentifierLiteral(literal)) {
    return value.replaceAll(literal, placeholder);
  }
  return parameterizeDelimitedLiteral(value, literal, placeholder);
}

function isIdentifierLiteral(literal: string): boolean {
  return Array.from(literal).every((character) => IDENTIFIER_CHAR.test(character));
}

function parameterizeDelimitedLiteral(value: string, literal: string, placeholder: string): string {
  let cursor = 0;
  let result = '';
  while (cursor < value.length) {
    const matchIndex = value.indexOf(literal, cursor);
    if (matchIndex === -1) return result + value.slice(cursor);
    result += value.slice(cursor, matchIndex);
    result += isDelimitedMatch(value, literal, matchIndex) ? placeholder : literal;
    cursor = matchIndex + literal.length;
  }
  return result;
}

function isDelimitedMatch(value: string, literal: string, matchIndex: number): boolean {
  return (
    !isIdentifierCharacter(value[matchIndex - 1]) &&
    !isIdentifierCharacter(value[matchIndex + literal.length])
  );
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && IDENTIFIER_CHAR.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readStringArray(value: unknown): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}
