// The shared refusal shape for selector-command argument checks.
//
// `commands/` (the client surface) and `daemon/` (the executor) both validate the same
// command arguments, and R2 (commands-floor) forbids the daemon from importing the command
// surface — so the only place a rule can be stated once is below both, here. Each caller
// still chooses how to SURFACE a refusal: the daemon returns it as a `DaemonResponse`,
// the command surface throws an `AppError`. Those two mechanisms are not interchangeable
// (they write different session events), so the shared check reports the refusal and
// stays out of the decision.

export type SelectorArgumentRefusal = {
  ok: false;
  code: 'INVALID_ARGS';
  message: string;
  /** ADR 0010: shared failure modes get a shared hint, not a copy-pasted string. */
  hint?: string;
};

export function refuse(message: string, hint?: string): SelectorArgumentRefusal {
  return { ok: false, code: 'INVALID_ARGS', message, ...(hint ? { hint } : {}) };
}
