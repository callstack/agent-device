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
  /**
   * Identities of requests the reader observed but could not name at all, so
   * they are absent from `entries`: an empty dump with a non-empty list is a
   * failed capture, not evidence that nothing was requested. Identities rather
   * than a count, so two scan windows over overlapping traffic reconcile to the
   * requests actually seen instead of double-counting or under-reporting them.
   */
  unnamedRequestIds?: readonly string[];
  include: NonNullable<NetworkDumpParserOptions['include']>;
  limits: Readonly<{ maxEntries: number; maxPayloadChars: number; maxScanLines: number }>;
}>;
