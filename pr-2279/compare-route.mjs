import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repoRoot, outputDir, state = 'warm', screenList = 'quiet,list,nested-scroll,alert,system-surface,xctest-stress'] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(path.join(repoRoot, 'scripts/ios-snapshot-benchmark', name + '.ts')));
const command = await load('command');
const cli = await load('cli-process');
const admission = await load('cell-admission');
const lifecycle = await load('lifecycle');
const { closeSession } = await load('local-runner');
const { createBenchmarkStateRoot } = await load('state-ownership');
const { screenFixture, CONTRACT } = await load('definitions');
const { readGitRevision, readHostIdentity, readTarget, readToolchain } = await load('host');
const { buildMeasurement } = await load('statistics');
const { assertValidRawResult } = await load('schema');
const { runDeepButtonControls } = await load('deep-control');
const udid = '37F019DC-2BEE-4239-AEEF-A9BAA0166177';
const screens = screenList.split(',');
const stateDir = createBenchmarkStateRoot();
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'state-dir.txt'), stateDir);
const revision = readGitRevision(repoRoot);
if (revision.dirty) throw new Error('Benchmark requires a clean source revision');
const result = {
  schemaVersion: 'ios-snapshot-convergence.v1', issue: CONTRACT.issue, parent: CONTRACT.parent,
  references: CONTRACT.references, runId: `pr2279-${Date.now()}`, generatedAt: new Date().toISOString(),
  revision, toolchain: readToolchain(), host: readHostIdentity(),
  target: readTarget(udid, 'com.callstack.agentdevicelab'),
  config: { warmSampleMinimum:20, coldSampleMinimum:10, requestedSamples:20, screens, states:[state] },
  packageSize: {status:'not-run', revision:revision.commit}, deepButtonEvidence:runDeepButtonControls(repoRoot),
  measurements: [], status:'completed',
};
const observations = [];
const stops = [];
const write = () => {
  assertValidRawResult(result);
  fs.writeFileSync(path.join(outputDir, 'samples.json'), JSON.stringify(result,null,2)+'\n');
  fs.writeFileSync(path.join(outputDir, 'observations.json'), JSON.stringify(observations,null,2)+'\n');
  fs.writeFileSync(path.join(outputDir, 'stops.json'), JSON.stringify(stops,null,2)+'\n');
};
for (const screen of screens) {
  const fixture = screenFixture(screen);
  const options = { repoRoot,stateDir,derivedPath:path.join(stateDir,'derived'),udid,fixtures:[fixture],fixture,states:[state],state,samples:20 };
  const context = {repoRoot,stateDir,session:`pr2279-${state}-${screen}`,udid,derivedPath:path.join(stateDir,'derived',state,screen)};
  console.log(new Date().toISOString(), 'START', revision.commit.slice(0,10),state,screen);
  const samples=[];
  try {
    admission.prepareCellState(options);
    let pid = await admission.admitReadyCell(context, options);
    // Retain the full public output as proof of which source actually published.
    const initial = cli.runCli(context,['snapshot','-i','--debug']);
    const initialRequestId = initial.stderr.match(/\"requestId\":\"([a-f0-9]+)\"/)?.[1];
    if (initialRequestId) {
      const requestLog = path.join(stateDir,'sessions',context.session,'requests',initialRequestId+'.ndjson');
      if(fs.existsSync(requestLog)) fs.copyFileSync(requestLog,path.join(outputDir,screen+'-initial.ndjson'));
    }
    observations.push({screen,phase:'initial',result:initial}); write();
    for(let index=0; index<20; index++) {
      if(index>0) admission.prepareSampleState(options);
      const capture = state==='warm' ? command.snapshotFixture(context) : command.openFixture(context,fixture,{relaunch:true});
      observations.push({screen,index:index+1,phase:'sample',result:capture});
      samples.push(command.sampleFromCli(capture,state==='warm'?'snapshot':'relaunch-foreground',index));
      if(capture.ok) {
        pid = await admission.admitSuccessfulSample(context,options,capture,pid);
        admission.cleanupSuccessfulSample(context,options);
      }
      write();
      console.log(new Date().toISOString(),screen,index+1,capture.ok,Math.round(capture.wallClockMs));
    }
    result.measurements.push(buildMeasurement({transport:'local',execution:'fresh-process-cli',state,screen,sampleMinimum:20,operation:state==='warm'?'snapshot':'relaunch-foreground',samples}));
  } catch(error) {
    const category = error instanceof lifecycle.BenchmarkContentionError ? 'contention' : error instanceof lifecycle.BenchmarkInfrastructureError ? 'infrastructure' : 'configuration';
    stops.push({screen,category,message:error.message,stack:error.stack,reason:error.reason,command:error.command});
    result.status='stopped';
    result.stop={category,message:error.message.slice(0,2000),...(error.reason?{reason:error.reason}:{}),...(error.command?{command:error.command}:{})};
    console.log(new Date().toISOString(),'STOP',screen,error.message);
  } finally {
    closeSession(context);
    lifecycle.stopDaemon(repoRoot,stateDir);
    write();
  }
}
console.log('COMPLETE',JSON.stringify(result.measurements.map(m=>({screen:m.screen,failures:m.failures,wall:m.wallClockMs?.median,daemon:m.daemonDurationMs?.median}))),JSON.stringify(stops));
if(stops.length) process.exitCode=2;
