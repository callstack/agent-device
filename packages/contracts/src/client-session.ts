// The public API vocabulary for session lifecycle and script publication.

import type { CloudProviderSessionResult } from './cloud-artifacts.ts';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';
import type { AgentDeviceIdentifiers, AgentDeviceRequestOverrides } from './client-connection.ts';

export type SessionCloseResult = {
  session: string;
  shutdown?: TargetShutdownResult;
  provider?: CloudProviderSessionResult;
  /**
   * #1258: absolute path of the committed session/healed script when this close
   * published one (`close --save-script`, or a repair-armed session's finalize)
   * — so a client that requested publication learns where the file landed.
   */
  savedScript?: string;
  identifiers: AgentDeviceIdentifiers;
};

export type SessionSaveScriptOptions = AgentDeviceRequestOverrides & {
  path?: string;
  /** Atomically replace an existing target instead of refusing publication. */
  force?: boolean;
};

export type SessionSaveScriptResult = {
  session: string;
  savedScript: string;
  actionCount: number;
  identifiers: AgentDeviceIdentifiers;
};
