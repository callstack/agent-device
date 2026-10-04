import { createDurableCaptureSessionBinding } from './session-binding.ts';
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
      if (!entry) throw new AppError('COMMAND_FAILED', 'Test session not found');
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
  return createDurableCaptureSessionBinding({
    address,
    sessionDir: store.resolveSessionDir(address),
    initialSession: ref.session,
    resolveCurrent: () => store.resolveCurrent(ref),
    requireCurrent: () => {
      const session = store.resolveCurrent(ref);
      if (session === undefined) throw new AppError('COMMAND_FAILED', 'Test session retired');
      return session;
    },
    assertAdmissionOpen: () => {},
    read: slot.read,
    write: (resource) => store.update(ref, (current) => slot.replace(current, resource)),
  });
}
