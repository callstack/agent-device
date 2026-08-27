import type { DispatchedCommand } from '@agent-device/contracts/command';
import type { RefFrameEffect } from '@agent-device/contracts/replay';

export type SessionCommandKind = 'inventory' | 'state' | 'observability' | 'publication' | 'replay';

/**
 * Routes a daemon command to its handler family. The handler table in
 * `request-handler-chain.ts` must cover every member (`satisfies Record<…>`).
 */
export type DaemonCommandRoute =
  | 'lease'
  | 'session'
  | 'snapshot'
  | 'reactNative'
  | 'recordTrace'
  | 'find'
  | 'interaction'
  | 'generic';

export type DaemonRefFrameEffect<TRequest = DispatchedCommand> =
  | RefFrameEffect
  | ((req: TRequest) => RefFrameEffect);

/**
 * Daemon route + request-policy traits for one command. Generic over the request
 * the closure traits read so core can declare the shape in terms of
 * `DispatchedCommand` without importing the server-private `DaemonRequest`.
 */
export type DaemonCommandDescriptor<TRequest = DispatchedCommand> = {
  command: string;
  route: DaemonCommandRoute;
  sessionKind?: SessionCommandKind;
  refFrameEffect?: DaemonRefFrameEffect<TRequest>;
  leaseAdmissionExempt?: boolean;
  sessionExecutionLockExempt?: boolean;
  selectorValidationExempt?: boolean;
  replayScopedAction?: boolean;
  allowInvalidRecording?: boolean;
  /**
   * #1478: this command's REQUEST may carry `flags.saveScript` to arm session
   * script publication. Only the released flag owners (`open`, `close`,
   * `replay` — the commands whose CLI grammar declares `--save-script`) set
   * this; every other command's raw request is rejected at the daemon request
   * seam by `unsupportedSaveScriptFlagResponse`, so a recordable command such
   * as `record` or `trace` cannot arm publication over the wire.
   */
  saveScriptFlagOwner?: boolean;
  lockPolicySelectorOverride?: boolean;
  androidBlockingDialogGuard?: boolean;
  preferExplicitDeviceOverExistingSession?: boolean;
  allowSessionlessDefaultDevice?: (req: TRequest) => boolean;
  skipSessionlessProviderDevice?: (req: TRequest) => boolean;
  /**
   * #2016: this request shape is eligible for the sessionless,
   * no-lease-anywhere lease-admission bypass — a session that was never
   * created (deferred `connect`, `open` never ran) has no lease to admit or
   * release. Only `close` declares it, and only for the plain-close shape
   * (no app-target positional): `close <app>` resolves its device straight
   * from flags when there's no session, so it must stay behind full
   * lease/tenant admission. Declared here so `request-admission.ts` asks the
   * registry instead of reclassifying `req.command`/`req.positionals` itself.
   */
  sessionlessPlainCloseAdmissionExempt?: (req: TRequest) => boolean;
};
