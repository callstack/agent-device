import type {
  BackendCommandContext,
  BackendDiagnosticsPageOptions,
  BackendDiagnosticsTimeWindow,
  BackendDumpNetworkOptions,
  BackendMeasurePerfOptions,
  BackendNetworkIncludeMode,
  BackendReadLogsOptions,
} from '../../../backend.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { AppError } from '../../../kernel/errors.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import { formatLogsResult, formatNetworkResult, formatPerfResult } from './diagnostics-format.ts';
import type {
  DiagnosticsLogsCommandResult,
  DiagnosticsNetworkCommandResult,
  DiagnosticsPerfCommandResult,
} from './diagnostics-types.ts';
import type { RuntimeCommand } from '../../runtime-types.ts';
import { toBackendContext } from '../../runtime-common.ts';
import { requireText } from '../../text.ts';

export type DiagnosticsPageOptions = CommandContext & {
  appId?: string;
  appBundleId?: string;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
};

export type DiagnosticsLogsCommandOptions = DiagnosticsPageOptions & {
  levels?: readonly string[];
  search?: string;
  source?: string;
};

export type DiagnosticsNetworkCommandOptions = DiagnosticsPageOptions & {
  include?: BackendNetworkIncludeMode;
};

export type DiagnosticsPerfCommandOptions = CommandContext & {
  appId?: string;
  appBundleId?: string;
  since?: string;
  until?: string;
  sampleMs?: number;
  metrics?: readonly string[];
};

export type {
  DiagnosticsLogsCommandResult,
  DiagnosticsNetworkCommandResult,
  DiagnosticsPerfCommandResult,
} from './diagnostics-types.ts';

const LOG_LIMIT_DEFAULT = 100;
const LOG_LIMIT_MAX = 500;
const NETWORK_LIMIT_DEFAULT = 25;
const NETWORK_LIMIT_MAX = 200;
const PERF_SAMPLE_MIN_MS = 100;
const PERF_SAMPLE_MAX_MS = 60_000;
const PERF_METRICS_MAX = 20;

export const logsCommand: RuntimeCommand<
  DiagnosticsLogsCommandOptions | undefined,
  DiagnosticsLogsCommandResult
> = async (runtime, options = {}): Promise<DiagnosticsLogsCommandResult> => {
  if (!runtime.backend.readLogs) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'diagnostics.logs is not supported by this backend',
    );
  }
  const result = await runtime.backend.readLogs(
    await toDiagnosticsBackendContext(runtime, options),
    normalizeReadLogsOptions(options),
  );
  return formatLogsResult(result);
};

export const networkCommand: RuntimeCommand<
  DiagnosticsNetworkCommandOptions | undefined,
  DiagnosticsNetworkCommandResult
> = async (runtime, options = {}): Promise<DiagnosticsNetworkCommandResult> => {
  if (!runtime.backend.dumpNetwork) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'diagnostics.network is not supported by this backend',
    );
  }
  const normalizedOptions = normalizeDumpNetworkOptions(options);
  const result = await runtime.backend.dumpNetwork(
    await toDiagnosticsBackendContext(runtime, options),
    normalizedOptions,
  );
  return formatNetworkResult(result, normalizedOptions.include ?? 'summary');
};

export const perfCommand: RuntimeCommand<
  DiagnosticsPerfCommandOptions | undefined,
  DiagnosticsPerfCommandResult
> = async (runtime, options = {}): Promise<DiagnosticsPerfCommandResult> => {
  if (!runtime.backend.measurePerf) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'diagnostics.perf is not supported by this backend',
    );
  }
  const result = await runtime.backend.measurePerf(
    await toDiagnosticsBackendContext(runtime, options),
    normalizeMeasurePerfOptions(options),
  );
  return formatPerfResult(result);
};

// fallow-ignore-next-line complexity
async function toDiagnosticsBackendContext(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { appId?: string; appBundleId?: string },
): Promise<BackendCommandContext> {
  const context = toBackendContext(runtime, options);
  const session = options.session ? await runtime.sessions.get(options.session) : undefined;
  return {
    ...context,
    ...((options.appId ?? session?.appId) ? { appId: options.appId ?? session?.appId } : {}),
    ...((options.appBundleId ?? session?.appBundleId)
      ? { appBundleId: options.appBundleId ?? session?.appBundleId }
      : {}),
  };
}

function normalizeReadLogsOptions(options: DiagnosticsLogsCommandOptions): BackendReadLogsOptions {
  return {
    ...normalizePageOptions(options, LOG_LIMIT_DEFAULT, LOG_LIMIT_MAX, 'logs limit'),
    ...(options.levels !== undefined
      ? { levels: normalizeStringList(options.levels, 'levels') }
      : {}),
    ...(options.search !== undefined ? { search: requireText(options.search, 'search') } : {}),
    ...(options.source !== undefined ? { source: requireText(options.source, 'source') } : {}),
  };
}

function normalizeDumpNetworkOptions(
  options: DiagnosticsNetworkCommandOptions,
): BackendDumpNetworkOptions {
  return {
    ...normalizePageOptions(options, NETWORK_LIMIT_DEFAULT, NETWORK_LIMIT_MAX, 'network limit'),
    include: normalizeNetworkInclude(options.include),
  };
}

function normalizeMeasurePerfOptions(
  options: DiagnosticsPerfCommandOptions,
): BackendMeasurePerfOptions {
  return {
    ...normalizeTimeWindow(options),
    ...(options.sampleMs !== undefined
      ? {
          sampleMs: requireIntInRange(
            options.sampleMs,
            'sampleMs',
            PERF_SAMPLE_MIN_MS,
            PERF_SAMPLE_MAX_MS,
          ),
        }
      : {}),
    ...(options.metrics !== undefined
      ? { metrics: normalizeStringList(options.metrics, 'metrics', PERF_METRICS_MAX) }
      : {}),
  };
}

function normalizePageOptions(
  options: DiagnosticsPageOptions,
  defaultLimit: number,
  maxLimit: number,
  limitName: string,
): BackendDiagnosticsPageOptions {
  return {
    ...normalizeTimeWindow(options),
    ...(options.cursor !== undefined ? { cursor: requireText(options.cursor, 'cursor') } : {}),
    limit:
      options.limit === undefined
        ? defaultLimit
        : requireIntInRange(options.limit, limitName, 1, maxLimit),
  };
}

function normalizeTimeWindow(options: {
  since?: string;
  until?: string;
}): BackendDiagnosticsTimeWindow {
  return {
    ...(options.since !== undefined ? { since: requireText(options.since, 'since') } : {}),
    ...(options.until !== undefined ? { until: requireText(options.until, 'until') } : {}),
  };
}

function normalizeNetworkInclude(
  include: BackendNetworkIncludeMode | undefined,
): BackendNetworkIncludeMode {
  if (include === undefined) return 'summary';
  if (include === 'summary' || include === 'headers' || include === 'body' || include === 'all') {
    return include;
  }
  throw new AppError('INVALID_ARGS', 'network include must be summary, headers, body, or all');
}

function normalizeStringList(
  values: readonly string[],
  field: string,
  maxItems = 50,
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new AppError('INVALID_ARGS', `${field} must be an array of strings`);
  }
  if (values.length > maxItems) {
    throw new AppError('INVALID_ARGS', `${field} must contain at most ${maxItems} entries`);
  }
  return values.map((value, index) => requireText(value, `${field}[${index}]`));
}
