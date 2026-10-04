import { AppError } from '@agent-device/kernel/errors';
import type { DurableCaptureSessionBinding, DurableCaptureSessionResource } from './definition.ts';

export function createDurableCaptureSessionBinding<S, K extends string, H extends AsyncDisposable>(
  port: Readonly<{
    address: string;
    sessionDir: string;
    initialSession: S;
    resolveCurrent(): S | undefined;
    requireCurrent(): S;
    assertAdmissionOpen(): void;
    read(session: S): DurableCaptureSessionResource<K, H> | undefined;
    write(resource: DurableCaptureSessionResource<K, H> | undefined): void;
  }>,
): DurableCaptureSessionBinding<K, H> {
  let retained = port.read(port.resolveCurrent() ?? port.initialSession);
  const assertAdoptable = (): void => {
    port.assertAdmissionOpen();
    if (port.read(port.requireCurrent())) {
      throw new AppError('COMMAND_FAILED', 'Session capture resource has changed', {
        reason: 'session_resource_changed',
        session: port.address,
      });
    }
  };
  return Object.freeze({
    address: port.address,
    sessionDir: port.sessionDir,
    read: () => {
      const current = port.resolveCurrent();
      if (current !== undefined) retained = port.read(current);
      return retained;
    },
    assertAdoptable,
    canPersist: () => {
      const current = port.resolveCurrent();
      return current !== undefined && port.read(current) === undefined;
    },
    adopt: (resource) => {
      assertAdoptable();
      port.write(resource);
      retained = resource;
    },
    clear: (expected) => {
      const current = port.resolveCurrent();
      if (current === undefined) return 'retired';
      const active = port.read(current);
      retained = active;
      if (
        active?.handle !== expected.handle ||
        active.envelope.fence.token !== expected.envelope.fence.token ||
        active.envelope.fence.generation !== expected.envelope.fence.generation
      )
        return 'resource-changed';
      port.write(undefined);
      retained = undefined;
      return 'cleared';
    },
  });
}
