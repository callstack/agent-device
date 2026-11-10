// Type surface for the plain-Node notices format module; keep it in step with its exports.
export type NoticeDependency = Readonly<{
  name: string;
  version: string;
  license: string;
  author?: string;
  texts: readonly string[];
}>;
export function renderLicenseNotices(dependencies: readonly NoticeDependency[]): string;
export function readLicenseNotices(contents: string): Readonly<{
  attributions: readonly Readonly<{ label: string; references: readonly number[] }>[];
  licenseTextIds: ReadonlySet<number>;
}>;
