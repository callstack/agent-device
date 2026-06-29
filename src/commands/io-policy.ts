import type {
  CreateTempFileOptions,
  FileInputRef,
  FileOutputRef,
  ReserveOutputOptions,
  ReservedOutputFile,
  ResolvedInputFile,
  ResolveInputOptions,
  TemporaryFile,
} from '../io.ts';
import type { AgentDeviceRuntime } from '../runtime-contract.ts';
import { AppError, asAppError } from '../kernel/errors.ts';

export async function resolveCommandInput(
  runtime: AgentDeviceRuntime,
  ref: FileInputRef,
  options: ResolveInputOptions,
): Promise<ResolvedInputFile> {
  if (ref.kind === 'path' && !runtime.policy.allowLocalInputPaths) {
    throw new AppError(
      'INVALID_ARGS',
      `Local ${options.field ?? 'input'} paths are not allowed by command policy`,
    );
  }
  try {
    return await runtime.artifacts.resolveInput(ref, options);
  } catch (error) {
    throw asAppError(error);
  }
}

export async function reserveCommandOutput(
  runtime: AgentDeviceRuntime,
  ref: FileOutputRef | undefined,
  options: ReserveOutputOptions,
): Promise<ReservedOutputFile> {
  if (ref?.kind === 'path' && !runtime.policy.allowLocalOutputPaths) {
    throw new AppError('INVALID_ARGS', 'Local output paths are not allowed by command policy');
  }
  try {
    return await runtime.artifacts.reserveOutput(ref, {
      ...options,
      visibility: options.visibility ?? 'client-visible',
      requestedClientPath:
        ref?.kind === 'downloadableArtifact'
          ? (ref.clientPath ?? options.requestedClientPath)
          : options.requestedClientPath,
    });
  } catch (error) {
    throw asAppError(error);
  }
}

export async function createCommandTempFile(
  runtime: AgentDeviceRuntime,
  options: CreateTempFileOptions,
): Promise<TemporaryFile> {
  try {
    return await runtime.artifacts.createTempFile(options);
  } catch (error) {
    throw asAppError(error);
  }
}
