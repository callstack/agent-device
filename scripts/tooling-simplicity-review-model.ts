const IMPLEMENTATION_REVIEW_THRESHOLD = 500;
const COMBINED_REVIEW_THRESHOLD = 1_000;
const REVIEW_HEADING = '## Simplicity review';

const EXECUTABLE_EXTENSION = /\.(?:[cm]?[jt]s|py|rb|sh)$/;
const WORKFLOW_EXTENSION = /\.ya?ml$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;
const EXCLUDED_DATA_PATH = /(?:^|\/)(?:corpus|fixtures|snapshots?|testdata)(?:\/|$)/;

export type NumstatEntry = {
  readonly additions: number;
  readonly path: string;
};

export type SimplicityReviewAssessment = {
  readonly implementationAdditions: number;
  readonly testAdditions: number;
  readonly requiresReview: boolean;
  readonly reasons: readonly string[];
  readonly implementationFiles: readonly string[];
};

export function parseNumstat(input: string): NumstatEntry[] {
  return input
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [added, , ...pathParts] = line.split('\t');
      const additions = Number.parseInt(added ?? '', 10);
      const file = pathParts.join('\t');
      return Number.isFinite(additions) && file ? [{ additions, path: file }] : [];
    });
}

function isToolingImplementation(path: string): boolean {
  if (TEST_FILE.test(path) || EXCLUDED_DATA_PATH.test(path)) {
    return false;
  }
  if (path.startsWith('.github/workflows/')) return WORKFLOW_EXTENSION.test(path);
  if (path.startsWith('.github/actions/')) {
    return EXECUTABLE_EXTENSION.test(path) || WORKFLOW_EXTENSION.test(path);
  }
  if (!EXECUTABLE_EXTENSION.test(path)) return false;
  return path.startsWith('scripts/') || path.startsWith('test/') || path.startsWith('tools/');
}

function isAssociatedTest(path: string): boolean {
  if (!TEST_FILE.test(path) || EXCLUDED_DATA_PATH.test(path)) return false;
  return path.startsWith('scripts/') || path.startsWith('test/') || path.includes('/__tests__/');
}

export function assessToolingSimplicity(
  entries: readonly NumstatEntry[],
): SimplicityReviewAssessment {
  const implementationEntries = entries.filter((entry) => isToolingImplementation(entry.path));
  const implementationAdditions = implementationEntries.reduce(
    (total, entry) => total + entry.additions,
    0,
  );
  const testAdditions = entries
    .filter((entry) => isAssociatedTest(entry.path))
    .reduce((total, entry) => total + entry.additions, 0);
  const combinedAdditions = implementationAdditions + testAdditions;
  const display = (value: number): string => value.toLocaleString('en-US');
  const reasons = [
    ...(implementationAdditions >= IMPLEMENTATION_REVIEW_THRESHOLD
      ? [
          `${display(implementationAdditions)} custom tooling implementation lines (threshold ${display(IMPLEMENTATION_REVIEW_THRESHOLD)})`,
        ]
      : []),
    ...(implementationAdditions > 0 && combinedAdditions >= COMBINED_REVIEW_THRESHOLD
      ? [
          `${display(combinedAdditions)} combined implementation and test lines (threshold ${display(COMBINED_REVIEW_THRESHOLD)})`,
        ]
      : []),
  ];

  return {
    implementationAdditions,
    testAdditions,
    requiresReview: reasons.length > 0,
    reasons,
    implementationFiles: implementationEntries.map((entry) => entry.path),
  };
}

export function hasSubstantiveSimplicityReview(body: string): boolean {
  const heading = /^## Simplicity review\s*$/m.exec(body);
  if (!heading) return false;

  const section = body.slice(heading.index + heading[0].length).split(/^##\s/m, 1)[0] ?? '';
  const withoutComments = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  return withoutComments.length >= 100;
}

export const SIMPLICITY_REVIEW_HEADING = REVIEW_HEADING;
