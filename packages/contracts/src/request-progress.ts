/**
 * Progress events the daemon streams to a connected client while a request runs.
 *
 * These are wire values: `src/daemon/request-progress-protocol.ts` serializes them onto the
 * response stream and the CLI reconstructs them before handing them to the replay-test
 * reporter registry. They therefore belong to neither side — the daemon's request-global
 * progress plumbing carries them, and the replay-test scheduler produces and interprets
 * them, so the vocabulary sits below both.
 */

export type ReplayTestSuiteProgressEvent = {
  type: 'replay-test-suite';
  status: 'start';
  total: number;
  runnable: number;
  skipped: number;
  artifactsDir: string;
  shardMode?: 'all' | 'split';
  shardCount?: number;
};

export type ReplayTestProgressEvent = {
  type: 'replay-test';
  file: string;
  title?: string;
  status: 'start' | 'progress' | 'pass' | 'fail' | 'skip';
  index: number;
  total: number;
  stepIndex?: number;
  stepTotal?: number;
  stepCommand?: string;
  stepValue?: string;
  attempt?: number;
  maxAttempts?: number;
  durationMs?: number;
  retrying?: boolean;
  message?: string;
  hint?: string;
  session?: string;
  artifactsDir?: string;
  shardIndex?: number;
  shardCount?: number;
  deviceId?: string;
  deviceName?: string;
};

export type CommandProgressEvent = {
  type: 'command';
  status: 'progress';
  message: string;
};

export type RequestProgressEvent =
  | ReplayTestSuiteProgressEvent
  | ReplayTestProgressEvent
  | CommandProgressEvent;

export type RequestProgressSink = (event: RequestProgressEvent) => void;
