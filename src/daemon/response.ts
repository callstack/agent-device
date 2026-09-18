/**
 * Daemon-local alias for the failure constructors, which live in
 * `@agent-device/kernel/contracts` beside the `DaemonResponse` shape they build. Handlers keep
 * importing them from here; a command-side port imports the owning specifier directly, which is
 * why the implementation cannot stay in this file.
 */
export {
  errorResponse,
  noActiveSessionError,
  NO_ACTIVE_SESSION_MESSAGE,
  type DaemonFailureResponse,
} from '@agent-device/kernel/contracts';
