/**
 * The tenant, run, and lease identity shared by public command options and the
 * companion tunnel in `@agent-device/react-native`.
 */
export type CompanionTunnelScope = {
  tenantId: string;
  runId: string;
  leaseId: string;
};

/** The companion-tunnel scope as Metro's bridge names it. */
export type MetroBridgeScope = CompanionTunnelScope;
