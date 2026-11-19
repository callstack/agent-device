/**
 * The rule that keeps extracted platform families out of the packed core, in one owner:
 * scripts/check-package.ts applies it to the `npm pack` file list and the bundled dist, and its
 * failure-direction tests live in scripts/__tests__/packed-core-absence.test.ts.
 *
 * ADR 0034 moves the optional platform families (web, HarmonyOS, Vega, Linux desktop) out of the
 * core package into `platform` plugins. Once a family is extracted, its paths and its module
 * markers must not reappear in the tarball the core publishes: a leftover `dist/` file or a
 * bundled import of `@agent-device/platform-<family>` would ship the extracted engine inside the
 * core again. The declared list in scripts/check-package.ts starts empty; each extraction PR adds
 * one line, and this module turns the list plus the packed evidence into human-readable
 * violations that name the offending path.
 */

/**
 * The declared absence list for the packed core tarball.
 *
 * - `paths`: package-relative file paths that must not appear in the `npm pack` file list.
 * - `moduleMarkers`: bare module specifiers that must not appear in any bundled dist file's
 *   contents (an import, a require, or a bundled string that still names the extracted package).
 */
export type PackedCoreForbidden = Readonly<{
  paths: readonly string[];
  moduleMarkers: readonly string[];
}>;

/** The packed evidence: the `npm pack` file list and the bundled dist files with their contents. */
export type PackedCoreAbsenceInput = Readonly<{
  /** Package-relative paths exactly as `npm pack --json` declares them. */
  packedPaths: readonly string[];
  /** Bundled `dist/` files the tarball carries, with the bytes it carries. */
  distFiles: readonly PackedCoreFile[];
}>;

/** One bundled dist file: the package-relative path and the contents the tarball carries. */
export type PackedCoreFile = {
  readonly path: string;
  readonly contents: string;
};

/**
 * Every violation of the absence list, each naming the offending packed path. An empty result
 * means the packed core carries none of the forbidden paths or module markers.
 */
export function packedCoreAbsenceFailures(
  forbidden: PackedCoreForbidden,
  input: PackedCoreAbsenceInput,
): string[] {
  const failures: string[] = [];
  for (const forbiddenPath of forbidden.paths) {
    if (input.packedPaths.includes(forbiddenPath)) {
      failures.push(`${forbiddenPath} (forbidden packed path)`);
    }
  }
  for (const marker of forbidden.moduleMarkers) {
    for (const file of input.distFiles) {
      if (file.contents.includes(marker)) {
        failures.push(`${file.path} (forbidden module marker ${marker})`);
      }
    }
  }
  return failures;
}
