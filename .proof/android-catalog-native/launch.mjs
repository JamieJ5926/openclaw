import assert from 'node:assert/strict';
import fs from 'node:fs';
import {writeControl,reconcilePhase,runManagedCommand,systemdOwner,finalIdentity,WRITE_LIMIT,INITIAL_HOLD} from './phase-owner.mjs';
import {evidenceFiles} from './finalize.mjs';
import {cpuQuotaPercent, inspectHostCpu, requireHostCpuFit, canFinalizeCpuRefusal} from './cpu-admission.mjs';
process.umask(0o077);
const mode=process.argv[2],input=import.meta.dirname,trial=process.env.RUNNER_TEMP+'/android-catalog-native',evidence=trial+'/export';
assert(['run','finish'].includes(mode));
assert.equal(process.env.GITHUB_REPOSITORY,'openclaw/openclaw');
assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1','No automatic replay of an attempted hosted run');
assert(/^\d+$/.test(process.env.GITHUB_RUN_ID));
assert.equal(process.env.RUNNER_OS,'Linux');assert.equal(process.env.RUNNER_ARCH,'X64');
const cancellation=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>cancellation.abort(signal));
let carry=INITIAL_HOLD;

async function phase(name,seconds,operation,network){
  const directory=evidence+'/'+name;fs.mkdirSync(directory);
  if(name==='native'){
    const cpu=inspectHostCpu();
    writeControl(directory+'/cpu-admission.json',cpu);
    requireHostCpuFit(cpu);
  }
  const id='android-catalog-hosted-'+process.env.GITHUB_RUN_ID+'-'+name;
  const plan={id,phase:name,cpuQuotaPercent:cpuQuotaPercent(name),deadline:Date.now()+(seconds+30)*1000,limitBytes:WRITE_LIMIT,prechargedBytes:carry,allOldHoldsRemain:true};
  writeControl(directory+'/plan.json',plan);
  const env={NODE_EXECUTABLE:process.execPath,PATH:process.env.JAVA_HOME_17_X64+'/bin:'+process.env.PATH,JAVA_HOME:process.env.JAVA_HOME_17_X64,HOME:trial+'/home',TMPDIR:trial+'/tmp',TRIAL:trial,EVIDENCE:evidence,INPUT:input,SDK_ROOT:process.env.ANDROID_HOME};
  const properties=['Type=exec','Restart=no','KillMode=control-group','RuntimeMaxSec='+seconds+'s','TimeoutStopSec=15s','MemoryMax=8G','MemorySwapMax=0','CPUQuota='+plan.cpuQuotaPercent+'%','IOAccounting=yes','NoNewPrivileges=yes','WorkingDirectory='+input,'ExecStopPost='+process.execPath+' '+input+'/guard.mjs stop '+directory];
  if(!network)properties.push('PrivateNetwork=yes');
  if(name==='access'||name==='native')properties.push('SupplementaryGroups=kvm');
  const command=['sudo','-n',...(network?['--preserve-env=GH_TOKEN']:[]),'systemd-run','--quiet','--wait','--pipe','--collect','--unit',id,'--uid',String(process.getuid()),...properties.flatMap(v=>['--property',v]),...Object.entries(env).flatMap(([k,v])=>['--setenv',k+'='+v]),...(network?['--setenv=GH_TOKEN']:[]),process.execPath,input+'/guard.mjs','run',directory,...operation];
  writeControl(directory+'/command.json',{command,env,credentialForwarded:network?'ephemeral job token; unset before package setup':'none'});
  const stdout=fs.openSync(directory+'/stdout.txt','wx'),stderr=fs.openSync(directory+'/stderr.txt','wx');
  let result;
  try{
    result=await runManagedCommand(command,{stdout,stderr,signal:cancellation.signal,timeoutMs:(seconds+45)*1000,stop:()=>systemdOwner.stop(id+'.service')});
  }catch(error){result={code:null,error:String(error),clientJoined:false};}
  finally{fs.closeSync(stdout);fs.closeSync(stderr);}
  writeControl(directory+'/launcher.json',result);
  let reconciliation;
  try{reconciliation=await reconcilePhase(directory);}
  catch(error){reconciliation={unit:id+'.service',stopped:false,complete:false,carryBytes:null,lastKnownCarryBytes:carry,unknownCostHoldBytes:WRITE_LIMIT,error:String(error)};}
  if(result?.clientJoined===false){reconciliation.complete=false;reconciliation.carryBytes=null;reconciliation.unknownCostHoldBytes=WRITE_LIMIT;reconciliation.unjoinedLauncherPid=result.clientPid;}
  writeControl(directory+'/reconcile-run.json',reconciliation);
  if(reconciliation.complete)carry=reconciliation.carryBytes;
  return {result,reconciliation};
}

if(mode==='run'){
  assert(process.env.GH_TOKEN);assert(process.env.ANDROID_HOME?.startsWith('/'));assert(process.env.JAVA_HOME_17_X64?.startsWith('/'));
  fs.mkdirSync(trial);for(const name of ['home','tmp','export'])fs.mkdirSync(trial+'/'+name);fs.mkdirSync(evidence+'/public');
  const available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB$/m)[1])*1024,disk=fs.statfsSync(trial),free=disk.bavail*disk.bsize;
  const cpu=inspectHostCpu();
  writeControl(evidence+'/admission.json',{at:new Date().toISOString(),available,freeBytes:free,cpu,runId:process.env.GITHUB_RUN_ID,workflowSha:process.env.GITHUB_WORKFLOW_SHA,source:'575c21f72a45fe6b62c3bf4d8871bfefb772479e'});
  let result={code:0},cpuAdmissionRefused=false;
  try{
    assert(available>=12*1024**3&&free>=32*1024**3,'Hosted memory/disk admission refused');
    cpuAdmissionRefused=cpu.status!=='fit';
    requireHostCpuFit(cpu);
    for(const [name,seconds,operation,network] of [['access',30,['/usr/bin/timeout','20','/usr/bin/perl',input+'/kvm-access-probe.pl'],false],['prepare',900,['/bin/bash',input+'/prepare.sh'],true],['native',600,['/bin/bash',input+'/native.sh'],false]]){
      if(cancellation.signal.aborted)throw Error('Owner interrupted before next phase');
      const finished=await phase(name,seconds,operation,network);
      if(!finished.reconciliation.complete||finished.result.code!==0||finished.result.interrupted)throw Error('Owned phase failed or remains unresolved: '+name);
    }
  }catch(error){result={code:1,error:String(error),cpuAdmissionRefused,interrupted:cancellation.signal.aborted,lastKnownCarryBytes:carry};}
  writeControl(evidence+'/run-result.json',result);process.exitCode=result.code;
}else{
  assert(fs.existsSync(evidence),'No started trial to reconcile; no allocation is permitted');
  assert(!fs.existsSync(evidence+'/identity.json'),'Finalization already recorded; no automatic replay');
  const reconciliations=[];
  for(const name of ['access','prepare','native','finalize'])if(fs.existsSync(evidence+'/'+name+'/plan.json')){
    let current;
    try{current=await reconcilePhase(evidence+'/'+name);}
    catch(error){current={unit:'android-catalog-hosted-'+process.env.GITHUB_RUN_ID+'-'+name+'.service',stopped:false,complete:false,carryBytes:null,lastKnownCarryBytes:carry,unknownCostHoldBytes:WRITE_LIMIT,error:String(error)};}
    const launcher=evidence+'/'+name+'/launcher.json';
    if(!fs.existsSync(launcher)||JSON.parse(fs.readFileSync(launcher)).clientJoined!==true){current.complete=false;current.carryBytes=null;current.unknownCostHoldBytes=WRITE_LIMIT;current.launcherJoin='unconfirmed';}
    writeControl(evidence+'/'+name+'/reconcile-finish.json',current);reconciliations.push(current);
  }
  const runResult=fs.existsSync(evidence+'/run-result.json')?JSON.parse(fs.readFileSync(evidence+'/run-result.json')):{code:1,error:'Outer operation did not record completion'};
  let finalizerResult={code:1,error:'Finalizer not admitted'},fit=null;
  const cpuRefusalBeforeAllocation=canFinalizeCpuRefusal(runResult,reconciliations.map(r=>r.unit));
  if((reconciliations.length||cpuRefusalBeforeAllocation)&&reconciliations.every(r=>r.complete)&&!fs.existsSync(evidence+'/finalize')&&!cancellation.signal.aborted){
    carry=reconciliations.length?Math.max(...reconciliations.map(r=>r.carryBytes)):INITIAL_HOLD;
    if(carry+1048576<WRITE_LIMIT-536870912){
      try{
        const finalized=await phase('finalize',120,[process.execPath,input+'/finalize.mjs'],false);
        finalizerResult=finalized.result;reconciliations.push(finalized.reconciliation);
        if(fs.existsSync(evidence+'/fit.json'))fit=JSON.parse(fs.readFileSync(evidence+'/fit.json'));
        if(fit){
          let finalBytes=65536;
          for await(const file of evidenceFiles(evidence,'',true))finalBytes+=file.bytes;
          fit={...fit,finalBytesWithIdentityReserve:finalBytes,fits:fit.fits&&finalBytes<=fit.limitBytes};
        }
      }catch(error){
        finalizerResult={code:1,error:String(error)};
        if(fs.existsSync(evidence+'/finalize/plan.json')&&!reconciliations.some(r=>r.unit.endsWith('-finalize.service'))){
          try{reconciliations.push(await reconcilePhase(evidence+'/finalize'));}
          catch(stopError){reconciliations.push({unit:'android-catalog-hosted-'+process.env.GITHUB_RUN_ID+'-finalize.service',complete:false,carryBytes:null,lastKnownCarryBytes:carry,unknownCostHoldBytes:WRITE_LIMIT,error:String(stopError)});}
        }
      }
    }
  }
  const identity=finalIdentity({runResult,reconciliations,fit,finalizerResult});
  writeControl(evidence+'/identity.json',{...identity,artifactId:10070823992,apkSha256:'0330ce2a24ccffd84353d71c57e96768b425e5e90fd8de0e49f9f05672119d45',source:'575c21f72a45fe6b62c3bf4d8871bfefb772479e',workflowSha:process.env.GITHUB_WORKFLOW_SHA,
    footerAccounting:'Finite <=64 KiB control records are covered by the retained 128 MiB outer precharge; finalizer writes and tail are measured separately. No evidence files were copied.'});
  process.exitCode=identity.exitCode;
}
