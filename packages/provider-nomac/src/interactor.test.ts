import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { NomacClient } from './client.ts';
import { fakeNomac } from './fake-nomac.fixtures.ts';
import { createNomacIosInteractor } from './interactor.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

async function setup(toolAnswers?: NonNullable<Parameters<typeof fakeNomac>[0]>['toolAnswers']) {
  const nomac = fakeNomac({ toolAnswers });
  const client = new NomacClient({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: nomac.fetch,
  });
  const phone = await client.startPhone('agent-device-lease-i', {});
  const steps = () =>
    nomac.seen.filter((r) => r.path.endsWith('/tools/ui_act')).map((r) => r.body.steps);
  const apps = () =>
    nomac.seen.filter((r) => r.path.endsWith('/tools/app_control')).map((r) => r.body);
  return {
    interactor: createNomacIosInteractor({ client, phoneId: phone.id }),
    steps,
    apps,
    nomac,
  };
}

test('touches and text are ui_act steps at points, with text JSON-quoted', async () => {
  const { interactor, steps } = await setup();
  await interactor.tap(201, 350.5);
  await interactor.doubleTap!(10, 20);
  await interactor.longPress(5, 6);
  await interactor.longPress(5, 6, 2500);
  await interactor.type('héllo "x"');
  expect(await interactor.fill(20, 200, 'gary@example.com')).toEqual({
    textEntryReadiness: 'focused-element',
  });
  await interactor.scroll('down');
  await interactor.back!();
  await interactor.home!();
  expect(steps()).toEqual([
    ['tap @201,350.50'],
    ['tap @10,20', 'tap @10,20'],
    ['hold @5,6 0.8'],
    ['hold @5,6 2.5'],
    [String.raw`type "héllo \"x\""`],
    ['fill @20,200 "gary@example.com"'],
    ['scroll down'],
    ['back'],
    ['home'],
  ]);
});

test('apps open, deep links open, and close is app_control; launch arguments are refused plainly', async () => {
  const { interactor, apps } = await setup();
  await interactor.open('dev.simtap.demo');
  await interactor.open('myapp://item/3');
  await interactor.open('dev.simtap.demo', { url: 'myapp://settings' });
  await interactor.close('dev.simtap.demo');
  expect(apps()).toEqual([
    { action: 'launch', app: 'dev.simtap.demo' },
    { action: 'open_url', value: 'myapp://item/3' },
    { action: 'launch', app: 'dev.simtap.demo' },
    { action: 'open_url', value: 'myapp://settings' },
    { action: 'terminate', app: 'dev.simtap.demo' },
  ]);
  await expect(interactor.open('dev.simtap.demo', { launchArgs: ['-flag'] })).rejects.toMatchObject(
    { code: 'UNSUPPORTED_OPERATION' },
  );
});

test("a step the phone refuses fails in the phone's own words", async () => {
  const { interactor } = await setup({
    ui_act: () => ({
      text: 'No element at @900,900: the screen is 402 x 874 points.',
      isError: true,
    }),
  });
  await expect(interactor.tap(900, 900)).rejects.toSatisfy(
    (e) =>
      e instanceof AppError &&
      e.code === 'COMMAND_FAILED' &&
      /No element at @900,900/.test(e.message),
  );
});

test('a screenshot is written as a PNG', async () => {
  const { interactor } = await setup();
  const out = path.join(mkdtempForTestSync('nomac-shot-'), 'nested', 'shot.png');
  await interactor.screenshot(out);
  expect(fs.readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
});
