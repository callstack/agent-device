export { findNodeByLabel, resolveRefLabel } from '../../../snapshot/snapshot-processing.ts';

export function shouldScopeFind(locator: string): boolean {
  return locator === 'text' || locator === 'label' || locator === 'any';
}
