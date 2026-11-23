import fs from 'node:fs';
import path from 'node:path';
import { startDaemonRuntime } from '@agent-device/daemon';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';

export const rentalRestartFixturePath = new URL(import.meta.url);
export const fakeRentalKey = 'fake-request-1';
export const fakeInstanceId = 'fake-instance-1';
export const interruptionExitCode = 71;

export function rentalDaemonEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    AGENT_DEVICE_HOME: stateDir,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
    AGENT_DEVICE_DAEMON_SERVER_MODE: 'socket',
  };
}

export async function startRentalDaemon(
  stateDir: string,
  phase: string,
  reportRecovery: (result: unknown) => void,
  overrides?: Pick<
    Partial<Awaited<ReturnType<typeof createDaemonRuntimeDeps>>>,
    'leaseLifecycleProvider' | 'recoverExpiredLease' | 'providerRentalPolicy'
  >,
) {
  const otherPrincipal = phase === 'recover-other-principal';
  const fakeProviderState = path.join(
    stateDir,
    otherPrincipal ? 'other-account-instance' : 'fake-provider-instance',
  );
  const runtime = await startDaemonRuntime({
    host: captureHostEnvironment({ env: rentalDaemonEnv(stateDir), cwd: process.cwd }),
    composeDeps: async (input) => {
      const deps = await createDaemonRuntimeDeps(input);
      return {
        ...deps,
        providerRentalPolicy: () => ({
          rentalRecoveryPrincipal: otherPrincipal ? 'other-account' : 'original-account',
          legacyRecovery: false,
        }),
        providerRuntimeIds: ['limrun'],
        recoverableProviderIds: ['limrun'],
        recoverExpiredLease: async () => {
          fs.rmSync(fakeProviderState, { force: true });
        },
        leaseLifecycleProvider: {
          allocate: async (_lease, context) => {
            if (phase === 'before-key') process.exit(interruptionExitCode);
            context?.rental?.beforeCreate(fakeRentalKey);
            if (phase === 'before-create' || phase === 'unknown')
              process.exit(interruptionExitCode);
            fs.writeFileSync(fakeProviderState, fakeInstanceId);
            if (phase === 'after-create') process.exit(interruptionExitCode);
            context?.rental?.rented(fakeInstanceId);
            if (phase === 'after-identity') process.exit(interruptionExitCode);
            return { providerSessionId: fakeInstanceId };
          },
          release: async () => {
            if (phase === 'during-release') process.exit(interruptionExitCode);
            fs.rmSync(fakeProviderState, { force: true });
            if (phase === 'after-delete') process.exit(interruptionExitCode);
            return { release: 'confirmed' };
          },
          recoverRental: async (_lease, identity, recordInstance) => {
            if (phase === 'recover-unknown') {
              reportRecovery({ recovery: identity, outcome: 'unknown' });
              return false;
            }
            const found = fs.existsSync(fakeProviderState)
              ? fs.readFileSync(fakeProviderState, 'utf8')
              : undefined;
            if (identity.instanceId === undefined && identity.reconciliationKey !== fakeRentalKey)
              throw new Error('Recovery did not present the provider reconciliation key.');
            if (found !== undefined) {
              const instanceId = identity.instanceId ?? found;
              if (instanceId !== found) throw new Error('Recovery targeted a different rental.');
              recordInstance(instanceId);
              // The fake refuses to execute a delete if the daemon has not recorded its exact target.
              const journal = fs.readFileSync(path.join(stateDir, 'provider-rentals.json'), 'utf8');
              if (!journal.includes(instanceId))
                throw new Error('Exact release target is missing.');
              fs.rmSync(fakeProviderState);
            }
            reportRecovery({ recovery: identity, outcome: found ?? 'absent' });
            return true;
          },
        },
        ...overrides,
      };
    },
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  if (!runtime?.socketPort) throw new Error('Rental restart fixture did not open a socket.');
  return { runtime, port: runtime.socketPort, token: runtime.token };
}

if (process.send && process.argv[2] === 'run-rental-restart-fixture') {
  const [, , , stateDir, phase] = process.argv;
  if (!stateDir || !phase)
    throw new Error('Rental restart fixture needs a state directory and phase.');
  const { runtime, port, token } = await startRentalDaemon(stateDir, phase, (result) =>
    process.send?.(result),
  );
  process.on('disconnect', () => process.exit(0));
  process.on('message', async (message) => {
    if (message !== 'close') return;
    await runtime.close();
    process.disconnect?.();
  });
  process.send({ port, token });
}
