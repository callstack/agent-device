import { AppError } from '@agent-device/kernel/errors';
import type { AppLogRuntimeOperations } from './app-log-runtime.ts';
import { runtimeUse } from './platform-runtime.ts';

const appLogUse = runtimeUse<AppLogRuntimeOperations>();

const appLogInspectUse = appLogUse({ required: ['appLogInspect'] });
const appLogDoctorUse = appLogUse({ required: ['appLogInspect', 'appLogDoctor'] });
const appLogStartUse = appLogUse({ required: ['appLogInspect', 'appLogStart'] });

/** Fact-only admission probe; it is deliberately not an execution-plan variant. */
export const appLogAdmissionUse = appLogUse({
  required: [],
  preferred: ['appLogInspect'],
});

/** The exhaustive distinct use set declared by the input-dependent logs descriptor. */
export const appLogRuntimePlanUses = Object.freeze([
  appLogInspectUse,
  appLogDoctorUse,
  appLogStartUse,
] as const);

export type LogsRuntimePlan =
  | Readonly<{ kind: 'path'; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'start'; use: typeof appLogStartUse }>
  | Readonly<{ kind: 'stop'; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'doctor'; use: typeof appLogDoctorUse }>
  | Readonly<{ kind: 'mark'; marker: string; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'clear'; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'clear-restart'; use: typeof appLogStartUse }>;

export type LogsRuntimePlanInput = Readonly<{
  action?: string;
  restart?: boolean;
  marker?: string;
}>;

export function resolveLogsRuntimePlan(input: LogsRuntimePlanInput): LogsRuntimePlan {
  const action = (input.action ?? 'path').toLowerCase();
  if (input.restart && action !== 'clear') {
    throw new AppError('INVALID_ARGS', 'logs --restart is only supported with logs clear');
  }
  switch (action) {
    case 'path':
      return Object.freeze({ kind: 'path', use: appLogInspectUse });
    case 'start':
      return Object.freeze({ kind: 'start', use: appLogStartUse });
    case 'stop':
      return Object.freeze({ kind: 'stop', use: appLogInspectUse });
    case 'doctor':
      return Object.freeze({ kind: 'doctor', use: appLogDoctorUse });
    case 'mark':
      return Object.freeze({ kind: 'mark', marker: input.marker ?? '', use: appLogInspectUse });
    case 'clear':
      return input.restart
        ? Object.freeze({ kind: 'clear-restart', use: appLogStartUse })
        : Object.freeze({ kind: 'clear', use: appLogInspectUse });
    default:
      throw new AppError('INVALID_ARGS', 'logs requires path, start, stop, doctor, mark, or clear');
  }
}
