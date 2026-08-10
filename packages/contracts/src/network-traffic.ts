import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { LogBackend } from './logs.ts';
import type { NetworkEntry } from './network-log.ts';

export type NetworkDumpParserOptions = Readonly<{
  path: string;
  exists: boolean;
  backend?: LogBackend;
  maxEntries?: number;
  include?: NetworkIncludeMode;
  maxPayloadChars?: number;
  maxScanLines?: number;
  /** Absolute source-line offset for host-selected text windows. */
  lineNumberOffset?: number;
}>;

export type NetworkDump = Readonly<{
  path: string;
  exists: boolean;
  scannedLines: number;
  matchedLines: number;
  entries: readonly NetworkEntry[];
  include: NonNullable<NetworkDumpParserOptions['include']>;
  limits: Readonly<{ maxEntries: number; maxPayloadChars: number; maxScanLines: number }>;
}>;
