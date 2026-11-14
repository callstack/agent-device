// Type surface for the plain-Node release version helpers (they must stay runnable by bare
// `node`). Keep it in step with the exports of `./release-version.mjs`.
export function isReleaseVersion(version: string): boolean;

export function compareReleaseVersions(left: string, right: string): number;

export function nightlyVersion(
  developmentVersion: string,
  date: string,
  runNumber: string | number,
  sourceBranch?: 'main' | '0.22',
): string;

export function nightlyBase(version: string): string;

export function nightlyDate(version: string, sourceBranch?: 'main' | '0.22'): string | null;

export function latestNightlyTag(
  tags: readonly string[],
  sourceBranch?: 'main' | '0.22',
): string | null;

export function previousReleaseTag(tags: readonly string[], version: string): string | null;

export function nextDevelopmentVersion(mainVersion: string, released: string): string;
