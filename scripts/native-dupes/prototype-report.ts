import { parseSync } from 'oxc-parser';
import { repoRelativePath } from '../lib/repo-path.ts';

type LineRange = { start: number; end: number };
type CloneLocation = LineRange & { name: string };
export type PrototypeClone = { firstFile: CloneLocation; secondFile: CloneLocation };

export function namedConstantRange(source: string, name: string): LineRange {
  const parsed = parseSync('fixture.ts', source);
  if (parsed.errors.length > 0) throw new Error('Cannot parse the prototype fixture');
  const declaration = parsed.program.body
    .flatMap((statement) =>
      statement.type === 'VariableDeclaration' && statement.kind === 'const'
        ? statement.declarations
        : [],
    )
    .find((item) => item.id.type === 'Identifier' && item.id.name === name);
  if (!declaration?.init) throw new Error(`Cannot locate prototype fixture constant ${name}`);
  return {
    start: source.slice(0, declaration.init.start).split('\n').length,
    end: source.slice(0, declaration.init.end).split('\n').length,
  };
}

export function countMotivatingClones(clones: readonly PrototypeClone[], duoRange: LineRange) {
  let fold = 0;
  let duoPanels = 0;
  for (const clone of clones) {
    const files = [clone.firstFile, clone.secondFile].map((file) => ({
      ...file,
      name: repoRelativePath(file.name),
    }));
    if (files.some((file) => file.name.endsWith('/fold-helper/Fold.m'))) fold++;
    if (
      files[0]!.name !== files[1]!.name &&
      files.some(
        (file) =>
          file.name.endsWith('/simctl-facade.test.ts') &&
          file.start <= duoRange.end &&
          file.end >= duoRange.start,
      )
    )
      duoPanels++;
  }
  return { fold, duoPanels };
}
