import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';

type PathResolutionOptions = {
  cwd?: string;
  env?: EnvMap;
};

function resolveHomeDirectory(env?: EnvMap): string {
  return env?.HOME?.trim() || os.homedir();
}

export function expandUserHomePath(inputPath: string, options: PathResolutionOptions = {}): string {
  if (inputPath === '~') return resolveHomeDirectory(options.env);
  if (inputPath.startsWith('~/')) {
    return path.join(resolveHomeDirectory(options.env), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveUserPath(
  inputPath: string,
  options: PathResolutionOptions & { cwd: string },
): string {
  const expandedPath = expandUserHomePath(inputPath, options);
  if (path.isAbsolute(expandedPath)) return expandedPath;
  return path.resolve(options.cwd, expandedPath);
}

/**
 * The user's `config.json`, from `AGENT_DEVICE_HOME` or `~/.agent-device`.
 *
 * This lives beside the other expansions rather than in the CLI's config loader because it is the
 * same question those two answer — a location named by the environment becomes an absolute path —
 * and it answers it with nothing but `env`: no option schema, no flag grammar, no command facet.
 * Plugin discovery needs the answer at daemon start and must not acquire the CLI's schema layer to
 * get it (`packages/plugins/src/store.ts`), which is a 153-file zone rather than a path helper.
 */
export function resolveUserConfigPath(env: EnvMap): string {
  const home = env.AGENT_DEVICE_HOME
    ? expandUserHomePath(env.AGENT_DEVICE_HOME, { env })
    : path.join(expandUserHomePath('~', { env }), '.agent-device');
  if (!path.isAbsolute(home))
    throw new AppError('INVALID_ARGS', 'AGENT_DEVICE_HOME must be absolute or ~/...');
  return path.join(home, 'config.json');
}

/**
 * `directory` with its trailing separators cut off, which is the name an entry is actually looked up under.
 *
 * A trailing separator is not cosmetic to the kernel: `state/` is resolved THROUGH a symbolic link standing at
 * `state`, so an `lstat`, an `O_DIRECTORY | O_NOFOLLOW` open, and an `fchmod` given that name all land on the
 * far side. A caller that judges or changes an entry therefore asks about it under this spelling.
 *
 * The scan is an index walk from the end, not a regular expression, so its cost is the length of the run it
 * cuts and nothing else — no repetition in the input can make it reconsider an earlier prefix. Only this
 * platform's separator is cut: a `\` is an ordinary name character on a POSIX host, where a directory may
 * legitimately end with one, while Windows spells paths with both separators and cuts both.
 *
 * A root keeps one separator. `//` cut to the empty string would name no directory at all, and `C:\` cut to
 * `C:` names a drive-relative path that resolves against that drive's working directory.
 */
export function withoutTrailingSeparators(directory: string): string {
  const separator = path.sep;
  let end = directory.length;
  while (end > 0 && (directory[end - 1] === '/' || directory[end - 1] === separator)) end -= 1;
  return end === 0 && directory.length > 0 ? directory.slice(0, 1) : directory.slice(0, end);
}

/**
 * The name `name` occupies inside `directory`, spelled so it stays WHERE `directory` is.
 *
 * Deliberately NOT `path.join`, which normalizes: `join('/r/alias/../state', 'sessions')` answers
 * `/r/state/sessions`, while the kernel creates and reads that name under `/r/actual/state/sessions` — the
 * `..` steps back out of wherever the alias physically stands. Two spellings of "the same" child are worse
 * than wrong here: a repair that resolves one of them judges a directory the writer never writes into, and
 * creates and forces the mode of that one while recordings go somewhere else. Anything derived from a
 * caller-supplied state directory is appended this way; a name from {@link verifiedDirectoryPath} or
 * {@link childPath} itself needs no such care, because a physical answer has no step left to fold.
 */
export function childPath(directory: string, ...names: readonly string[]): string {
  let spelled = withoutTrailingSeparators(directory);
  for (const name of names) {
    if (spelled === '') {
      spelled = name;
      continue;
    }
    const separated = spelled.endsWith('/') || spelled.endsWith(path.sep);
    spelled = separated ? `${spelled}${name}` : `${spelled}${path.sep}${name}`;
  }
  return spelled;
}

/**
 * The directory `directory` stands IN, or `undefined` when its name has no directory above it.
 *
 * This is the cut {@link verifiedDirectoryPath} resolves against: the last separator of the spelling, with
 * nothing else about it normalized. A `..` that survives this cut is a step the kernel will take, and a caller
 * that reached for `path.dirname` would be shown a different directory than the one resolution arrives at. The
 * separator is the one paths are walked with, matching {@link withoutTrailingSeparators}.
 */
export function parentDirectoryPath(directory: string): string | undefined {
  const spelled = withoutTrailingSeparators(directory);
  const cut = spelled.lastIndexOf('/');
  if (cut < 0) return undefined;
  return cut === 0 ? '/' : spelled.slice(0, cut);
}

export function resolveDeviceClaimRoot(env: EnvMap): string {
  const override = env.AGENT_DEVICE_CLAIMS_DIR?.trim();
  if (!override) return path.join(os.homedir(), '.agent-device', 'device-claims');
  // The store is shared by every daemon on the host, so a directory that depends on where one of
  // them happened to start is not a place they can agree on.
  if (!path.isAbsolute(override)) {
    throw new AppError(
      'INVALID_ARGS',
      `AGENT_DEVICE_CLAIMS_DIR must be an absolute path: ${override}`,
      {
        reason: 'relative_claims_dir',
      },
    );
  }
  return path.resolve(override);
}
