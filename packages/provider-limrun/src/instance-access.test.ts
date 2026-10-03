import { expect, test } from 'vitest';
import { attachedLimrunInstanceId } from './instance-access.ts';

test('names an attached instance stably by its API URL', () => {
  const apiUrl = 'https://region.limrun.example/v1/ios_attached/api';
  expect(attachedLimrunInstanceId(apiUrl)).toBe(attachedLimrunInstanceId(apiUrl));
  expect(attachedLimrunInstanceId(apiUrl)).toMatch(/^attached-[a-f0-9]{12}$/);
  expect(attachedLimrunInstanceId(`${apiUrl}/other`)).not.toBe(attachedLimrunInstanceId(apiUrl));
});
