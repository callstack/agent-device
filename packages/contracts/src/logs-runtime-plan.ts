import { AppError } from '@agent-device/kernel/errors';
import { defineUse } from './platform-runtime-operations.ts';

const appLogInspectUse = defineUse({ required: ['appLogInspect'] });
const appLogDoctorUse = defineUse({ required: ['appLogInspect', 'appLogDoctor'] });
const appLogStartUse = defineUse({ required: ['appLogInspect', 'appLogStart'] });

/** Fact-only admission probe; it is deliberately not an execution-plan variant. */
export const appLogAdmissionUse = defineUse({
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
  | Readonly<{ kind: 'path'; requiresAppSession: false; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'start'; requiresAppSession: true; use: typeof appLogStartUse }>
  | Readonly<{ kind: 'stop'; requiresAppSession: false; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'doctor'; requiresAppSession: false; use: typeof appLogDoctorUse }>
  | Readonly<{
      kind: 'mark';
      marker: string;
      requiresAppSession: false;
      use: typeof appLogInspectUse;
    }>
  | Readonly<{ kind: 'clear'; requiresAppSession: false; use: typeof appLogInspectUse }>
  | Readonly<{ kind: 'clear-restart'; requiresAppSession: true; use: typeof appLogStartUse }>;

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
      return Object.freeze({ kind: 'path', requiresAppSession: false, use: appLogInspectUse });
    case 'start':
      return Object.freeze({ kind: 'start', requiresAppSession: true, use: appLogStartUse });
    case 'stop':
      return Object.freeze({ kind: 'stop', requiresAppSession: false, use: appLogInspectUse });
    case 'doctor':
      return Object.freeze({ kind: 'doctor', requiresAppSession: false, use: appLogDoctorUse });
    case 'mark':
      return Object.freeze({
        kind: 'mark',
        marker: input.marker ?? '',
        requiresAppSession: false,
        use: appLogInspectUse,
      });
    case 'clear':
      return input.restart
        ? Object.freeze({
            kind: 'clear-restart',
            requiresAppSession: true,
            use: appLogStartUse,
          })
        : Object.freeze({ kind: 'clear', requiresAppSession: false, use: appLogInspectUse });
    default:
      throw new AppError('INVALID_ARGS', 'logs requires path, start, stop, doctor, mark, or clear');
  }
}
