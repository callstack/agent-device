/**
 * A command this module asked to be killed is finished once its child is gone, without
 * waiting for the stdio pipes to drain: a descendant that inherited them keeps `close`
 * from arriving, and the request behind the command — and the device lock it holds —
 * would wait forever. Whether the kill request or the child's exit arrives first is not
 * a question each caller should answer, so both report here and settlement happens once.
 */
export type CommandKillSettlement = {
  /** Signals the command's process tree, then settles the command if its child is gone. */
  readonly requestKill: () => void;
  /** Records the child's exit, then settles the command if a kill was already requested. */
  readonly recordExit: (code: number | null) => void;
};

export function createCommandKillSettlement(input: {
  readonly killProcessTree: () => void;
  readonly settle: (exitCode: number | null) => void;
}): CommandKillSettlement {
  let killRequested = false;
  let exited = false;
  let exitCode: number | null = null;
  const settleIfKilledAndGone = (): void => {
    if (killRequested && exited) input.settle(exitCode);
  };
  return {
    requestKill: () => {
      killRequested = true;
      input.killProcessTree();
      settleIfKilledAndGone();
    },
    recordExit: (code) => {
      exited = true;
      exitCode = code ?? 1;
      settleIfKilledAndGone();
    },
  };
}
