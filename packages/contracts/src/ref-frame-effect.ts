// ADR 0014 ref-frame effect classification. A plain string union so
// `core/command-descriptor/` can classify commands without importing the daemon.

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
