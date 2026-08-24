// Detects `field?: typeof X` — the shape of a test-only DI seam (an optional parameter that
// exists to let a test inject an alternate implementation). Not every match is a seam this gate
// should ban: some are deliberately approved injection points, and some are unrelated `typeof
// CONST` literal-type derivations that only match by syntax coincidence.
//
// #1976 / PR #2006 review history:
//   - Round 1: an earlier version exempted matches by the *spelling* of the typeof target
//     (`typeof fetch` always passed, ALL-CAPS targets always passed) — silently waving through a
//     new, genuinely test-only `typeof fetch` seam anywhere in the tree while banning an equally
//     legitimate seam under any other name.
//   - Round 2: replaced that with a global table keyed by (file, line, field, target). A line
//     number is not a stable identity — an unrelated edit anywhere earlier in the file shifts
//     every approval below it, so the very first real-world CI run (an unrelated import removed
//     on `main`) broke an already-reviewed, unchanged approval.
//
// This version drops the external table entirely. Detection is AST-based (`oxc-parser`, already
// a devDependency, same tool scripts/layering/*.ts uses for exactly this reason: a regex has to
// enumerate every way TypeScript lets you format a declaration, and a full-source regex still
// cannot tell an optional property inside a type literal from a `typeof` mention inside a string
// or comment). Approval is a comment attached to the declaration itself — `// di-seam-approved:
// <reason>` immediately above it, the same "marker precedes what it exempts" shape as this repo's
// own `// fallow-ignore-next-line complexity` convention — so the approval moves with the code:
// nothing to resync when an unrelated line shifts, and a second, unmarked seam under the same
// field/target elsewhere in the file is not exempted by association.

import { parseSync } from 'oxc-parser';

const APPROVAL_MARKER = 'di-seam-approved:';

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
  /** The text after the marker, or null if this declaration has no `di-seam-approved:` comment. */
  readonly approvalReason: string | null;
};

type AstNode = Record<string, unknown>;
type Comment = {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** `{ optional: true, typeAnnotation: TSTypeAnnotation<TSTypeQuery> }` — a property signature's
 * own shape and a bare optional parameter's own shape are identical on this point, so one check
 * covers both `{ field?: typeof X }` and `function f(field?: typeof X)`. */
function typeofTarget(node: AstNode): string | null {
  if (node['optional'] !== true) return null;
  const outer = node['typeAnnotation'] as AstNode | undefined;
  const inner = outer?.['typeAnnotation'] as AstNode | undefined;
  if (inner?.['type'] !== 'TSTypeQuery') return null;
  const exprName = inner['exprName'] as AstNode | undefined;
  return exprName?.['type'] === 'Identifier' ? (exprName['name'] as string) : null;
}

function fieldName(node: AstNode): string | null {
  if (node['type'] === 'TSPropertySignature') {
    const key = node['key'] as AstNode | undefined;
    return key?.['type'] === 'Identifier' ? (key['name'] as string) : null;
  }
  if (node['type'] === 'Identifier') return node['name'] as string;
  return null;
}

/**
 * The `di-seam-approved:` reason for a declaration starting at `nodeStart`, or null. Walks
 * backward through `comments` while each is separated from the next (or from the node) by
 * whitespace only — a contiguous leading-comment block — then requires the FIRST comment in
 * that block to carry the marker. Any non-whitespace between a comment and the node (another
 * statement, a blank marker-less comment used for something else) breaks the chain, so a marker
 * left on an unrelated declaration above never attaches to this one.
 */
function approvalReason(
  source: string,
  comments: readonly Comment[],
  nodeStart: number,
): string | null {
  const onlyWhitespace = (from: number, to: number) => /^\s*$/.test(source.slice(from, to));
  const block: string[] = [];
  let cursor = nodeStart;
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (comment.end > cursor) continue;
    if (!onlyWhitespace(comment.end, cursor)) break;
    block.unshift(comment.value.trim());
    cursor = comment.start;
  }
  if (block.length === 0 || !block[0]!.startsWith(APPROVAL_MARKER)) return null;
  const reason = [block[0]!.slice(APPROVAL_MARKER.length).trim(), ...block.slice(1)]
    .join(' ')
    .trim();
  // A bare `// di-seam-approved:` with no reason text is not a review, it's a bypass — require
  // something was actually written, not just the marker itself.
  return reason.length > 0 ? reason : null;
}

export function findSeamMatches(files: readonly SourceFile[]): SeamMatch[] {
  const matches: SeamMatch[] = [];
  for (const { path: file, source } of files) {
    const parsed = parseSync(file, source);
    const comments = parsed.comments as readonly Comment[];
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as AstNode;
      const target = typeofTarget(record);
      const field = target === null ? null : fieldName(record);
      if (target !== null && field !== null) {
        const start = record['start'] as number;
        const end = record['end'] as number;
        matches.push({
          file,
          line: lineOf(source, start),
          field,
          target,
          text: source.slice(start, end).replace(/\s+/g, ' ').trim(),
          approvalReason: approvalReason(source, comments, start),
        });
      }
      for (const value of Object.values(record)) visit(value);
    };
    visit(parsed.program);
  }
  return matches;
}

export type SeamCheckResult = {
  readonly violations: readonly SeamMatch[];
};

export function checkSeams(matches: readonly SeamMatch[]): SeamCheckResult {
  return { violations: matches.filter((match) => match.approvalReason === null) };
}
