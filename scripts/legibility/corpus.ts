// The legibility corpus: one record per production file carrying exactly the four kinds of
// evidence the report may show — resolved value-import targets, external specifiers, the
// mirrored test, and the first-touch commit subject — plus the ground-truth family. Files and
// families are the layering gate's own; import edges come from its resolver; nothing here
// re-derives any of them.

import type { FamilyOf } from '../coupling/modularity.ts';
import { parseImports, type ImportEdge, type ResolvedImportEdge } from '../layering/model.ts';
import { arrivedViaRename, type FirstTouch } from '../repo-history/records.ts';
import { stripConventionalSubject } from './subject.ts';
import { indexTestFiles, resolveTestMirror, type TestMirror } from './test-mirror.ts';

export type CorpusFile = {
  id: string;
  family: string;
  /** Value-import targets resolved to repository paths, sorted, unique. */
  imports: string[];
  /** Value-import specifiers that do not resolve into the repository, sorted, unique. */
  externals: string[];
  testMirror: TestMirror | null;
  firstTouch: { sha: string; subject: string; rawSubject: string; viaRename: boolean } | null;
};

export type Corpus = {
  files: CorpusFile[];
  /** Every family id in the answer space, sorted. */
  families: string[];
  byId: Map<string, CorpusFile>;
};

export type CorpusInput = {
  sources: ReadonlyMap<string, string>;
  edges: readonly ResolvedImportEdge[];
  testFiles: readonly string[];
  firstTouch: ReadonlyMap<string, FirstTouch>;
  familyOf: FamilyOf;
  parse?: (source: string) => ImportEdge[];
};

function isValueImport(edge: ImportEdge): boolean {
  return !edge.typeOnly && !edge.dynamic;
}

function isRepositorySpecifier(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('@agent-device/');
}

export function buildCorpus(input: CorpusInput): Corpus {
  const parse = input.parse ?? parseImports;
  const resolvedBySource = new Map<string, Set<string>>();
  for (const edge of input.edges) {
    if (!isValueImport(edge)) continue;
    const targets = resolvedBySource.get(edge.file) ?? new Set<string>();
    targets.add(edge.target);
    resolvedBySource.set(edge.file, targets);
  }
  const testIndex = indexTestFiles(input.testFiles);
  const files: CorpusFile[] = [];
  for (const [id, source] of [...input.sources].sort(([a], [b]) => a.localeCompare(b))) {
    const externals = new Set<string>();
    for (const edge of parse(source)) {
      if (isValueImport(edge) && !isRepositorySpecifier(edge.spec)) externals.add(edge.spec);
    }
    const touch = input.firstTouch.get(id);
    files.push({
      id,
      family: input.familyOf(id),
      imports: [...(resolvedBySource.get(id) ?? [])].filter((target) => target !== id).sort(),
      externals: [...externals].sort(),
      testMirror: resolveTestMirror(id, testIndex, input.familyOf),
      firstTouch: touch
        ? {
            sha: touch.sha,
            subject: stripConventionalSubject(touch.subject),
            rawSubject: touch.subject,
            viaRename: arrivedViaRename(touch),
          }
        : null,
    });
  }
  return {
    files,
    families: [...new Set(files.map((file) => file.family))].sort(),
    byId: new Map(files.map((file) => [file.id, file])),
  };
}
