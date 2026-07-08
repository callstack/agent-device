/**
 * Public daemon result for `wait`. The runtime-local result carries a `kind`
 * discriminant, but `toDaemonWaitData` intentionally projects the normal daemon
 * payload to this compact shape. The direct iOS selector fast path may still
 * include `kind: 'selector'` additively.
 */
export type WaitCommandResult = {
  waitedMs: number;
  kind?: 'selector';
  text?: string;
  selector?: string;
  captures?: number;
  nodeCount?: number;
  hint?: string;
  warning?: string;
};
