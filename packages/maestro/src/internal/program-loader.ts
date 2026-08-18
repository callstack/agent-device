import path from 'node:path';
import { createRequestCanceledError } from './shared.ts';
import type { MaestroProgram } from './program-ir.ts';
import { parseMaestroProgram } from './program-ir-parser.ts';

/**
 * How a flow's text is obtained. #1802: the engine never touches a filesystem —
 * the caller reads its own flows (fs) when it builds a replay script source
 * bundle, and the daemon serves the same flows back out of that bundle, so a
 * `runFlow` include resolves to identical bytes locally and against a remote
 * daemon.
 */
export type MaestroSourceReader = (resolvedPath: string) => string;

export type MaestroProgramLoader = (
  includePath: string,
  parentSource?: string,
  signal?: AbortSignal,
) => Promise<MaestroProgram>;

export function createMaestroProgramLoader(
  cwd: string,
  readSource: MaestroSourceReader,
): MaestroProgramLoader {
  const programs = new Map<string, MaestroProgram>();
  return async (includePath, parentSource, signal) => {
    if (signal?.aborted) throw createRequestCanceledError();
    const resolvedPath = resolveMaestroIncludePath(includePath, parentSource, cwd);
    const cached = programs.get(resolvedPath);
    if (cached) return cached;
    const program = parseMaestroProgram(readSource(resolvedPath), {
      sourcePath: resolvedPath,
    });
    programs.set(resolvedPath, program);
    return program;
  };
}

export function resolveMaestroIncludePath(
  includePath: string,
  parentSource: string | undefined,
  cwd: string,
): string {
  const basePath = parentSource ? path.dirname(parentSource) : cwd;
  return path.resolve(basePath, includePath);
}
