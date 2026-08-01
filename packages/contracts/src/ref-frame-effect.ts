// ADR 0014 ref-frame effect classification.
//
// A plain string union, and the only part of the daemon command descriptor that zones below the
// daemon actually need: `core/command-descriptor/registry.ts` classifies each command with it while
// composing the descriptor registry. Declaring it beside `DAEMON_ROUTE_HANDLERS` made core reach up
// four ranks for three string literals.
//
// The rest of the descriptor shape deliberately stays in the daemon: `DaemonCommandRoute` is
// `keyof typeof DAEMON_ROUTE_HANDLERS` and `DaemonRefFrameEffect` resolves against the daemon's own
// request type. Moving those down would mean re-declaring the route names in contracts and adding a
// gate to prove the handler map still covers them — more coupling to remove a dependency, which is
// the wrong trade. ADR 0003/0008 own that boundary.

/**
 * ADR 0014 session ref-frame lifetime. Declares how a daemon command relates to
 * the session's authorized ref frame:
 * - `preserve`: no successful path changes device-visible element identity, so
 *   the frame carries through untouched (snapshots, reads, inventory, ...);
 * - `may-invalidate`: some successful path crosses a device side effect, so the
 *   leaf must expire the frame at its side-effect seam when that path runs;
 * - `delegated`: an orchestrator (batch/replay/test) whose nested leaves own
 *   their own transitions — the outer command never expires a frame itself.
 *
 * This classification is an honesty/completeness guard, NOT the transition site:
 * a `may-invalidate` command still calls the ref-frame module only when its
 * mutating path is selected. The completeness gate
 * (`__tests__/ref-frame-effect.test.ts`) fails if a daemon-projected command
 * omits this classification.
 */
export type RefFrameEffect = 'preserve' | 'may-invalidate' | 'delegated';
