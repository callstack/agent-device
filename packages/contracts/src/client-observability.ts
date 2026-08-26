// The public API vocabulary for perf, logs, events, network, audio and recording capture.

import type { LogAction } from './logs.ts';
import type { PerfAction, PerfArea, PerfKind, PerfSubject } from './perf.ts';
import type { RecordingExportQuality } from './recording-export-quality.ts';
import type { RecordingScope } from './recording-scope.ts';
import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { AgentDeviceRequestOverrides, DeviceCommandBaseOptions } from './client-connection.ts';

export type PerfOptions = DeviceCommandBaseOptions & {
  /** Select focused performance evidence. */
  area: PerfArea;
  subject?: PerfSubject;
  action?: PerfAction;
  kind?: PerfKind;
  template?: string;
  out?: string;
  tracePath?: string;
};

export type LogsOptions = AgentDeviceRequestOverrides & {
  action?: LogAction;
  message?: string;
  restart?: boolean;
};

export type EventsOptions = AgentDeviceRequestOverrides & {
  cursor?: string;
  limit?: number;
};

export type NetworkOptions = DeviceCommandBaseOptions & {
  action?: 'dump' | 'log';
  limit?: number;
  include?: NetworkIncludeMode;
};

export type AudioOptions = DeviceCommandBaseOptions & {
  action?: 'probe';
  probeAction?: 'start' | 'status' | 'stop';
  durationMs?: number;
  bucketMs?: number;
};

export type RecordOptions = AgentDeviceRequestOverrides & {
  action: 'start' | 'stop';
  path?: string;
  fps?: number;
  quality?: RecordingExportQuality;
  hideTouches?: boolean;
  recordingScope?: RecordingScope;
};

export type TraceOptions = AgentDeviceRequestOverrides & {
  action: 'start' | 'stop';
  path?: string;
};
