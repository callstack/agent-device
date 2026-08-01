// The one place the graph is read off disk, shared by the whole-graph report and the
// `affected` query so both describe the same tree by construction.

import fs from 'node:fs';
import path from 'node:path';
import { listSourceFiles } from '../layering/check.ts';
import { resolveImportEdges } from '../layering/model.ts';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';
import { buildGraph, type GraphData } from './model.ts';

export function loadGraph(repoRoot: string): GraphData {
  const sources = new Map(
    listSourceFiles().map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  return buildGraph(sources, resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)));
}
