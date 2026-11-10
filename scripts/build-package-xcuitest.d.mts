// Type surface for the plain-Node package runner build (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./build-package-xcuitest.mjs`.
export type PackageXcuitestBuild = { root: string; platform: string; derivedPath: string };

export function buildPackageXcuitest(
  options?: Readonly<{
    root?: string;
    platforms?: readonly string[];
    build?: (build: PackageXcuitestBuild) => void;
  }>,
): void;
