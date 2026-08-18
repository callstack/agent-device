import { createMaestroExecutionContext } from './engine-context.ts';
import type { MaestroCommand, MaestroProgram } from './program-ir.ts';
import { parseMaestroProgram } from './program-ir-parser.ts';
import { resolveMaestroIncludePath } from './program-loader.ts';

/**
 * Reads one flow file, or reports that it is unavailable (#1802). Collection is
 * BEST EFFORT by design — see `collectMaestroFlowSources`.
 */
export type MaestroOptionalSourceReader = (resolvedPath: string) => string | undefined;

/**
 * Every flow file a run of `entryPath` can reach through `runFlow: file:`, as
 * a path-to-text map, collected before the run starts (#1802: the caller ships
 * this to the daemon instead of a path the daemon would open itself).
 *
 * Collection is best effort past the entry flow. An include path is a template
 * (`runFlow: ${FLOW_NAME}.yaml`) resolved from the execution context, and the
 * context a compile really runs with also carries daemon-side defaults — the
 * device, platform, and session the caller has not bound yet. So an include
 * whose path does not resolve from the variables available here, and one whose
 * file cannot be read, is simply left out rather than failing the whole
 * collection: a `when:`-guarded include may never run at all. If a run does
 * need one, the engine's loader reports exactly which file was missing from
 * the sources the request carried.
 */
export function collectMaestroFlowSources(params: {
  entryPath: string;
  entrySource: string;
  readSource: MaestroOptionalSourceReader;
  env?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const files: Record<string, string> = { [params.entryPath]: params.entrySource };
  const program = tryParseMaestroProgram(params.entrySource, params.entryPath);
  if (!program) return files;
  visitProgram({
    program,
    sourcePath: params.entryPath,
    context: createMaestroExecutionContext({}, { ...params.env }),
    files,
    readSource: params.readSource,
  });
  return files;
}

/**
 * A flow that does not parse is not a collection failure: the daemon reports
 * every authoring error for the whole run, in one place, with its source
 * location. Collecting stops at the unparseable file and the run does the
 * reporting.
 */
function tryParseMaestroProgram(source: string, sourcePath: string): MaestroProgram | undefined {
  try {
    return parseMaestroProgram(source, { sourcePath });
  } catch {
    return undefined;
  }
}

type VisitParams = {
  program: MaestroProgram;
  sourcePath: string;
  context: ReturnType<typeof createMaestroExecutionContext>;
  files: Record<string, string>;
  readSource: MaestroOptionalSourceReader;
};

function visitProgram(params: VisitParams): void {
  const leave = params.context.enter(params.program.config.env ?? {});
  try {
    visitCommands(
      [
        ...(params.program.config.onFlowStart ?? []),
        ...params.program.commands,
        ...(params.program.config.onFlowComplete ?? []),
      ],
      params,
    );
  } finally {
    leave();
  }
}

function visitCommands(commands: readonly MaestroCommand[], params: VisitParams): void {
  for (const command of commands) {
    if (command.kind === 'repeat' || command.kind === 'retry') {
      visitCommands(command.commands, params);
      continue;
    }
    if (command.kind !== 'runFlow') continue;
    const leave = params.context.enter(command.env ?? {});
    try {
      if (command.include.kind === 'commands') {
        visitCommands(command.include.commands, params);
        continue;
      }
      visitInclude(command.include.path, params);
    } finally {
      leave();
    }
  }
}

function visitInclude(includePath: string, params: VisitParams): void {
  // `resolveDeferred` leaves an unknown `${VAR}` in place instead of throwing, which is how an
  // include this side cannot resolve gets recognized and skipped.
  const resolvedInclude = params.context.resolveDeferred(includePath);
  if (resolvedInclude.includes('${')) return;
  const resolvedPath = resolveMaestroIncludePath(
    resolvedInclude,
    params.sourcePath,
    params.sourcePath,
  );
  if (params.files[resolvedPath] !== undefined) return;
  const source = params.readSource(resolvedPath);
  if (source === undefined) return;
  params.files[resolvedPath] = source;
  const program = tryParseMaestroProgram(source, resolvedPath);
  if (!program) return;
  visitProgram({ ...params, program, sourcePath: resolvedPath });
}
