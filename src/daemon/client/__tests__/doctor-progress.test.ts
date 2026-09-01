import assert from 'node:assert/strict';
import { test } from 'vitest';
import { consumeDoctorProgressRendered, markDoctorProgressRendered } from '../doctor-progress.ts';

test('doctor progress marker is consumed once', () => {
  assert.equal(consumeDoctorProgressRendered(), false);
  markDoctorProgressRendered();
  assert.equal(consumeDoctorProgressRendered(), true);
  assert.equal(consumeDoctorProgressRendered(), false);
});
