import fs from 'node:fs';
import path from 'node:path';
import { createRequestCanceledError } from '../../request/cancel.ts';
import type { MaestroProgram } from './program-ir.ts';
import { parseMaestroProgram } from './program-ir-parser.ts';

export type MaestroProgramLoader = (
  includePath: string,
  parentSource?: string,
  signal?: AbortSignal,
) => Promise<MaestroProgram>;

export function createMaestroProgramLoader(cwd: string): MaestroProgramLoader {
  const programs = new Map<string, MaestroProgram>();
  return async (includePath, parentSource, signal) => {
    if (signal?.aborted) throw createRequestCanceledError();
    const resolvedPath = resolveMaestroIncludePath(includePath, parentSource, cwd);
    const cached = programs.get(resolvedPath);
    if (cached) return cached;
    const program = parseMaestroProgram(fs.readFileSync(resolvedPath, 'utf8'), {
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
