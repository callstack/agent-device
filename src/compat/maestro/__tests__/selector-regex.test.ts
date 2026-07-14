import { expect, test } from 'vitest';
import { literalFromMaestroRegex, matchesMaestroRegex } from '../selector-regex.ts';

test('matches Maestro regex as case-insensitive full patterns', () => {
  expect(matchesMaestroRegex('Item 22\nready', 'item \\d{2}.+ready')).toBe(true);
  expect(matchesMaestroRegex('Item 22 ready later', 'Item 22 ready')).toBe(false);
  expect(matchesMaestroRegex('Item [ready', 'item [ready')).toBe(true);
});

test('extracts only patterns that are exact literals', () => {
  expect(literalFromMaestroRegex('checkout-submit')).toBe('checkout-submit');
  expect(literalFromMaestroRegex('price\\.usd')).toBe('price.usd');
  expect(literalFromMaestroRegex('item \\d{2}')).toBeUndefined();
  expect(literalFromMaestroRegex('item [ready')).toBe('item [ready');
});
