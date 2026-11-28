type WorkspacePackage = Readonly<{
  directory: string;
  manifest: Readonly<{ name: string } & Record<string, unknown>>;
}>;

type PluginPlanEntry = Readonly<{ directory: string; name: string }>;

export function planPluginSizes(
  base: readonly WorkspacePackage[],
  head: readonly WorkspacePackage[],
  files: readonly string[],
  lockfiles?: { base: Record<string, unknown>; head: Record<string, unknown> },
): { base: PluginPlanEntry[]; head: PluginPlanEntry[] };
