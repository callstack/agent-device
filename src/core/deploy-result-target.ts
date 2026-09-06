/**
 * The public app target a deployment result names, for the one message both the
 * daemon deployment handlers and the CLI/MCP serializers render ("Installed: <target>").
 * The precedence is the contract, so it sits below both callers rather than beside either.
 */

export function resolveDeployResultTarget(result: {
  app: string;
  bundleId?: string;
  package?: string;
}): string {
  return result.bundleId ?? result.package ?? result.app;
}

export function resolveInstallFromSourceResultTarget(result: {
  appName?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget: string;
}): string {
  return result.appName ?? result.bundleId ?? result.packageName ?? result.launchTarget;
}
