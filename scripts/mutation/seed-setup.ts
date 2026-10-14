import { mutationSeed, MUTATION_SEED_ENV } from './seed.ts';

const seed = mutationSeed(process.env[MUTATION_SEED_ENV]);
if (seed !== undefined) {
  const { default: fc } = await import('fast-check');
  fc.configureGlobal({ seed });
}
