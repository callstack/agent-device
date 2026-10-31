import type { BoundOf, RuntimeCommand } from '../../runtime-types.ts';
import {
  logsCommand,
  networkCommand,
  perfCommand,
  type DiagnosticsLogsCommandOptions,
  type DiagnosticsLogsCommandResult,
  type DiagnosticsNetworkCommandOptions,
  type DiagnosticsNetworkCommandResult,
  type DiagnosticsPerfCommandOptions,
  type DiagnosticsPerfCommandResult,
} from './diagnostics.ts';

export type DiagnosticsCommands = {
  logs: RuntimeCommand<DiagnosticsLogsCommandOptions | undefined, DiagnosticsLogsCommandResult>;
  network: RuntimeCommand<
    DiagnosticsNetworkCommandOptions | undefined,
    DiagnosticsNetworkCommandResult
  >;
  perf: RuntimeCommand<DiagnosticsPerfCommandOptions | undefined, DiagnosticsPerfCommandResult>;
};

export type BoundObservabilityCommands = BoundOf<DiagnosticsCommands>;

export const diagnosticsCommands: DiagnosticsCommands = {
  logs: logsCommand,
  network: networkCommand,
  perf: perfCommand,
};
