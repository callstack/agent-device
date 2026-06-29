import { AsyncLocalStorage } from 'node:async_hooks';

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
export type ReplayTestActionProgressContext = Omit<
  ReplayTestProgressEvent,
  'type' | 'status' | 'stepIndex' | 'stepTotal' | 'durationMs' | 'retrying' | 'message'
>;

const requestProgress = new AsyncLocalStorage<RequestProgressSink | undefined>();
const replayTestActionProgress = new AsyncLocalStorage<
  ReplayTestActionProgressContext | undefined
>();

export async function withRequestProgressSink<T>(
  sink: RequestProgressSink | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return await requestProgress.run(sink, run);
}

export function emitRequestProgress(event: RequestProgressEvent): void {
  requestProgress.getStore()?.(event);
}

export async function withReplayTestActionProgress<T>(
  context: ReplayTestActionProgressContext | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return await replayTestActionProgress.run(context, run);
}

export function readReplayTestActionProgress(): ReplayTestActionProgressContext | undefined {
  return replayTestActionProgress.getStore();
}
