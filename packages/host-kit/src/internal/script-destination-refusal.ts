import { AppError } from '@agent-device/kernel/errors';

/** The ways a step can be unsafe; `untrustedGroundWording` words each one for the caller. */
export type ScriptAncestryExposure =
  | 'foreign_owned'
  | 'not_private'
  | 'world_writable'
  | 'shared_group_writable'
  | 'shared_parent'
  | 'planted_link'
  | 'link_loop_exceeded'
  | 'not_a_directory'
  | 'entry_appeared'
  | 'relative_destination'
  | 'unnamed_entry'
  | 'unresolvable_parent'
  | 'unreachable_parent';

/** Why each exposure makes that ground unsafe, in the caller's terms. */
const untrustedGroundWording: Record<ScriptAncestryExposure, string> = {
  foreign_owned: 'another local user owns that part of the path.',
  not_private: 'its group or other permission bits let other accounts read it.',
  world_writable: 'any local user can write that part of the path.',
  shared_group_writable:
    'the group can write that part of the path, and agent-device cannot tell who else belongs to that group.',
  shared_parent: 'another local user could create the script file there first.',
  planted_link: 'another local user could have put that symbolic link there, or could replace it.',
  link_loop_exceeded:
    'that part of the path follows more symbolic links than the system allows, so where the script would land is not established.',
  not_a_directory: 'a directory was expected there, and something else stands in the way.',
  entry_appeared:
    'a directory the script path needs was missing when the path was checked and appeared before this save could create it.',
  unnamed_entry:
    'the script path has to end in one file name of at most 255 bytes, not `.`, `..`, `~`, a root, or nothing at all, and it cannot hold a NUL.',
  relative_destination:
    'the script path has to be absolute, so the directories it names are the ones that get checked.',
  unresolvable_parent:
    'the script path names a directory that does not exist and steps back out of it with `..`, so where the script would land is not established.',
  unreachable_parent:
    'the directory the script path names does not exist, so the script has nowhere to be written.',
};

/**
 * The typed reasons a destination-ancestry refusal answers with, named here rather than spelled again by
 * whoever reads them.
 */
export const SCRIPT_ANCESTRY_REASONS = ['script_ancestor_untrusted'] as const;

/** A reason this rule answers with, or `undefined` for an error that came from somewhere else. */
export function scriptAncestryReason(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  const reason = error.details?.reason;
  return typeof reason === 'string' &&
    (SCRIPT_ANCESTRY_REASONS as readonly string[]).includes(reason)
    ? reason
    : undefined;
}

export function scriptAncestryFailure(
  destination: string,
  ancestor: string,
  exposure: ScriptAncestryExposure,
  /** Whether the judgment found `ancestor` owned by the caller, who can then change its mode. */
  callerOwnsAncestor = false,
): AppError {
  // A path that names no file is the caller's input to correct; every other refusal is about the ground.
  return new AppError(
    exposure === 'unnamed_entry' ? 'INVALID_ARGS' : 'COMMAND_FAILED',
    `Refusing to save the script under ${ancestor}: ${untrustedGroundWording[exposure]}`,
    {
      reason: SCRIPT_ANCESTRY_REASONS[0],
      exposure,
      path: destination,
      ancestor,
      hint: ancestryHint(exposure, ancestor, callerOwnsAncestor),
    },
  );
}

/** What to do about it. A group-writable directory the caller owns is the one refusal they can fix in place. */
function ancestryHint(
  exposure: ScriptAncestryExposure,
  ancestor: string,
  callerOwnsAncestor: boolean,
): string {
  if (exposure === 'unnamed_entry') {
    return 'End the script path in a valid file name, such as `--save-script=./workflows/journey.ad`.';
  }
  if (exposure === 'shared_group_writable' && !callerOwnsAncestor) {
    return 'Root owns that directory, so you cannot close it to its group. Save the script under a directory you own.';
  }
  if (exposure === 'shared_group_writable') {
    return `Close the directory to its group with \`chmod g-w ${ancestor}\`, or save the script under a directory only you can write.`;
  }
  return 'Save the script under a directory you own that only you can write, and keep the path out of directories other users own.';
}
