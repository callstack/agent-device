// Type surface for the plain-Node size-report module (it must stay runnable by bare `node`, so
// it is not in the typechecked program). TypeScript resolves this file when a checked module
// imports `./size-report-package.mjs`; keep it in step with the exports there.
export type NpmPackEntry = Readonly<{ path: string; size: number }>;
export function assertSnapshotBridgeAssets(presentPaths: Iterable<string>, context: string): void;
export function assertBundledLicenseNotices(
  entries: readonly NpmPackEntry[],
  options?: Readonly<{ noticesRoot?: string; context?: string }>,
): void;
export function assertPublishPackageContents(
  entries: readonly NpmPackEntry[],
  options?: Readonly<{
    noticesRoot?: string;
    repoRoot?: string;
    requireSnapshotBridge?: boolean;
  }>,
): void;

export function parseNpmPackOutput(stdout: string): Readonly<{
  filename: string;
  size: number;
  unpackedSize: number;
  files: readonly NpmPackEntry[];
}>;
