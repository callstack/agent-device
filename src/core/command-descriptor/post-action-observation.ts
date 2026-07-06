import { PUBLIC_COMMANDS, type PublicCommandName } from '../../command-catalog.ts';

export type PostActionObservationSupport = 'settle' | 'settle-and-verify';

const POST_ACTION_OBSERVATION_BY_COMMAND = {
  [PUBLIC_COMMANDS.click]: 'settle-and-verify',
  [PUBLIC_COMMANDS.press]: 'settle-and-verify',
  [PUBLIC_COMMANDS.fill]: 'settle-and-verify',
  [PUBLIC_COMMANDS.longPress]: 'settle',
} as const satisfies Partial<Record<PublicCommandName, PostActionObservationSupport>>;

export type PostActionObservationCommandName = keyof typeof POST_ACTION_OBSERVATION_BY_COMMAND;

export type PostActionObservationSupportFor<TName extends string> =
  TName extends PostActionObservationCommandName
    ? (typeof POST_ACTION_OBSERVATION_BY_COMMAND)[TName]
    : undefined;

export function resolvePostActionObservationSupport(
  command: string | undefined,
): PostActionObservationSupport | undefined {
  if (command === undefined) return undefined;
  return POST_ACTION_OBSERVATION_BY_COMMAND[command as PostActionObservationCommandName];
}
