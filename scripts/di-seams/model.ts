// Detects `field?: typeof X` — the shape of a test-only DI seam (an optional parameter that
// exists to let a test inject an alternate implementation). Not every match is a seam this gate
// should ban: some are deliberately approved injection points, and some are unrelated `typeof
// CONST` literal-type derivations that only match by syntax coincidence. See approved.ts.
//
// #1976 / PR #2006 review round 1: an earlier version exempted matches by the *spelling* of the
// typeof target (`typeof fetch` always passed, ALL-CAPS targets always passed) — silently waving
// through a new, genuinely test-only `typeof fetch` seam anywhere in the tree while banning an
// equally legitimate seam under any other name.
//
// Round 2 found two more gaps in the fix for round 1:
//   - findSeamMatches scanned line by line, so a declaration split across lines (`field?:` on one
//     line, `typeof X` on the next) was invisible — a real seam written that way could reappear
//     undetected. Matching is now done against the whole file's source in one pass; `\s` matches a
//     real newline in JavaScript regexes with no extra flag needed, so this closes the gap without
//     needing a syntax-aware parser.
//   - checkSeams keyed approval by (file, field, target) alone, so once one occurrence of a triple
//     was approved, ANY further occurrence of that same triple anywhere in the same file passed
//     too — a second, unreviewed `fetchImpl?: typeof fetch` added elsewhere in an already-approved
//     file would silently pass. The key now includes the line the match starts on, so each
//     approval names one specific declaration, not a pattern that recurs freely within a file.
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
    SEAM_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SEAM_PATTERN.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      matches.push({
        file,
        line,
        field: match[1]!,
        target: match[2]!,
        // Collapse the run of whitespace a multiline match spans into one readable line for
        // reporting; the actual matched span is what checkSeams and callers key on separately.
        text: match[0].replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return matches;
}

export type ApprovedSeam = {
  readonly file: string;
  readonly line: number;
  readonly field: string;
  readonly target: string;
  readonly reason: string;
};

function seamKey(seam: { file: string; line: number; field: string; target: string }): string {
  return `${seam.file}:${seam.line}::${seam.field}::${seam.target}`;
}

export type SeamCheckResult = {
  readonly violations: readonly SeamMatch[];
  readonly staleApprovals: readonly ApprovedSeam[];
};

/**
 * A match passes only if its exact (file, line, field, typeof-target) quadruple is named in
 * `approved` — not if its field name or target merely resembles one that is, and not merely
 * because some OTHER line in the same file was approved for the same field/target pair. An
 * approval whose quadruple no longer appears in `matches` is stale: the site moved (even by an
 * unrelated edit earlier in the file shifting its line number), was renamed, or was deleted, so
 * the approval needs to follow it or be removed. Reporting that as loudly as a real violation is
 * what keeps the list from drifting into an allowlist for identifiers or patterns rather than
 * actual, named declarations.
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
