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
  // Each ui_act tap waits for the screen to settle, so two of them never make a double tap.
  expect(interactor.doubleTap).toBeUndefined();
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
    ['hold @5,6 0.8'],
    ['hold @5,6 2.5'],
    [String.raw`type "héllo \"x\""`],
    ['fill @20,200 "gary@example.com"'],
    ['scroll down'],
    ['back'],
    ['home'],
  ]);
});

test('apps open with their launch arguments, deep links open, and close is app_control', async () => {
  const { interactor, apps } = await setup();
  await interactor.open('dev.simtap.demo');
  await interactor.open('myapp://item/3');
  await interactor.open('dev.simtap.demo', { url: 'myapp://settings' });
  await interactor.open('dev.simtap.demo', { launchArgs: ['-Step', '3', '-Greeting', "it's on"] });
  await interactor.close('dev.simtap.demo');
  expect(apps()).toEqual([
    { action: 'launch', app: 'dev.simtap.demo' },
    { action: 'open_url', value: 'myapp://item/3' },
    { action: 'launch', app: 'dev.simtap.demo' },
    { action: 'open_url', value: 'myapp://settings' },
    { action: 'launch', app: 'dev.simtap.demo', value: "-Step 3 -Greeting 'it'\\''s on'" },
    { action: 'terminate', app: 'dev.simtap.demo' },
  ]);
});

test('close reports a phone that could not stop the app instead of passing for success', async () => {
  const { interactor } = await setup({
    app_control: () => ({
      text: 'Could not stop dev.simtap.demo: the Simulator is gone.',
      isError: true,
    }),
  });
  await expect(interactor.close('dev.simtap.demo')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
});

test('a delay the phone cannot honor is refused, and a slow type says how far it got', async () => {
  let calls = 0;
  const { interactor, steps } = await setup({
    ui_act: () =>
      ++calls === 3 ? { text: 'The field is gone.', isError: true } : { text: 'done' },
  });
  await expect(interactor.fill(20, 200, 'x', 50)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  await expect(interactor.scroll('down', { pixels: 200 })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  await expect(interactor.type('abcd', 1)).rejects.toMatchObject({
    details: { dispatchedSteps: 2 },
  });
  expect(steps()).toEqual([['type "a"'], ['type "b"'], ['type "c"']]);
  await expect(interactor.screenshot('/tmp/never.png', { pixelDensity: 3 })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
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

test('a screenshot is written as a PNG; a clean status bar is set for it and cleared after', async () => {
  const { interactor, apps } = await setup();
  const out = path.join(mkdtempForTestSync('nomac-shot-'), 'nested', 'shot.png');
  await interactor.screenshot(out);
  expect(fs.readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
  await interactor.screenshot(out, { normalizeStatusBar: true });
  expect(apps()).toEqual([
    { action: 'status_bar', value: 'clean' },
    { action: 'status_bar', value: 'clear' },
  ]);
});
