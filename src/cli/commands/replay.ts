import fs from 'node:fs';
import path from 'node:path';
import { exportReplayScriptToMaestro } from '../../compat/maestro/export-flow.ts';
import { AppError } from '../../kernel/errors.ts';
import { resolveUserPath } from '../../utils/path-resolution.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

type ReplayCommandParams = Parameters<ClientCommandHandler>[0];

export const replayCommand: ClientCommandHandler = async (params) => {
  const { positionals } = params;
  if (positionals[0] !== 'export') {
    return handleReplayRunCommand(params);
  }
  return await handleReplayExportCommand(params);
};

function handleReplayRunCommand({ positionals, flags }: ReplayCommandParams): false {
  if (positionals.length > 1) {
    throw new AppError('INVALID_ARGS', 'replay accepts exactly one input path: replay <path>');
  }
  if (flags.replayExportFormat !== undefined || flags.out !== undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'replay --format/--out are only supported with replay export.',
    );
  }
  return false;
}

async function handleReplayExportCommand({
  positionals,
  flags,
}: ReplayCommandParams): Promise<true> {
  validateReplayExportOptions(positionals, flags);
  const inputPath = positionals[1];
  if (!inputPath) {
    throw new AppError('INVALID_ARGS', 'replay export requires an input path.');
  }

  const sourcePath = resolveUserPath(inputPath);
  const script = fs.readFileSync(sourcePath, 'utf8');
  const result = exportReplayScriptToMaestro(script);
  const outputPath = typeof flags.out === 'string' ? resolveUserPath(flags.out) : undefined;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, result.yaml);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`Warning: line ${warning.line}: ${warning.message}\n`);
  }

  writeCommandOutput(
    flags,
    {
      format: flags.replayExportFormat ?? 'maestro',
      sourcePath,
      ...(outputPath ? { path: outputPath } : { yaml: result.yaml }),
      warnings: result.warnings,
    },
    () => outputPath ?? result.yaml,
  );
  return true;
}

function validateReplayExportOptions(
  positionals: ReplayCommandParams['positionals'],
  flags: ReplayCommandParams['flags'],
): void {
  if (positionals.length > 2) {
    throw new AppError(
      'INVALID_ARGS',
      'replay export accepts exactly one input path: replay export <file.ad>',
    );
  }
  if (flags.replayUpdate) {
    throw new AppError('INVALID_ARGS', 'replay export does not support --update.');
  }
  if (flags.replayMaestro) {
    throw new AppError('INVALID_ARGS', 'replay export reads .ad files; omit --maestro.');
  }
  if (flags.replayEnv?.length) {
    throw new AppError('INVALID_ARGS', 'replay export does not evaluate --env substitutions.');
  }
  const format = flags.replayExportFormat ?? 'maestro';
  if (format !== 'maestro') {
    throw new AppError('INVALID_ARGS', `Unsupported replay export format: ${format}`);
  }
}
