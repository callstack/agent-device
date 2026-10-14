export const MUTATION_SEED_ENV = 'AGENT_DEVICE_MUTATION_SEED';

export function mutationSeed(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seed) || seed > 2_147_483_647)
    throw new Error('Mutation seed must be an integer between 0 and 2147483647');
  return seed;
}
