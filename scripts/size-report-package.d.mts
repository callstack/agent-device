// Type surface for the plain-Node size-report module (it must stay runnable by bare `node`, so
// it is not in the typechecked program). TypeScript resolves this file when a checked module
// imports `./size-report-package.mjs`; keep it in step with the exports there.
export function readMacosHelperTestTargets(manifestSource: string): string[];
export type NpmPackEntry = Readonly<{ path: string; size: number }>;
export function assertPublishPackageContents(
  entries: readonly NpmPackEntry[],
  options?: Readonly<{
    repoRoot?: string;
    requireSnapshotBridge?: boolean;
    macosHelperManifestSource?: string;
  }>,
): void;
