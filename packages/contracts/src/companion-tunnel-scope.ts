/**
 * The identity a companion tunnel is scoped to.
 *
 * This shape is shared vocabulary rather than a client concern: the public API surface declares
 * command options in terms of it, and `client/`, `metro/` and `cli/` all pass it around. It lived
 * inside `client/client-companion-tunnel-contract.ts` next to the env-var names and worker
 * options that really are client-local, which made every zone that merely needed the shape
 * declare itself in terms of the client. Declaring it below them is what lets the contract be
 * shared without the dependency.
 */
export type CompanionTunnelScope = {
  tenantId: string;
  runId: string;
  leaseId: string;
};

/** The companion-tunnel scope as Metro's bridge names it. */
export type MetroBridgeScope = CompanionTunnelScope;
