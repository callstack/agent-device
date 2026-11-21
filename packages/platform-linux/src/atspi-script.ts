import path from 'node:path';
import { hostFileExistsSync } from '@agent-device/host-kit/host-file';
import { AppError } from '@agent-device/kernel/errors';

const SCRIPT_NAME = 'atspi-dump.py';

/**
 * The AT-SPI2 helper, shipped with this package under `linux/`.
 *
 * It is resolved next to the code that runs it rather than against the process working directory or
 * a repository layout: from the source tree that is `<package>/linux`, and from an installed package
 * it is `<package>/linux` beside `dist`, because the manifest ships that directory with the bundle.
 * The name is resolved once per process; the first capture of a process pays the probe.
 */
let cachedScriptPath: string | undefined;

export function resolveLinuxAtspiScriptPath(): string {
  if (cachedScriptPath) return cachedScriptPath;
  const candidate = path.join(path.dirname(import.meta.dirname), 'linux', SCRIPT_NAME);
  if (!hostFileExistsSync(candidate)) {
    throw new AppError(
      'TOOL_MISSING',
      `Cannot find ${SCRIPT_NAME}. Ensure the @agent-device/linux plugin package is installed correctly.`,
      { path: candidate },
    );
  }
  cachedScriptPath = candidate;
  return candidate;
}
