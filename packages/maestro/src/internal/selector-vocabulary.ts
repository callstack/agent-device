import type { MaestroSelectorMap } from './program-ir.ts';

export const MAESTRO_BASE_SELECTOR_KEYS = [
  'id',
  'text',
  'enabled',
  'selected',
  'index',
  'childOf',
  'containsChild',
  'containsDescendants',
] as const;
const MAESTRO_TEXT_SELECTOR_KEYS = ['id', 'text'] as const;
const MAESTRO_STATE_SELECTOR_KEYS = ['enabled', 'selected'] as const;

/**
 * The vocabulary an `exportReplayActionsToMaestro` caller projects an
 * agent-device selector expression into. Which keys Maestro understands is
 * this package's knowledge, so the caller supplying `resolveSelector` reads
 * the vocabulary from here rather than restating the key lists at its own call
 * site — where nothing would keep the two copies in step.
 */
export const MAESTRO_SELECTOR_PROJECTION = {
  textKeys: MAESTRO_TEXT_SELECTOR_KEYS,
  booleanKeys: MAESTRO_STATE_SELECTOR_KEYS,
  textAliases: { label: 'text' },
} as const;

export type MaestroSelectorKey = keyof MaestroSelectorMap;
