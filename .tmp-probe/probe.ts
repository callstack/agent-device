import { listCapabilityCommands, commandRuntimeUseRequirements } from '../src/core/capabilities.ts';
const rows: string[] = [];
for (const c of listCapabilityCommands()) {
  const r = commandRuntimeUseRequirements(c);
  rows.push(`${c}: ${r === undefined ? 'NOT-FACT-OWNED' : JSON.stringify(r)}`);
}
console.log(rows.join('\n'));
