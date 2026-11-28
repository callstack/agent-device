import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { isSauceLabsAppUrl, parseSauceLabsAppReference, readSauceLabsRegion } from './providers.ts';

const FILE_ID = '0b6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

test('the data center comes from SAUCE_REGION, defaulting to us-west-1', () => {
  assert.equal(readSauceLabsRegion({}), 'us-west-1');
  assert.equal(readSauceLabsRegion({ SAUCE_REGION: ' ' }), 'us-west-1');
  assert.equal(readSauceLabsRegion({ SAUCE_REGION: 'EU-Central-1' }), 'eu-central-1');
  assert.equal(readSauceLabsRegion({ SAUCE_REGION: 'us-east-4' }), 'us-east-4');
  assert.throws(
    () => readSauceLabsRegion({ SAUCE_REGION: 'eu-west-1' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'saucelabs_region_unknown' &&
      error.details?.flag === undefined &&
      /SAUCE_REGION/.test(String(error.details?.hint)),
  );
});

test('storage: references parse to their canonical spelling, and other values are not references', () => {
  assert.deepEqual(parseSauceLabsAppReference(`Storage:${FILE_ID}`), {
    kind: 'file-id',
    reference: `storage:${FILE_ID}`,
    fileId: FILE_ID,
  });
  assert.deepEqual(parseSauceLabsAppReference('storage:filename=app release.apk'), {
    kind: 'filename',
    reference: 'storage:filename=app release.apk',
    filename: 'app release.apk',
  });
  assert.equal(parseSauceLabsAppReference('./app.apk'), undefined);
  assert.equal(parseSauceLabsAppReference('https://example.test/app.apk'), undefined);
  for (const app of ['storage:', 'storage:abc', 'storage:filename=', 'storage:filename=a/b.apk']) {
    assert.throws(
      () => parseSauceLabsAppReference(app),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'saucelabs_app_reference_invalid',
      app,
    );
  }
});

test('only an https app URL is a URL; plain http is refused with a typed reason', () => {
  assert.equal(isSauceLabsAppUrl('https://example.test/app.apk'), true);
  assert.equal(isSauceLabsAppUrl('./app.apk'), false);
  assert.throws(
    () => isSauceLabsAppUrl('http://example.test/app.apk'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'saucelabs_app_url_insecure',
  );
});
