import type { TargetAnnotationV1 } from '../replay/target-identity.ts';
import { tryParseSelectorChain } from '../selectors/parse.ts';

const VALUE_BEARING_SELECTOR_KEYS = new Set(['text', 'label', 'value']);

/**
 * Parameterize only fields whose contract says they carry the fill value.
 * Stable identity/provenance strings stay byte-for-byte unchanged; a derived
 * selector candidate is dropped only when a parsed text/label/value term is
 * exactly the supplied literal.
 */
export function parameterizeRecordedFillPayload<
  TPayload extends Record<string, unknown> | undefined,
>(payload: TPayload, literal: string, placeholder: string): TPayload {
  if (!payload) return payload;
  const selectorChain = readStringArray(payload.selectorChain);
  return {
    ...payload,
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
          term.value === literal,
      ),
    ) ?? false
  );
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}
