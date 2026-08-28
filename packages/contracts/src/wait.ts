/**
 * Machine-readable wait failure taxonomy. These values are carried in
 * `error.details.reason`; callers should branch on them instead of parsing
 * wait error messages.
 *
 * `wait_capture_stalled` means no readable capture established an observation
 * before the deadline and is retriable. `wait_deadline_exceeded` means a later
 * capture consumed the remaining budget after at least one readable capture.
 * `wait_target_absent` is the only ordinary absence verdict and therefore
 * always carries readable-capture evidence. The remaining reasons describe
 * stability and replay-landmark refusals.
 */
export const WAIT_REASONS = {
  captureStalled: 'wait_capture_stalled',
  deadlineExceeded: 'wait_deadline_exceeded',
  runnerRestartExhausted: 'wait_runner_restart_exhausted',
  targetAbsent: 'wait_target_absent',
  stableTimeout: 'wait_stable_timeout',
  landmarkIdentityMismatch: 'wait_landmark_identity_mismatch',
} as const;

export type WaitReason = (typeof WAIT_REASONS)[keyof typeof WAIT_REASONS];

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
