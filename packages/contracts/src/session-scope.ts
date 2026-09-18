/**
 * The isolation scope a session was opened under. Resolved by the daemon from the request's
 * tenant/cwd/session metadata; read wherever a request must be matched to the sessions it may see.
 */
export type SessionScope =
  | { kind: 'cwd'; id: string }
  | { kind: 'tenant'; id: string }
  | { kind: 'named-local' }
  | { kind: 'global-default' };
