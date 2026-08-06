import type { PostActionObservationSupportFor } from '../core/command-descriptor/post-action-observation.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../core/command-descriptor/registry.ts';
import { SETTLE_FLAGS } from './cli-grammar/flag-groups.ts';
import type { FlagKey } from './cli-grammar/flag-types.ts';
import { booleanField, integerField } from './command-input.ts';

/**
 * The two caller-facing surfaces a command's post-action observation trait
 * entitles it to (`--verify` / `--settle`, #1047/#1101): the metadata input
 * fields (Node SDK options + MCP tool schema) and the CLI allowed flags. Both
 * are materialized from the descriptor registry rather than hand-listed per
 * command. This lives outside the interaction family because the trait does
 * too: `scroll` and `back` carry it on the generic daemon route (#1638), and
 * `back` is a system command.
 *
 * A descriptor gate (`post-action-observation.test.ts`) asserts, over every
 * descriptor, that both surfaces are present exactly when the trait is — so a
 * new settle-capable command cannot ship with a schema or grammar that hides
 * the flags.
 */

const verifyField = () =>
  booleanField(
    'Capture cheap post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot.',
  );

const settleFields = () => ({
  settle: booleanField(
    'After the action, wait for the UI to go quiet and return the settled diff vs the pre-action tree in the same response. Best-effort; never fails the action.',
  ),
  settleQuietMs: integerField('Settle: quiet window in milliseconds (default 500).', { min: 0 }),
  timeoutMs: integerField('Settle: wait deadline in milliseconds (default 10000).', { min: 1 }),
});

type VerifyFieldMap = { verify: ReturnType<typeof verifyField> };
type SettleFieldMap = ReturnType<typeof settleFields>;

export type PostActionObservationFields<TName extends string> =
  PostActionObservationSupportFor<TName> extends 'settle-and-verify'
    ? VerifyFieldMap & SettleFieldMap
    : PostActionObservationSupportFor<TName> extends 'settle'
      ? SettleFieldMap
      : {};

export function postActionObservationFields<const TName extends string>(
  command: TName,
): PostActionObservationFields<TName> {
  return {
    ...(commandSupportsVerifyEvidence(command) ? { verify: verifyField() } : {}),
    ...(commandSupportsSettleObservation(command) ? settleFields() : {}),
  } as PostActionObservationFields<TName>;
}

export function postActionObservationCliFlags(command: string): readonly FlagKey[] {
  const flags: FlagKey[] = [];
  if (commandSupportsVerifyEvidence(command)) flags.push('verify');
  if (commandSupportsSettleObservation(command)) flags.push(...SETTLE_FLAGS);
  return flags;
}
