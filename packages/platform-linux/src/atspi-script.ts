import path from 'node:path';

/** The shipped AT-SPI2 helper's file name, which the manifest packages under `linux/`. */
export const LINUX_ATSPI_SCRIPT_NAME = 'atspi-dump.py';

/**
 * Resolves the AT-SPI2 helper shipped with this package: answers the probed path and whether the
 * install carries it.
 *
 * The location is derived next to the code that runs it rather than against the process working
 * directory or a repository layout: from the source tree that is `<package>/linux`, and from an
 * installed package it is `<package>/linux` beside `dist`, because the manifest ships that directory
 * with the bundle. Whether that file is really there is asked through `probe`, so the read belongs to
 * the host that runs the helper rather than to this bundle (ADR 0019). An answered probe is kept for
 * the `setup`; a rejected probe is not, so the next capture asks again.
 */
export function createLinuxAtspiScriptResolver(
  probe: (candidate: string) => Promise<boolean>,
): () => Promise<{ path: string; present: boolean }> {
  const candidate = path.join(path.dirname(import.meta.dirname), 'linux', LINUX_ATSPI_SCRIPT_NAME);
  let resolved: Promise<{ path: string; present: boolean }> | undefined;
  return () => {
    resolved ??= probe(candidate).then(
      (present) => ({ path: candidate, present }),
      (error: unknown) => {
        resolved = undefined;
        throw error;
      },
    );
    return resolved;
  };
}
