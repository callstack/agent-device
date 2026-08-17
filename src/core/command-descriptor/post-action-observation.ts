export type PostActionObservationSupport = 'settle' | 'settle-and-verify';

// `scroll` and `back` are settle-only (#1638): both mutate the screen without
// resolving an element, so there is no target to re-digest into `--verify`
// evidence — the settled diff IS the observation. They also run the generic
// daemon route rather than the interaction route, which is why the settle
// engine takes its diff baseline from the caller (the stored pre-action tree)
// instead of a resolution's `preActionNodes`.
const POST_ACTION_OBSERVATION_BY_COMMAND = {
  click: 'settle-and-verify',
  press: 'settle-and-verify',
  fill: 'settle-and-verify',
  longpress: 'settle',
  // Hover reveals UI (toolbars, menus) rather than activating a target, so the
  // settled diff is the observation; nothing to re-digest into --verify.
  hover: 'settle',
  scroll: 'settle',
  back: 'settle',
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
