/**
 * Which provenance kind each corpus area is allowed to use (#1417).
 *
 * The kind decides how strongly an entry is pinned: `mined` bytes are re-derived
 * from git history by `pnpm check:replay-compat`, `derived` bytes are only
 * digest-pinned inside the same editable manifest. Without this rule an entry
 * could be edited, relabelled `derived`, given a matching digest, and quietly
 * escape the historical verifier. So the area — not the manifest line — decides:
 * anything mined out of the replay suites must stay `mined` forever.
 */

import type { ReplayCompatEntry, ReplayCompatProvenance } from './manifest.ts';

const CORPUS_AREA_PROVENANCE_KIND: Readonly<Record<string, ReplayCompatProvenance['kind']>> = {
  // Mined from the git history of `test/integration/replays`.
  integration: 'mined',
  // Mined from the git history of `examples/test-app/replays`.
  examples: 'mined',
  // Composed from a release's own grammar/docs: no historical blob exists.
  docs: 'derived',
};

function corpusArea(file: string): string {
  const area = file.split('/')[1];
  if (!area || !file.startsWith('scripts/')) {
    throw new Error(`Corpus file "${file}" must live under scripts/<area>/.`);
  }
  return area;
}

export function requiredProvenanceKind(file: string): ReplayCompatProvenance['kind'] {
  const area = corpusArea(file);
  const kind = CORPUS_AREA_PROVENANCE_KIND[area];
  if (!kind) {
    throw new Error(
      `Corpus area "${area}" has no declared provenance kind. Add it to CORPUS_AREA_PROVENANCE_KIND ` +
        `in test/replay-compat/provenance-rules.ts before adding entries under it.`,
    );
  }
  return kind;
}

/** Human-readable violations, so the same rule can fail a test or a CI script. */
export function findProvenanceKindViolations(
  entries: readonly ReplayCompatEntry[],
): readonly string[] {
  return entries.flatMap((entry) => {
    const required = requiredProvenanceKind(entry.file);
    if (entry.provenance.kind === required) return [];
    return [
      `${entry.id}: entries under scripts/${corpusArea(entry.file)}/ must stay "${required}", ` +
        `but this one is "${entry.provenance.kind}". Reclassifying a mined script drops it out of ` +
        `pnpm check:replay-compat; keep the released blob id instead.`,
    ];
  });
}
