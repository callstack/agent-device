// The public API vocabulary for session lifecycle and script publication.

import type { CloudProviderSessionResult } from './cloud-artifacts.ts';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';
import type { AgentDeviceIdentifiers, AgentDeviceRequestOverrides } from './client-connection.ts';
import type { ScriptDeliveryFailure } from '@agent-device/kernel/contracts';

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
  /** ADR 0016 (#4564): the close's response warnings, kept so a lost final script is read, not skipped. */
  warnings?: string[];
  /**
   * ADR 0016 (#4564): the final script of a remote recording was not delivered. The close kept its
   * success, so this is the only channel that says the caller file still holds an older version.
   */
  scriptDeliveryFailure?: ScriptDeliveryFailure;
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
