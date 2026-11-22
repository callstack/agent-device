import path from 'node:path';

/** The shipped AT-SPI2 helper's file name, which the manifest packages under `linux/`. */
export const LINUX_ATSPI_SCRIPT_NAME = 'atspi-dump.py';

/**
 * Resolves the AT-SPI2 helper shipped with this package: answers its path, or `undefined` when the
 * install does not carry it.
 *
 * The location is derived next to the code that runs it rather than against the process working
 * directory or a repository layout: from the source tree that is `<package>/linux`, and from an
 * installed package it is `<package>/linux` beside `dist`, because the manifest ships that directory
 * with the bundle. Whether that file is really there is asked through `probe`, so the read belongs to
 * the host that runs the helper rather than to this bundle (ADR 0019). The probe runs once: the first
 * capture of one `setup` pays it.
 */
export function createLinuxAtspiScriptResolver(
  probe: (candidate: string) => Promise<boolean>,
): () => Promise<string | undefined> {
  const candidate = path.join(path.dirname(import.meta.dirname), 'linux', LINUX_ATSPI_SCRIPT_NAME);
  let resolved: Promise<string | undefined> | undefined;
  return () => (resolved ??= probe(candidate).then((present) => (present ? candidate : undefined)));
}
