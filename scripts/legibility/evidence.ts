// The evidence line one file is judged on, and the fixed framing the evaluation call shares
// across a batch. No condition ever shows the file's own path or the mirrored test directory.
//
// Two conditions differ in one respect only — whether family names are visible in the paths:
//
//   reader    — real repository paths, the way a reader who opened the tree sees them. Scored.
//   withheld  — every family name also scrubbed out of the paths. The name ablation, not a score.
//
// The two leak-reference conditions relax one further rule each (mirror path, raw subject) and
// are labelled as such at output. Which names a condition may see also decides which baselines
// are comparable to it; see the header of baselines.ts.

import type { CorpusFile } from './corpus.ts';
import { leaksName, type Scrubber } from './redaction.ts';

export type EvidenceCondition = {
  /** `visible` keeps family names in paths; `withheld` scrubs them as well. */
  names: 'visible' | 'withheld';
  /** Show the mirrored test's full path instead of its basename (mirror leak reference). */
  withTestDir: boolean;
  /** Show the commit subject verbatim, prefix and family names included (naming leak reference). */
  rawSubject: boolean;
};

export const READER_CONDITION: EvidenceCondition = {
  names: 'visible',
  withTestDir: false,
  rawSubject: false,
};

export const WITHHELD_CONDITION: EvidenceCondition = {
  names: 'withheld',
  withTestDir: false,
  rawSubject: false,
};

export function conditionLabel(condition: EvidenceCondition): string {
  const base =
    condition.names === 'visible' ? 'reader (scored)' : 'name-withheld ablation (not a score)';
  const relaxed = [
    ...(condition.withTestDir ? ['with-test-dir'] : []),
    ...(condition.rawSubject ? ['raw-subject'] : []),
  ];
  return relaxed.length > 0 ? `leak reference: ${base} + ${relaxed.join(' + ')}` : base;
}

export function taskText(condition: EvidenceCondition): string {
  const naming =
    condition.names === 'visible'
      ? 'Import and test paths are real repository paths, so a folder or package name in them ' +
        'is information you may use. The file under judgement is never named, and its own path ' +
        'is never shown.'
      : 'Every family name has been replaced by «x» wherever it appeared, including inside ' +
        'paths, so you cannot read a family out of a directory name.';
  return (
    'You are shown evidence about one TypeScript module in a repository organised into families ' +
    '(workspace packages and top-level source folders). From the evidence alone, choose the ' +
    'family the module most plausibly belongs to. ' +
    naming
  );
}

export const EVIDENCE_LEGEND =
  'imports: repository files the module value-imports; external: package specifiers it imports; ' +
  'test: the basename of its mirrored test file (foreign = that test lives in another family); ' +
  'subject: the subject of the commit that placed the module, with the conventional-commit ' +
  'prefix and pull-request number removed.';

export const QUESTION_TEXT = 'Which family does this module belong to?';

export function evidenceLine(
  file: CorpusFile,
  condition: EvidenceCondition,
  scrubber: Scrubber,
): string {
  const shown = (text: string) => (condition.names === 'withheld' ? scrubber.scrub(text) : text);
  const parts: string[] = [];
  parts.push(`imports: ${file.imports.length > 0 ? file.imports.map(shown).join(', ') : '(none)'}`);
  parts.push(
    `external: ${file.externals.length > 0 ? file.externals.map(shown).join(', ') : '(none)'}`,
  );
  if (file.testMirror) {
    const test =
      condition.withTestDir && !file.testMirror.foreign
        ? file.testMirror.path
        : file.testMirror.basename;
    parts.push(`test: ${shown(test)}${file.testMirror.foreign ? ' (foreign)' : ''}`);
  } else {
    parts.push('test: (none)');
  }
  if (file.firstTouch) {
    // The subject is the narrative of a change, not the structure of the tree, so it stays
    // redacted in every condition except the naming leak reference.
    const subject = condition.rawSubject
      ? file.firstTouch.rawSubject
      : scrubber.scrub(file.firstTouch.subject);
    parts.push(`subject: ${subject}`);
  } else {
    parts.push('subject: (none)');
  }
  return parts.join(' | ');
}

export type LeakAudit = {
  files: number;
  leaking: string[];
  rate: number;
};

/**
 * Files whose evidence still names their own family. Read it two ways, depending on the
 * condition it audited: under `withheld` it is a scrubber defect that must stay near zero, and
 * under `reader` it is the name echo — the share of placements a directory name already gives.
 */
export function auditOwnFamilyLeaks(
  lines: ReadonlyMap<string, string>,
  familyOf: (id: string) => string,
  namesOf: (family: string) => readonly string[],
): LeakAudit {
  const leaking: string[] = [];
  for (const [id, line] of lines) {
    if (leaksName(line, namesOf(familyOf(id)))) leaking.push(id);
  }
  return { files: lines.size, leaking, rate: lines.size > 0 ? leaking.length / lines.size : 0 };
}

/** Ceiling on the scrubber's own defect rate under the name-withheld condition. */
export const MAX_LEAK_RATE = 0.01;
