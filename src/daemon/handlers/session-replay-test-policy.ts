import type { CommandFlags } from '../../core/dispatch.ts';

export const REPLAY_ONLY_TEST_FLAG_REJECTIONS = [
  {
    keys: ['replayKeepSession'],
    requested: (flags: CommandFlags) => flags.replayKeepSession === true,
    message:
      'test does not support --keep-session; suite attempts own their cleanup. Run one native .ad script directly with replay --keep-session.',
  },
  {
    keys: ['replayFrom', 'replayPlanDigest'],
    requested: (flags: CommandFlags) =>
      flags.replayFrom !== undefined || flags.replayPlanDigest !== undefined,
    message:
      'test does not support --from/--plan-digest; resume is replay-only. Run the failing script directly with replay --from.',
  },
  {
    keys: ['saveScript', 'force'],
    requested: (flags: CommandFlags) => Boolean(flags.saveScript) || flags.force === true,
    message:
      'test does not support --save-script/--force; the agent-supervised repair loop is replay-only. Repair the failing script directly with replay --save-script.',
  },
] as const satisfies readonly {
  keys: readonly (keyof CommandFlags)[];
  requested: (flags: CommandFlags) => boolean;
  message: string;
}[];
