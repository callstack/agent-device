import { AppError } from '@agent-device/kernel/errors';
import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import { validateAndNormalizeBatchSteps } from '@agent-device/command-registry/batch';
import { DEFAULT_BATCH_MAX_STEPS } from '@agent-device/contracts/command';
import type { DaemonRequest } from '../core/daemon-request.ts';

const HOST_PATH_FIELDS = [
  'sessionSaveScript',
  'launchConsole',
  'baseline',
  'stepsFile',
  'searchPath',
  'metroProjectRoot',
  'metroRuntimeFile',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'iosSimulatorDeviceSet',
] as const;

/** Remote callers choose client destinations; only the daemon chooses host output paths. */
export function restrictRemoteHostInputs(request: DaemonRequest): DaemonRequest {
  if (!request.internal?.publicNetworkOnly) return request;
  const { cwd: _cwd, ...meta } = request.meta ?? {};
  const command = request.command;
  const fields = [request.flags, request.input, request.runtime];
  assertRemoteHostToolingInputs(request, fields);
  const { out: _out, artifactsDir: _artifactsDir, ...flags } = request.flags ?? {};
  const { artifactsDir: _inputArtifactsDir, ...input } = request.input ?? {};
  if (command === 'batch') return restrictRemoteBatchSteps({ ...request, flags, meta });
  if (command === 'test') {
    return { ...request, flags, ...(request.input ? { input } : {}), meta };
  }
  if (!['screenshot', 'record', 'perf', 'trace'].includes(command)) {
    if (fields.some((record) => record && Object.hasOwn(record, 'out'))) {
      throw remoteHostInputDenied('out');
    }
    if (fields.some((record) => record && Object.hasOwn(record, 'artifactsDir'))) {
      throw remoteHostInputDenied('artifactsDir');
    }
    return { ...request, meta };
  }
  return restrictRemoteCaptureOutput({
    ...request,
    flags,
    ...(request.input ? { input } : {}),
    meta,
  });
}

function assertRemoteHostToolingInputs(
  request: DaemonRequest,
  fields: Array<object | undefined>,
): void {
  const hostPath = HOST_PATH_FIELDS.find((field) =>
    fields.some((record) => record && Object.hasOwn(record, field)),
  );
  const script = request.flags?.saveScript;
  const invalidScript = fields.some(
    (record) =>
      record &&
      Object.hasOwn(record, 'saveScript') &&
      (record !== request.flags ||
        request.command !== 'open' ||
        !(
          script === true ||
          (request.internal?.remoteScriptDelivery === true && typeof script === 'string')
        )),
  );
  const invalidPublication =
    request.command === INTERNAL_COMMANDS.sessionSaveScript &&
    (request.input?.path !== undefined ||
      (request.positionals.length > 0 && request.internal?.remoteScriptDelivery !== true));
  if (invalidScript) throw remoteHostInputDenied('saveScript');
  if (hostPath || invalidPublication) {
    throw remoteHostInputDenied(hostPath ?? 'command');
  }
  const hostArgument = findRemoteFileUrlInput(request) ?? findRemoteHostArgument(request);
  if (hostArgument) throw remoteHostInputDenied(hostArgument);
}

function findRemoteFileUrlInput(request: DaemonRequest): string | undefined {
  const fields = [request.flags, request.input, request.runtime];
  if (fields.some((record) => isFileUrl(record?.launchUrl))) return 'launchUrl';
  if (request.command !== 'open') return undefined;
  if (request.positionals?.some(isFileUrl)) return 'url';
  return ['app', 'url'].find((field) => isFileUrl(request.input?.[field]));
}

/** Positional forms that name a daemon host file. Remote callers upload binaries and inline payloads. */
function findRemoteHostArgument(request: DaemonRequest): string | undefined {
  const positionals = request.positionals ?? [];
  const uploadedArtifactId = request.meta?.uploadedArtifactId;
  const hasUpload = typeof uploadedArtifactId === 'string' && uploadedArtifactId.length > 0;
  if (request.meta?.installSource?.kind === 'path' && !hasUpload) return 'installSource';
  switch (request.command) {
    case 'install':
    case 'reinstall':
      return hasUpload ? undefined : 'appPath';
    case 'push':
      return positionals[1] === undefined || isInlineJsonPayload(positionals[1])
        ? undefined
        : 'payload';
    case 'perf': {
      const template = perfTemplatePositional(positionals);
      return template && !REMOTE_XCTRACE_TEMPLATES.has(template) ? 'template' : undefined;
    }
  }
  return undefined;
}

function isFileUrl(value: unknown): boolean {
  return typeof value === 'string' && URL.parse(value)?.protocol === 'file:';
}

function isInlineJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

function perfTemplatePositional(positionals: string[]): string | undefined {
  const area = positionals[0]?.toLowerCase();
  if (area === 'cpu') return positionals[4];
  if (area === 'trace') return positionals[3];
  return undefined;
}

// xctrace resolves a template argument as a file before it resolves a name, so remote callers may
// name only the standard templates that `xcrun xctrace list templates` reports.
const REMOTE_XCTRACE_TEMPLATES: ReadonlySet<string> = new Set([
  'Activity Monitor',
  'Allocations',
  'Animation Hitches',
  'App Launch',
  'Audio System Trace',
  'CPU Counters',
  'CPU Profiler',
  'Core AI',
  'Data Persistence',
  'File Activity',
  'Foundation Models',
  'Game Memory',
  'Game Performance',
  'Game Performance Overview',
  'Leaks',
  'Logging',
  'Metal System Trace',
  'Network',
  'Power Profiler',
  'Processor Trace',
  'RealityKit Trace',
  'Swift Concurrency',
  'SwiftUI',
  'System Trace',
  'Time Profiler',
]);

function restrictRemoteBatchSteps(request: DaemonRequest): DaemonRequest {
  const flags = { ...request.flags };
  const steps = validateAndNormalizeBatchSteps(
    flags.batchSteps,
    flags.batchMaxSteps ?? DEFAULT_BATCH_MAX_STEPS,
  );
  flags.batchSteps = steps.map((step) => {
    if (
      step.flags?.saveScript !== undefined ||
      step.command === INTERNAL_COMMANDS.sessionSaveScript
    ) {
      throw remoteHostInputDenied('saveScript');
    }
    const restricted = restrictRemoteHostInputs({ ...request, ...step });
    return {
      ...step,
      positionals: restricted.positionals,
      flags: restricted.flags,
      input: restricted.input,
    };
  });
  return { ...request, flags };
}

function restrictRemoteCaptureOutput(request: DaemonRequest): DaemonRequest {
  const { path: _path, out: _out, outPath: _outPath, ...input } = request.input ?? {};
  return {
    ...request,
    positionals: remoteCapturePositionals(request),
    ...(request.input ? { input } : {}),
  };
}

function remoteCapturePositionals(request: DaemonRequest): string[] {
  const positionals = [...(request.positionals ?? [])];
  switch (request.command) {
    case 'screenshot':
      return [];
    case 'record':
    case 'trace':
      return positionals.slice(0, 1);
    case 'perf':
      if (positionals[0]?.toLowerCase() === 'cpu') return positionals.slice(0, 5);
      if (positionals[0]?.toLowerCase() === 'trace') return positionals.slice(0, 4);
  }
  return positionals;
}

function remoteHostInputDenied(field: string): AppError {
  return new AppError('INVALID_ARGS', `Remote requests cannot supply the host input ${field}.`, {
    reason: 'REMOTE_HOST_INPUT_DENIED',
    field,
    retriable: false,
    hint: 'Omit host paths and download generated output artifacts by ID. Use a local daemon for host tooling.',
  });
}
