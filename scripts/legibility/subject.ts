// The commit-subject evidence: a conventional-commit subject with its `type(scope):` prefix and
// trailing `(#NNNN)` references removed. The scope is where the family name usually sits, and
// the PR number is noise; what remains is the sentence the author wrote about the change.

const CONVENTIONAL_PREFIX = /^\s*[a-z]+(?:\([^)]*\))?!?:\s*/i;
const TRAILING_PR_REFERENCES = /(?:\s*\(#\d+\))+\s*$/;

export function stripConventionalSubject(subject: string): string {
  return subject.replace(CONVENTIONAL_PREFIX, '').replace(TRAILING_PR_REFERENCES, '').trim();
}
