import type { runCmdDetachedMonitored, ExecDetachedExit } from '@agent-device/host-kit/command';
import type { RegisteredDaemonChild } from './registered-daemon-fixture.ts';

type LaunchOptions = Parameters<typeof runCmdDetachedMonitored>[2];

export type DaemonFixtureLaunch<P, F> =
  | { kind: 'refuse'; error: Error }
  | { kind: 'exit'; exit: ExecDetachedExit; exitGate?: Promise<void> }
  | {
      kind: 'registered';
      paths: P;
      fields: F;
      acquisitionBarrier?: string;
      fixtureOptions?: {
        emitStartupMarker?: boolean;
        emitStartupMarkerBeforeAcquisition?: boolean;
      };
      exitGate?: Promise<void>;
      observe?: (child: RegisteredDaemonChild) => void;
      companions?: readonly Extract<DaemonFixtureLaunch<P, F>, { kind: 'registered' }>[];
    };

export type DaemonFixtureLaunchStep<P, F> =
  | DaemonFixtureLaunch<P, F>
  | ((options: LaunchOptions) => DaemonFixtureLaunch<P, F>);

/** Owns the launch decision and handle; callbacks may describe or observe, but never launch. */
export function createDaemonFixtureLaunchPlanner<P, F>(
  launch: (
    step: Extract<DaemonFixtureLaunch<P, F>, { kind: 'registered' }>,
    options: LaunchOptions,
  ) => RegisteredDaemonChild,
) {
  let describing = false;
  const violations: Error[] = [];
  const refuse = (message: string): never => {
    const error = new Error(`Daemon fixture launch contract: ${message}`);
    violations.push(error);
    throw error;
  };
  function start(
    step: Extract<DaemonFixtureLaunch<P, F>, { kind: 'registered' }>,
    options: LaunchOptions,
  ): RegisteredDaemonChild {
    for (const companion of step.companions ?? []) start(companion, options);
    const child = Object.freeze(launch(step, options));
    describing = true;
    try {
      const result: unknown = step.observe?.(child);
      if (result !== undefined) refuse('an observer returned a replacement handle or value');
    } catch (error) {
      violations.push(
        new Error('Daemon fixture launch observer failed after starting a child', { cause: error }),
      );
    } finally {
      describing = false;
    }
    return child;
  }
  return {
    assertLaunchAllowed() {
      if (describing) refuse('a plan callback attempted to start a child');
    },
    assertPlans() {
      if (violations.length)
        throw new AggregateError(violations.splice(0), 'Daemon fixture launch contract violated');
    },
    planRegisteredDaemonLaunches(
      steps: readonly DaemonFixtureLaunchStep<P, F>[],
    ): typeof runCmdDetachedMonitored {
      let index = 0;
      return (_command, _args, options) => {
        if (describing) return refuse('a plan callback attempted a nested launch');
        const next = steps[index++];
        if (!next) return refuse(`unexpected launch ${index}; planned ${steps.length}`);
        let step: DaemonFixtureLaunch<P, F>;
        describing = true;
        try {
          step = typeof next === 'function' ? next(options) : next;
        } finally {
          describing = false;
        }
        if (step.kind === 'refuse') throw step.error;
        if (step.kind === 'exit')
          return {
            pid: step.exit.pid,
            exited: Promise.resolve(step.exit).then(async (exit) => {
              await step.exitGate;
              return exit;
            }),
          };
        const child = start(step, options);
        return step.exitGate
          ? {
              pid: child.pid,
              exited: child.exited.then(async (exit) => {
                await step.exitGate;
                return exit;
              }),
            }
          : child;
      };
    },
  };
}
