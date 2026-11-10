// Type surface for the plain-Node package runner build (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./build-package-xcuitest.mjs`.
/** The platforms `scripts/build-xcuitest-apple.sh` builds; it rejects any other value. */
export type PackageXcuitestPlatform = 'ios' | 'macos' | 'tvos' | 'visionos';

export type PackageXcuitestBuild = {
  root: string;
  platform: PackageXcuitestPlatform;
  derivedPath: string;
};

export function buildPackageXcuitest(
  options?: Readonly<{
    root?: string;
    platforms?: readonly PackageXcuitestPlatform[];
    build?: (build: PackageXcuitestBuild) => void;
  }>,
): void;
