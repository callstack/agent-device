import type {
  BackendRecordingOptions,
  BackendRecordingResult,
  BackendTraceOptions,
  BackendTraceResult,
} from '../../../backend.ts';
import type { ArtifactDescriptor, FileOutputRef } from '../../../io.ts';
import type { CommandContext } from '../../../runtime-contract.ts';
import { AppError } from '../../../kernel/errors.ts';
import { successText } from '../../../utils/success-text.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import {
  recordingQualityInputToExportQuality,
  type RecordingExportQuality,
} from '../../../core/recording-export-quality.ts';
import type {
  BackendResultEnvelope,
  BackendResultVariant,
  RuntimeCommand,
} from '../../runtime-types.ts';
import { reserveCommandOutput } from '../../io-policy.ts';
import { toBackendContext } from '../../runtime-common.ts';

export type RecordingRecordCommandOptions = CommandContext & {
  action: 'start' | 'stop';
  out?: FileOutputRef;
  fps?: number;
  maxSize?: number;
  quality?: RecordingExportQuality;
  hideTouches?: boolean;
};

export type RecordingTraceCommandOptions = CommandContext & {
  action: 'start' | 'stop';
  out?: FileOutputRef;
};

export type RecordingRecordCommandResult = BackendResultVariant<{
  kind: 'recordingStarted' | 'recordingStopped';
  action: 'start' | 'stop';
  path?: string;
  telemetryPath?: string;
  artifact?: ArtifactDescriptor;
  warning?: string;
}>;

export type RecordingTraceCommandResult = {
  kind: 'traceStarted' | 'traceStopped';
  action: 'start' | 'stop';
  outPath?: string;
  artifact?: ArtifactDescriptor;
} & BackendResultEnvelope;

export const recordCommand: RuntimeCommand<
  RecordingRecordCommandOptions,
  RecordingRecordCommandResult
> = async (runtime, options): Promise<RecordingRecordCommandResult> => {
  const action = requireAction(options.action, 'record');
  const method =
    action === 'start' ? runtime.backend.startRecording : runtime.backend.stopRecording;
  if (!method) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `record ${action} is not supported by this backend`,
    );
  }

  const output = options.out
    ? await reserveCommandOutput(runtime, options.out, {
        field: 'path',
        ext: '.mp4',
      })
    : undefined;
  try {
    const backendOptions = normalizeRecordingOptions(options, output?.path);
    const result = await method.call(
      runtime.backend,
      toBackendContext(runtime, options),
      backendOptions,
    );
    const artifact = await output?.publish();
    return formatRecordingResult(action, result, artifact);
  } catch (error) {
    await output?.cleanup?.();
    throw error;
  }
};

export const traceCommand: RuntimeCommand<
  RecordingTraceCommandOptions,
  RecordingTraceCommandResult
> = async (runtime, options): Promise<RecordingTraceCommandResult> => {
  const action = requireAction(options.action, 'trace');
  const method = action === 'start' ? runtime.backend.startTrace : runtime.backend.stopTrace;
  if (!method) {
    throw new AppError('UNSUPPORTED_OPERATION', `trace ${action} is not supported by this backend`);
  }

  const output = options.out
    ? await reserveCommandOutput(runtime, options.out, {
        field: 'outPath',
        ext: '.trace',
      })
    : undefined;
  try {
    const backendOptions: BackendTraceOptions = {
      ...(output?.path ? { outPath: output.path } : {}),
    };
    const result = await method.call(
      runtime.backend,
      toBackendContext(runtime, options),
      backendOptions,
    );
    const artifact = await output?.publish();
    return formatTraceResult(action, result, artifact);
  } catch (error) {
    await output?.cleanup?.();
    throw error;
  }
};

function normalizeRecordingOptions(
  options: RecordingRecordCommandOptions,
  outPath: string | undefined,
): BackendRecordingOptions {
  const backendOptions: BackendRecordingOptions = {};
  if (outPath) backendOptions.outPath = outPath;
  const fps = normalizeRecordingFps(options.fps);
  if (fps !== undefined) backendOptions.fps = fps;
  const maxSize = normalizeRecordingMaxSize(options.maxSize);
  if (maxSize !== undefined) backendOptions.maxSize = maxSize;
  const quality = normalizeRecordingExportQuality(options.quality);
  if (quality !== undefined) backendOptions.quality = quality;
  if (options.hideTouches !== undefined) backendOptions.showTouches = options.hideTouches !== true;
  return backendOptions;
}

function normalizeRecordingFps(value: number | undefined): number | undefined {
  return value === undefined ? undefined : requireIntInRange(value, 'fps', 1, 60);
}

function normalizeRecordingMaxSize(value: number | undefined): number | undefined {
  return value === undefined
    ? undefined
    : requireIntInRange(value, 'maxSize', 1, Number.MAX_SAFE_INTEGER);
}

function normalizeRecordingExportQuality(
  value: RecordingExportQuality | undefined,
): BackendRecordingOptions['quality'] {
  if (value === undefined) return undefined;
  const exportQuality = recordingQualityInputToExportQuality(value);
  if (exportQuality === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'quality must be one of: medium, high (legacy numeric values 5-10 are accepted)',
    );
  }
  return exportQuality;
}

function requireAction(action: string, command: string): 'start' | 'stop' {
  if (action === 'start' || action === 'stop') return action;
  throw new AppError('INVALID_ARGS', `${command} action must be start or stop`);
}

function formatRecordingResult(
  action: 'start' | 'stop',
  result: BackendRecordingResult,
  artifact: ArtifactDescriptor | undefined,
): RecordingRecordCommandResult {
  return {
    ...(typeof result.path === 'string' ? { path: result.path } : {}),
    ...(typeof result.telemetryPath === 'string' ? { telemetryPath: result.telemetryPath } : {}),
    ...(typeof result.warning === 'string' ? { warning: result.warning } : {}),
    ...formatLifecycleResult(action, result, artifact, {
      startKind: 'recordingStarted',
      stopKind: 'recordingStopped',
      startMessage: 'Recording started',
      stopMessage: 'Recording stopped',
    }),
  };
}

function formatTraceResult(
  action: 'start' | 'stop',
  result: BackendTraceResult,
  artifact: ArtifactDescriptor | undefined,
): RecordingTraceCommandResult {
  return {
    ...(typeof result.outPath === 'string' ? { outPath: result.outPath } : {}),
    ...formatLifecycleResult(action, result, artifact, {
      startKind: 'traceStarted',
      stopKind: 'traceStopped',
      startMessage: 'Trace started',
      stopMessage: 'Trace stopped',
    }),
  };
}

function formatLifecycleResult<
  TKind extends RecordingRecordCommandResult['kind'] | RecordingTraceCommandResult['kind'],
>(
  action: 'start' | 'stop',
  result: Record<string, unknown>,
  artifact: ArtifactDescriptor | undefined,
  options: {
    startKind: TKind;
    stopKind: TKind;
    startMessage: string;
    stopMessage: string;
  },
): BackendResultVariant<{
  kind: TKind;
  action: 'start' | 'stop';
  artifact?: ArtifactDescriptor;
  backendResult: Record<string, unknown>;
}> {
  return {
    kind: action === 'start' ? options.startKind : options.stopKind,
    action,
    ...(artifact ? { artifact } : {}),
    backendResult: result,
    ...successText(action === 'start' ? options.startMessage : options.stopMessage),
  };
}
