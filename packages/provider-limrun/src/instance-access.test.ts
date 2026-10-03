import { expect, test } from 'vitest';
import { attachedLimrunInstanceId, isAttachedLimrunInstanceId } from './instance-access.ts';

test('names an attached instance stably by its API URL, apart from control-plane ids', () => {
  const apiUrl = 'https://region.limrun.example/v1/ios_attached/api';
  expect(attachedLimrunInstanceId(apiUrl)).toBe(attachedLimrunInstanceId(apiUrl));
  expect(attachedLimrunInstanceId(`${apiUrl}/other`)).not.toBe(attachedLimrunInstanceId(apiUrl));
  expect(isAttachedLimrunInstanceId(attachedLimrunInstanceId(apiUrl))).toBe(true);
  expect(isAttachedLimrunInstanceId('ios_euna_01m414fmjtfzb82wshkbcaa09c')).toBe(false);
});
