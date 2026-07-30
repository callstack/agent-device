import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertJsonContains } from './live-assertions.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

const C = PUBLIC_COMMANDS;

export async function assertInventoryAndInstall(context: LiveContext): Promise<void> {
  const devices = await runStep(context, 'list Android devices', ['devices']);
  assertJsonContains(
    devices,
    context.serial,
    'device inventory should include selected emulator serial',
  );
  verifyCommand(context, C.devices, 'selected emulator serial appears in typed inventory');

  const capabilities = await runStep(context, 'read Android capabilities', ['capabilities']);
  for (const command of ['click', 'fill', 'snapshot', 'type']) {
    assertJsonContains(capabilities, command, `capabilities should include ${command}`);
  }
  verifyCommand(
    context,
    C.capabilities,
    'typed capability response includes fixture-driving commands',
  );

  const apps = await runStep(context, 'list installed user apps', ['apps']);
  assertJsonContains(apps, context.appId, 'app inventory should include fixture package');
  verifyCommand(context, C.apps, 'installed fixture package appears in app inventory');

  const doctor = await runStep(context, 'doctor fixture package discovery', [
    'doctor',
    '--app',
    context.appId,
  ]);
  assertJsonContains(doctor, context.appId, 'doctor should discover fixture package');
  verifyCommand(context, C.doctor, 'doctor discovers the installed fixture package');
}
