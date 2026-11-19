#!/usr/bin/env node
// fallow-ignore-file unused-file

const args = process.argv.slice(2);
const required = [
  'apps.foreground',
  'apps.launch',
  'apps.open_url',
  'apps.terminate',
  'device.info',
  'device.screen',
  'input.double_tap',
  'input.long_press',
  'input.swipe',
  'input.tap',
  'input.type',
  'ui.tap_element',
  'ui.tree',
];

if (args.join(' ') === 'vm list') {
  process.stdout.write(JSON.stringify([{ name: 'machine-a', state: 'running', udid: 'udid-a' }]));
} else if (args[0] === 'guest' && args[1] === 'rpc' && args[2] === 'machine-a') {
  const method = args[3];
  const result =
    method === 'methods.list'
      ? { methods: required.map((name) => ({ name })) }
      : method === 'apps.foreground'
        ? { bundle_id: 'com.example.app', verified: true, pid: 123 }
        : method === 'device.screen'
          ? { width: 390, height: 844, scale: 3 }
          : method === 'ui.tree'
            ? { elements: [] }
            : {};
  process.stdout.write(JSON.stringify({ ok: true, result }));
} else {
  process.stderr.write('unexpected fixture invocation');
  process.exitCode = 1;
}
