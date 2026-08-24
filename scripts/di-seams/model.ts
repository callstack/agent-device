// Detects `field?: typeof X` — the shape of a test-only DI seam (an optional parameter that
// exists to let a test inject an alternate implementation). Not every match is a seam this gate
// should ban: some are deliberately approved injection points, and some are unrelated `typeof
// CONST` literal-type derivations that only match by syntax coincidence. See approved.ts.
//
// #1976 / PR #2006 review: an earlier version of this gate exempted matches by the *spelling* of
// the typeof target (`typeof fetch` always passed, ALL-CAPS targets always passed). That silently
// waved through a new, genuinely test-only `typeof fetch` seam anywhere in the tree while banning
// an equally legitimate seam under any other name — the pattern did not actually own the
// invariant it was enforcing. This module instead checks each match against an explicit,
// per-site allowlist keyed by (file, field name, typeof target): a triple is exempt only if it
// was individually reviewed and named, never because of how it happens to be spelled.

const SEAM_PATTERN = /(\w+)\?\s*:\s*typeof\s+(\w+)/g;

export type SourceFile = {
  readonly path: string;
  readonly source: string;
};

export type SeamMatch = {
  readonly file: string;
  readonly line: number;
  readonly field: string;
  readonly target: string;
  readonly text: string;
};

export function findSeamMatches(files: readonly SourceFile[]): SeamMatch[] {
  const matches: SeamMatch[] = [];
  for (const { path: file, source } of files) {
    source.split('\n').forEach((lineText, idx) => {
      SEAM_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SEAM_PATTERN.exec(lineText)) !== null) {
        matches.push({
          file,
          line: idx + 1,
          field: match[1]!,
          target: match[2]!,
          text: lineText.trim(),
        });
      }
    });
  }
  return matches;
}

export type ApprovedSeam = {
  readonly file: string;
  readonly field: string;
  readonly target: string;
  readonly reason: string;
};

function seamKey(seam: { file: string; field: string; target: string }): string {
  return `${seam.file}::${seam.field}::${seam.target}`;
}

export type SeamCheckResult = {
  readonly violations: readonly SeamMatch[];
  readonly staleApprovals: readonly ApprovedSeam[];
};

/**
 * A match passes only if its exact (file, field, typeof-target) triple is named in `approved` —
 * not if its field name or target merely resembles one that is. An approval whose triple no
 * longer appears in `matches` is stale: the site moved, was renamed, or was deleted, so the
 * approval needs to follow it or be removed. Reporting that as loudly as a real violation is
 * what keeps the list from drifting into an allowlist for identifiers rather than sites.
 */
export function checkSeams(
  matches: readonly SeamMatch[],
  approved: readonly ApprovedSeam[],
): SeamCheckResult {
  const approvedKeys = new Set(approved.map(seamKey));
  const seenKeys = new Set<string>();
  const violations: SeamMatch[] = [];
  for (const match of matches) {
    const key = seamKey(match);
    if (approvedKeys.has(key)) {
      seenKeys.add(key);
    } else {
      violations.push(match);
    }
  }
  const staleApprovals = approved.filter((entry) => !seenKeys.has(seamKey(entry)));
  return { violations, staleApprovals };
}
