import { expect, test, vi } from 'vitest';
import {
  INTERACTOR_OPERATIONS,
  type CatalogInteractorOperation,
} from './interactor-operation-catalog.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';
import type { Interactor } from './interactor-types.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';

// The three binding rules every interactor-catalog operation must obey, driven by the catalog
// itself: each rule walks INTERACTOR_OPERATIONS and binds through the catalog row's own `bind`
// and `label`, exactly as production does. Completeness is therefore structural, not observed:
// the expectation table below is typed over every catalog operation, so a row cannot be missing,
// duplicated, or name an operation the catalog does not register, and every row is executed by
// the tests in this file. Each facet's own `*-runtime.test.ts` keeps only its dedicated tests.

type ConformanceExpectation<Operation extends CatalogInteractorOperation> = Readonly<{
  /** The `Interactor` method the operation drives once its interactor is resolved. */
  method: keyof Interactor;
  /** One input naming no target app; the tests supply `execution` and expect no `appBundleId`. */
  input: Omit<Parameters<PlatformRuntimeOperations[Operation]>[0], 'execution'>;
}>;

const EXPECTATIONS: {
  readonly [Operation in CatalogInteractorOperation]: ConformanceExpectation<Operation>;
} = {
  back: { method: 'back', input: {} },
  home: { method: 'home', input: {} },
  setOrientation: { method: 'setOrientation', input: { rotation: 'portrait' } },
  tvRemote: { method: 'tvRemote', input: { button: 'select' } },
  keyboardStatus: { method: 'keyboardStatus', input: {} },
  keyboardDismiss: { method: 'keyboardDismiss', input: {} },
  keyboardEnter: { method: 'keyboardEnter', input: {} },
  readClipboard: { method: 'readClipboard', input: {} },
  writeClipboard: { method: 'writeClipboard', input: { text: '' } },
  appSwitcher: { method: 'appSwitcher', input: {} },
  triggerAppEvent: { method: 'open', input: { eventUrl: 'myapp://x' } },
  setSetting: {
    method: 'setSetting',
    input: { setting: 'appearance', state: 'dark' },
  },
  readAlert: { method: 'readAlert', input: {} },
  awaitAlert: { method: 'awaitAlert', input: {} },
  acceptAlert: { method: 'acceptAlert', input: {} },
  dismissAlert: { method: 'dismissAlert', input: {} },
};

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

type CatalogDefinition = (typeof INTERACTOR_OPERATIONS)[number];
type BoundOperation = (input: unknown) => Promise<unknown>;

function bindCatalogOperation(
  definition: CatalogDefinition,
  signal: AbortSignal,
  source: Parameters<CatalogDefinition['bind']>[1],
): BoundOperation {
  const operations: Partial<PlatformRuntimeOperations> = definition.bind(signal, source);
  const bound = operations[definition.operation] as BoundOperation | undefined;
  expect(bound, `${definition.operation} binds its own operation`).toBeTypeOf('function');
  return bound as BoundOperation;
}

test('the expectation table names exactly the catalog operations', () => {
  expect(Object.keys(EXPECTATIONS).sort()).toEqual(
    INTERACTOR_OPERATIONS.map(({ operation }) => operation).sort(),
  );
});

test('a provider binding drives its own resolved interactor', async () => {
  for (const definition of INTERACTOR_OPERATIONS) {
    const { method: methodName, input } = EXPECTATIONS[definition.operation];
    const method = vi.fn(async () => undefined);
    const resolveInteractor = vi.fn(() => ({ [methodName]: method }) as unknown as Interactor);
    const signal = new AbortController().signal;
    const requestId = `${definition.operation}-provider`;
    const source = providerInteractorSource({
      device,
      operation: definition.label,
      resolveInteractor,
    });

    await bindCatalogOperation(definition, signal, source)({ ...input, execution: { requestId } });

    expect(resolveInteractor, definition.operation).toHaveBeenCalledWith({
      requestId,
      appBundleId: undefined,
      signal,
    });
    expect(method, definition.operation).toHaveBeenCalledOnce();
  }
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  for (const definition of INTERACTOR_OPERATIONS) {
    const source = providerInteractorSource({
      device,
      operation: definition.label,
      resolveInteractor: () => undefined,
    });

    await expect(
      bindCatalogOperation(
        definition,
        new AbortController().signal,
        source,
      )(EXPECTATIONS[definition.operation].input),
      definition.operation,
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: `Provider-owned ${definition.label} operation has no bound provider interactor.`,
      details: {
        reason: 'provider-runtime-interactor-missing',
        deviceId: device.id,
      },
    });
  }
});

test('an already-cancelled request never resolves an interactor', async () => {
  for (const definition of INTERACTOR_OPERATIONS) {
    const { method: methodName, input } = EXPECTATIONS[definition.operation];
    const controller = new AbortController();
    controller.abort();
    const method = vi.fn(async () => undefined);
    const resolveInteractor = vi.fn(
      async () => ({ [methodName]: method }) as unknown as Interactor,
    );
    const source = localInteractorSource({ device, resolveInteractor });

    await expect(
      bindCatalogOperation(definition, controller.signal, source)(input),
      definition.operation,
    ).rejects.toThrow();
    expect(resolveInteractor, definition.operation).not.toHaveBeenCalled();
    expect(method, definition.operation).not.toHaveBeenCalled();
  }
});
