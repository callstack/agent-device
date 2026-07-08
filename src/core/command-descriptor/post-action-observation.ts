export type PostActionObservationSupport = 'settle' | 'settle-and-verify';

const POST_ACTION_OBSERVATION_BY_COMMAND = {
  click: 'settle-and-verify',
  press: 'settle-and-verify',
  fill: 'settle-and-verify',
  longpress: 'settle',
} as const satisfies Record<string, PostActionObservationSupport>;

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
