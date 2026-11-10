// Type surface for the plain-Node clean-install measurement (it must stay runnable by bare
// `node`). Keep it in step with the exports of `./size-report-install.mjs`.
export type DirectoryMeasurement = { packageBytes: number; files: number };

export function measureCleanInstalledPackage(
  tarballPath: string,
  packageName: string,
): DirectoryMeasurement & { totalBytes: number };

export function assertInstalledSnapshotBridge(packageDir: string): void;

export function measureDirectory(root: string): DirectoryMeasurement;
