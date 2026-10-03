import { AppError } from '@agent-device/kernel/errors';
import type { DurableCaptureSessionBinding, DurableCaptureSessionResource } from './definition.ts';

type FixtureSessionRef<S> = Readonly<{ address: string; session: S; lifetime: object }>;

export function makeCaptureFixtureStore<S>(resolveSessionDir: (address: string) => string) {
  const entries = new Map<string, { current: S }>();
  const resolveCurrent = (ref: FixtureSessionRef<S>): S | undefined => {
    const entry = entries.get(ref.address);
    return entry === ref.lifetime ? entry.current : undefined;
  };
  return Object.freeze({
    resolveSessionDir,
    get: (address: string): S | undefined => entries.get(address)?.current,
    set: (address: string, session: S): void => {
      const entry = entries.get(address);
      if (entry) entry.current = session;
      else entries.set(address, { current: session });
    },
    lookup: (address: string): FixtureSessionRef<S> => {
      const entry = entries.get(address);
      if (!entry) throw new AppError('COMMAND_FAILED', 'Test session retired');
      return Object.freeze({ address, session: entry.current, lifetime: entry });
    },
    resolveCurrent,
    update: (ref: FixtureSessionRef<S>, rebuild: (current: S) => S): void => {
      const current = resolveCurrent(ref);
      if (current === undefined) throw new AppError('COMMAND_FAILED', 'Test session retired');
      entries.get(ref.address)!.current = rebuild(current);
    },
    retire: (ref: FixtureSessionRef<S>): boolean =>
      resolveCurrent(ref) !== undefined && entries.delete(ref.address),
  });
}

export function makeCaptureSessionBinding<K extends string, H extends AsyncDisposable, S>(
  store: ReturnType<typeof makeCaptureFixtureStore<S>>,
  address: string,
  slot: Readonly<{
    read(session: S): DurableCaptureSessionResource<K, H> | undefined;
    replace(session: S, resource: DurableCaptureSessionResource<K, H> | undefined): S;
  }>,
): DurableCaptureSessionBinding<K, H> {
  const ref = store.lookup(address);
  let retained = slot.read(ref.session);
  const requireSession = (): S => {
    const session = store.resolveCurrent(ref);
    if (session === undefined) throw new AppError('COMMAND_FAILED', 'Test session retired');
    return session;
  };
  const assertAdoptable = (): void => {
    if (slot.read(requireSession())) throw new AppError('COMMAND_FAILED', 'Test resource changed');
  };
  return Object.freeze({
    address,
    sessionDir: store.resolveSessionDir(address),
    read: () => {
      const session = store.resolveCurrent(ref);
      if (session !== undefined) retained = slot.read(session);
      return retained;
    },
    assertAdoptable,
    canPersist: () => {
      const session = store.resolveCurrent(ref);
      return session !== undefined && slot.read(session) === undefined;
    },
    adopt: (resource) => {
      assertAdoptable();
      store.update(ref, (current) => slot.replace(current, resource));
      retained = resource;
    },
    clear: (expected) => {
      const current = store.resolveCurrent(ref);
      if (current === undefined) return 'retired';
      const active = slot.read(current);
      if (
        active?.handle !== expected.handle ||
        active.envelope.fence.token !== expected.envelope.fence.token ||
        active.envelope.fence.generation !== expected.envelope.fence.generation
      )
        return 'resource-changed';
      store.update(ref, (session) => slot.replace(session, undefined));
      retained = undefined;
      return 'cleared';
    },
  });
}
