import type { RuntimeOperationKey, RuntimeUse } from './platform-runtime.ts';

type RuntimeUseInput<
  Operations extends object,
  Required extends readonly RuntimeOperationKey<Operations>[],
  Preferred extends readonly Exclude<RuntimeOperationKey<Operations>, Required[number]>[],
> = Readonly<{
  required: Required;
  preferred?: Preferred;
}>;

/**
 * Define one descriptor's non-widened required/preferred operation declaration.
 * Runtime validation keeps declarations built from dynamic data fail-closed too.
 */
export function runtimeUse<Operations extends object>() {
  return <
    const Required extends readonly RuntimeOperationKey<Operations>[],
    const Preferred extends readonly Exclude<RuntimeOperationKey<Operations>, Required[number]>[] =
      readonly [],
  >(
    input: RuntimeUseInput<Operations, Required, Preferred>,
  ): RuntimeUse<Operations, Required, Preferred> => {
    const required = freezeUniqueKeys(input.required, 'required');
    const preferred = freezeUniqueKeys(
      input.preferred ?? ([] as unknown as Preferred),
      'preferred',
    );
    const overlap = preferred.find((key) => required.includes(key));
    if (overlap !== undefined) {
      throw new TypeError(`Runtime operation cannot be both required and preferred: ${overlap}`);
    }
    return Object.freeze({ required, preferred }) as RuntimeUse<Operations, Required, Preferred>;
  };
}

function freezeUniqueKeys<Keys extends readonly string[]>(keys: Keys, label: string): Keys {
  const copy = [...keys];
  if (new Set(copy).size !== copy.length) {
    throw new TypeError(`Runtime use contains duplicate ${label} operations`);
  }
  return Object.freeze(copy) as unknown as Keys;
}
