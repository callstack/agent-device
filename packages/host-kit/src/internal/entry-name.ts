import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { hostPathRules, resolveHomeDirectory, resolveUserPath } from './path-resolution.ts';
import { SCRIPT_ANCESTRY_REASONS, scriptAncestryFailure } from './script-destination-refusal.ts';

/**
 * The name a spelled script destination's entry is created under, or a refusal when its last segment names
 * none. Both the preflight that expands a caller's spelling and the publication itself ask this one helper,
 * before anything touches the filesystem (ADR 0016).
 */
export function scriptEntryNameOrRefuse(spelled: string): string {
  const rules = hostPathRules();
  if (rules === path.win32 && /^[\\/]|^[a-z]:/i.test(spelled)) {
    requireWindowsScriptVolume(spelled, spelled);
  }
  return entryNameOrRefuse(spelled, rules);
}

export function entryNameOrRefuse(spelled: string, rules: path.PlatformPath): string {
  const name = scriptEntryName(spelled, rules);
  if (name === undefined) throw unnamedEntryFailure(spelled, rules);
  return name;
}

/** Returns the drive or complete ordinary UNC root of a Windows script path. */
export function requireWindowsScriptVolume(spelled: string, candidate: string): string {
  const drive = /^[a-z]:[\\/]/i.test(candidate);
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(candidate);
  if (
    drive ||
    (unc &&
      unc.slice(1).every((part) => !/[:?*<>"|]|[. ]$/.test(part) && !hasControlCharacter(part)))
  ) {
    return path.win32.parse(path.win32.normalize(candidate)).root;
  }
  throw new AppError(
    'INVALID_ARGS',
    `Refusing to save the script at ${spelled}: ${candidate} lacks a supported Windows volume.`,
    {
      reason: 'script_ancestor_untrusted',
      exposure: 'windows_path_form',
      path: spelled,
      ancestor: candidate,
      hint: 'Use an absolute drive-letter path or an ordinary Windows network share path.',
    },
  );
}

/**
 * The refusal for a spelling {@link scriptEntryName} names no entry for. A Windows directory holding a `:` is
 * the PATH's fault, not its last name's, so that refusal names the directory and says what to change there.
 */
export function unnamedEntryFailure(spelled: string, rules: path.PlatformPath): AppError {
  const parent = rules.dirname(spelled);
  if (rules.sep === '\\' && holdsColonAfterRoot(rules.normalize(parent), rules)) {
    return new AppError(
      'INVALID_ARGS',
      `Refusing to save the script under ${parent}: a Windows path cannot hold \`:\` after its drive, and a directory in it does.`,
      {
        reason: SCRIPT_ANCESTRY_REASONS[0],
        exposure: 'unnamed_entry',
        path: spelled,
        ancestor: parent,
        hint: 'Remove the `:` from the directory names in the script path.',
      },
    );
  }
  return scriptAncestryFailure(spelled, parent, 'unnamed_entry');
}

/** Whether a name holds a character below U+0020, which Windows refuses in a file name. */
function hasControlCharacter(name: string): boolean {
  return [...name].some((character) => character.charCodeAt(0) < 0x20);
}

/** Whether a Windows path holds a `:` past its root, where only a stream separator would put one. */
function holdsColonAfterRoot(normalized: string, rules: path.PlatformPath): boolean {
  return normalized.slice(rules.parse(normalized).root.length).includes(':');
}

/**
 * The one entry a script destination's spelling names under `rules`, or `undefined` when its last segment
 * names none: empty, a root, `.`, `..`, a spelling holding a NUL, or the bare `~` a home expansion turns
 * into a directory. A trailing separator names the same entry it always has. The split is root-aware: a
 * basename would turn the share of a bare UNC root into a file name.
 */
export function scriptEntryName(spelled: string, rules: path.PlatformPath): string | undefined {
  // A lone surrogate is written as U+FFFD, so the file created would be another name than the one judged.
  const bareHome = rules.sep === '\\' ? /^~[\\/]*$/ : /^~\/*$/;
  if (spelled.includes('\0') || /\p{Surrogate}/u.test(spelled) || bareHome.test(spelled)) {
    return undefined;
  }
  // The raw last segment first: a normalization folds a final `.` or `..` away.
  const { base } = rules.parse(spelled);
  if (base === '' || base === '.' || base === '..' || exceedsNameMax(base, rules)) return undefined;
  return rules.sep === '\\' ? windowsEntryName(rules.normalize(spelled), rules) : base;
}

/**
 * Whether a name is longer than one directory entry can hold: 255 UTF-8 bytes on the common POSIX filesystems,
 * 255 UTF-16 units on NTFS. Refused before anything is created, instead of failing after its parent was made.
 */
function exceedsNameMax(name: string, rules: path.PlatformPath): boolean {
  return (rules.sep === '\\' ? name.length : Buffer.byteLength(name)) > NAME_MAX;
}

const NAME_MAX = 255;

/**
 * The Windows answer, read from the spelling as the publisher's own joins normalize it, so a doubled separator
 * cannot hide a root. A device-namespace path, an extended UNC root that `parse` reads as names, a reserved
 * device name, and a stream after a `:` all name something other than one file.
 */
function windowsEntryName(normalized: string, rules: path.PlatformPath): string | undefined {
  // The device namespace, and an extended prefix that names anything but a drive or a UNC share.
  if (/^\\\\\.\\/.test(normalized)) return undefined;
  if (/^\\\\\?\\/.test(normalized) && !/^\\\\\?\\(?:[A-Z]:\\|UNC\\)/i.test(normalized))
    return undefined;
  if (/^\\\\\?\\UNC(?:\\[^\\]+){0,2}\\?$/i.test(normalized)) return undefined;
  // An IPC share, ordinary or extended, opens a named pipe or a mailslot, not a file: `pipe`, `IPC$` (the SMB
  // named-pipe share) and `mailslot`. The same names below an ordinary share are ordinary directories.
  if (/^\\\\(?:\?\\UNC\\)?[^\\]+\\(?:pipe|IPC\$|mailslot)(?:\\|$)/i.test(normalized)) {
    return undefined;
  }
  const { base } = rules.parse(normalized);
  if (base === '' || holdsColonAfterRoot(normalized, rules)) return undefined;
  // Microsoft's naming rules: no reserved character or control character, no trailing dot or space, and no
  // reserved device name, with or without an extension.
  if (/[<>:"/\\|?*]/.test(base) || hasControlCharacter(base) || /[. ]$/.test(base))
    return undefined;
  // Only ASCII spaces fall away before the comparison; a no-break space is part of the name.
  const stem = base.split('.')[0]?.replace(/ +$/, '') ?? '';
  return /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i.test(stem)
    ? undefined
    : base;
}

/**
 * Expands a script destination a caller spelled into the absolute path host-kit judges, refusing a spelling
 * whose last segment names no entry BEFORE the expansion normalizes it away: `./missing/.` would otherwise
 * become `<cwd>/missing`, and the publish would create a file under the directory's name.
 */
export function resolveScriptDestination(
  spelled: string,
  options: Readonly<{ cwd: string; env?: EnvMap }>,
): string {
  const rules = hostPathRules();
  scriptEntryNameOrRefuse(spelled);
  if (rules !== path.win32) {
    const resolved = resolveUserPath(spelled, options);
    scriptEntryNameOrRefuse(resolved);
    return stripTrailingScriptSeparators(resolved, rules.sep);
  }

  let expanded = spelled;
  if (spelled.startsWith('~/')) {
    const home = resolveHomeDirectory(options.env);
    if (rules.isAbsolute(home) || /^[a-z]:/i.test(home)) requireWindowsScriptVolume(spelled, home);
    expanded = rules.join(home, spelled.slice(2));
    scriptEntryNameOrRefuse(expanded);
  }
  if (rules.isAbsolute(expanded)) return stripTrailingScriptSeparators(expanded, rules.sep);

  requireWindowsScriptVolume(spelled, options.cwd);
  const resolved = rules.resolve(options.cwd, expanded);
  scriptEntryNameOrRefuse(resolved);
  return resolved;
}

function stripTrailingScriptSeparators(destination: string, separator: string): string {
  let end = destination.length;
  while (destination[end - 1] === '/' || destination[end - 1] === separator) end -= 1;
  return destination.slice(0, end);
}
