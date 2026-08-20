import type { RuntimeOperationKey, RuntimeUse, RuntimeUseDeclaration } from './platform-runtime.ts';

export function runtimeUseIdentity(use: RuntimeUseDeclaration): string {
  return JSON.stringify({
    required: [...use.required].sort(),
    preferred: [...use.preferred].sort(),
    conditional: [...(use.conditional ?? [])].sort(),
  });
}

type RuntimeUseInput<
  Operations extends object,
  Required extends readonly RuntimeOperationKey<Operations>[],
  Preferred extends readonly Exclude<RuntimeOperationKey<Operations>, Required[number]>[],
  Conditional extends readonly Exclude<
    RuntimeOperationKey<Operations>,
    Required[number] | Preferred[number]
  >[],
> = Readonly<{
  required: Required;
  preferred?: Preferred;
  conditional?: Conditional;
}>;

/**
 * Define one descriptor's non-widened required/preferred/conditional operation declaration.
 * Runtime validation keeps declarations built from dynamic data fail-closed too.
 */
export function runtimeUse<Operations extends object>() {
  return <
    const Required extends readonly RuntimeOperationKey<Operations>[],
    const Preferred extends readonly Exclude<RuntimeOperationKey<Operations>, Required[number]>[] =
      readonly [],
    const Conditional extends readonly Exclude<
      RuntimeOperationKey<Operations>,
      Required[number] | Preferred[number]
    >[] = readonly [],
  >(
    input: RuntimeUseInput<Operations, Required, Preferred, Conditional>,
  ): RuntimeUse<Operations, Required, Preferred, Conditional> => {
    const required = freezeUniqueKeys(input.required, 'required');
    const preferred = freezeUniqueKeys(
      input.preferred ?? ([] as unknown as Preferred),
      'preferred',
    );
    const conditional = freezeUniqueKeys(
      input.conditional ?? ([] as unknown as Conditional),
      'conditional',
    );
    const categories: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['required', required],
      ['preferred', preferred],
      ['conditional', conditional],
    ];
    for (let leftIndex = 0; leftIndex < categories.length; leftIndex += 1) {
      const left = categories[leftIndex];
      if (!left) continue;
      for (const right of categories.slice(leftIndex + 1)) {
        const overlap = right[1].find((key) => left[1].includes(key));
        if (overlap !== undefined) {
          throw new TypeError(
            `Runtime operation cannot be both ${left[0]} and ${right[0]}: ${overlap}`,
          );
        }
      }
    }
    return Object.freeze(
      conditional.length === 0 ? { required, preferred } : { required, preferred, conditional },
    ) as RuntimeUse<Operations, Required, Preferred, Conditional>;
  };
}

function freezeUniqueKeys<Keys extends readonly string[]>(keys: Keys, label: string): Keys {
  const copy = [...keys];
  if (new Set(copy).size !== copy.length) {
    throw new TypeError(`Runtime use contains duplicate ${label} operations`);
  }
  return Object.freeze(copy) as unknown as Keys;
}
