import type { ReplayControlActionSource, SessionAction } from '../../daemon/types.ts';
import type { ParsedReplayScript, ReplayScriptMetadata } from '../../replay/script.ts';

export type MaestroFlowConfig = {
  name?: string;
  appId?: string;
  env?: Record<string, string>;
  onFlowStart?: MaestroCommand[];
  onFlowComplete?: MaestroCommand[];
};

export type MaestroReplayFlow = ParsedReplayScript & {
  metadata: ReplayScriptMetadata;
};

/**
 * The Maestro conversion pipeline's uniform result: actions plus a parallel
 * per-action source array (`undefined` = the file currently being parsed;
 * concrete `{path, line}` = a `runFlow` include's own file).
 */
export type MaestroConvertedActions = {
  actions: SessionAction[];
  sources: (ReplayControlActionSource | undefined)[];
};

export type MaestroCommand = string | Record<string, unknown>;

export type MaestroParseOptions = {
  sourcePath?: string;
  platform?: string;
  env?: Record<string, string>;
  visitedPaths?: Set<string>;
};

export type MaestroParseContext = {
  baseDir?: string;
  platform?: 'android' | 'ios';
  env: Record<string, string>;
  envOverrides: Record<string, string>;
  visitedPaths: Set<string>;
};

export type MaestroCommandMapperDeps = {
  parseRunFlowFile(filePath: string, context: MaestroParseContext): MaestroReplayFlow;
};
