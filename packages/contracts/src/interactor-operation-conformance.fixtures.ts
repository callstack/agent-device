import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import type { CatalogInteractorOperation } from './interactor-operation-catalog.ts';
import { localInteractorSource, providerInteractorSource } from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';

type InteractorSource = (runner: RunnerContext) => Promise<Interactor>;

type ConformanceRowFor<Operation extends CatalogInteractorOperation> = Readonly<{
  operation: Operation;
  /** How a provider refusal names the operation: the catalog row's `label`. */
  label: string;
  /** The facet's own binder, exactly as the interactor catalog row calls it. */
  bind: (
    signal: AbortSignal,
    source: InteractorSource,
  ) => Pick<PlatformRuntimeOperations, Operation>;
  /** The `Interactor` method the operation drives once its interactor is resolved. */
  method: keyof Interactor;
  /** One input naming no target app; the helper supplies `execution` and expects no `appBundleId`. */
  input: Omit<Parameters<PlatformRuntimeOperations[Operation]>[0], 'execution'>;
}>;

/** One catalog operation's expectations; `bind` and `input` are typed by the `operation` named. */
export type InteractorOperationConformanceRow = {
  [Operation in CatalogInteractorOperation]: ConformanceRowFor<Operation>;
}[CatalogInteractorOperation];

type BoundOperation = (input: unknown) => Promise<unknown>;

function bindRow(
  row: InteractorOperationConformanceRow,
  signal: AbortSignal,
  source: InteractorSource,
): BoundOperation {
  const operations: Partial<PlatformRuntimeOperations> = row.bind(signal, source);
  return operations[row.operation] as BoundOperation;
}

/**
 * Registers the three binding-rule tests every interactor-catalog operation must pass. The
 * calling module owns the expected table; this module owns only the mechanics, so each rule is
 * stated once and cannot drift between facets.
 */
export function conformInteractorOperations(
  family: Readonly<{
    device: DeviceInfo;
    rows: readonly [InteractorOperationConformanceRow, ...InteractorOperationConformanceRow[]];
  }>,
): void {
  const { device, rows } = family;

  test('a provider binding drives its own resolved interactor', async () => {
    for (const row of rows) {
      const method = vi.fn(async () => undefined);
      const resolveInteractor = vi.fn(() => ({ [row.method]: method }) as unknown as Interactor);
      const signal = new AbortController().signal;
      const requestId = `${row.operation}-provider`;
      const source = providerInteractorSource({ device, operation: row.label, resolveInteractor });

      await bindRow(row, signal, source)({ ...row.input, execution: { requestId } });

      expect(resolveInteractor, row.operation).toHaveBeenCalledWith({
        requestId,
        appBundleId: undefined,
        signal,
      });
      expect(method, row.operation).toHaveBeenCalledOnce();
    }
  });

  test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
    for (const row of rows) {
      const source = providerInteractorSource({
        device,
        operation: row.label,
        resolveInteractor: () => undefined,
      });

      await expect(
        bindRow(row, new AbortController().signal, source)(row.input),
        row.operation,
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        message: `Provider-owned ${row.label} operation has no bound provider interactor.`,
        details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
      });
    }
  });

  test('an already-cancelled request never resolves an interactor', async () => {
    for (const row of rows) {
      const controller = new AbortController();
      controller.abort();
      const method = vi.fn(async () => undefined);
      const resolveInteractor = vi.fn(
        async () => ({ [row.method]: method }) as unknown as Interactor,
      );
      const source = localInteractorSource({ device, resolveInteractor });

      await expect(
        bindRow(row, controller.signal, source)(row.input),
        row.operation,
      ).rejects.toThrow();
      expect(resolveInteractor, row.operation).not.toHaveBeenCalled();
      expect(method, row.operation).not.toHaveBeenCalled();
    }
  });
}
