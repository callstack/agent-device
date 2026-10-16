import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

/** What one breadth-first walk over the runtime import edges from a process entry found. */
export type ReachWalk = Readonly<{
  /** The edge that first loaded each reached module; null for an entry. */
  loadedBy: ReadonlyMap<string, ResolvedImportEdge | null>;
  /** Runtime edges the walk refused to enter, in discovery order. */
  stopped: readonly ResolvedImportEdge[];
  /** The shortest chain of modules from an entry to `file`. */
  chainTo(file: string): readonly string[];
}>;

/**
 * Walks every module a process can load from `entries` over static and dynamic edges, so a
 * function-scoped `await import` counts. Type-only static edges load nothing and are skipped. An
 * edge `stopAt` accepts is recorded in `stopped` and not entered.
 */
export function walkProcessReach(
  entries: readonly string[],
  edges: readonly ResolvedImportEdge[],
  stopAt: (edge: ResolvedImportEdge) => boolean = () => false,
): ReachWalk {
  const outgoing = new Map<string, ResolvedImportEdge[]>();
  for (const edge of edges) {
    if (edge.typeOnly && !edge.dynamic) continue;
    const list = outgoing.get(edge.file) ?? [];
    list.push(edge);
    outgoing.set(edge.file, list);
  }
  const loadedBy = new Map<string, ResolvedImportEdge | null>(entries.map((e) => [e, null]));
  const stopped: ResolvedImportEdge[] = [];
  const queue = [...entries];
  for (let head = 0; head < queue.length; head += 1) {
    for (const edge of outgoing.get(queue[head]!) ?? []) {
      if (stopAt(edge)) {
        stopped.push(edge);
        continue;
      }
      if (loadedBy.has(edge.target)) continue;
      loadedBy.set(edge.target, edge);
      queue.push(edge.target);
    }
  }
  return {
    loadedBy,
    stopped,
    chainTo(file) {
      const chain = [file];
      for (let at = loadedBy.get(file) ?? null; at; at = loadedBy.get(at.file) ?? null) {
        chain.unshift(at.file);
      }
      return chain;
    },
  };
}

/**
 * A rename or move must not turn a reach walk into a silent pass: every entry or denied module
 * that is not a tracked source is a violation of its own.
 */
export function staleReachModules(
  rule: string,
  declaredIn: string,
  modules: readonly string[],
  sourceFiles: readonly string[],
  declaration: string,
): LayeringViolation[] {
  const tracked = new Set(sourceFiles);
  return modules
    .filter((module) => !tracked.has(module))
    .map((module) => ({
      rule,
      file: declaredIn,
      line: 1,
      message:
        `stale module: ${module} is not a tracked source. Point ${declaration} at its new ` +
        'path so the reach check keeps a real target.',
    }));
}
