import path from 'node:path';
import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import { MAESTRO_RUNTIME_COMMAND } from './runtime-commands.ts';
import {
  action,
  assertOnlyKeys,
  isPlainRecord,
  readEnvMap,
  requireStringValue,
  resolveMaestroString,
} from './support.ts';
import type { MaestroParseContext } from './types.ts';

export function convertRunScript(value: unknown, context: MaestroParseContext): SessionAction {
  const scriptConfig = readRunScriptConfig(value, context);
  const scriptPath = resolveRunScriptPath(scriptConfig.file, context);
  return action(MAESTRO_RUNTIME_COMMAND.runScript, [scriptPath], {
    ...(Object.keys(scriptConfig.env).length > 0
      ? { maestro: { runScriptEnv: scriptConfig.env } }
      : {}),
  });
}

function readRunScriptConfig(
  value: unknown,
  context: MaestroParseContext,
): { file: string; env: Record<string, string> } {
  if (typeof value === 'string') {
    return { file: resolveMaestroString(value, context), env: {} };
  }
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'runScript expects a file path string or map.');
  }
  assertOnlyKeys(value, 'runScript', ['file', 'env']);
  const file = resolveMaestroString(requireStringValue('runScript.file', value.file), context);
  const rawEnv = readEnvMap(value.env, 'runScript.env');
  const env = Object.fromEntries(
    Object.entries(rawEnv).map(([key, envValue]) => [key, resolveMaestroString(envValue, context)]),
  );
  return { file, env };
}

function resolveRunScriptPath(filePath: string, context: MaestroParseContext): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (!context.baseDir) {
    throw new AppError(
      'INVALID_ARGS',
      'runScript file paths require replay input to have a source path.',
    );
  }
  return path.resolve(context.baseDir, filePath);
}
