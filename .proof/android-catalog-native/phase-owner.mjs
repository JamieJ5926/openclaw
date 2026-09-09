import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

export const WRITE_LIMIT=88*1024**3;
export const PRIOR_HOSTED_CARRY=81657217024;
export const INITIAL_HOLD=PRIOR_HOSTED_CARRY+128*1024**2;
const CONTROL_LIMIT=65536;
export function writeControl(path,value){
  const data=JSON.stringify(value,null,2)+'\n';
  if(Buffer.byteLength(data)>CONTROL_LIMIT)throw Error('Control receipt exceeds its precharged bound');
  fs.writeFileSync(path,data,{flag:'wx',mode:0o600});
}
function systemctl(args){
  const r=spawnSync('sudo',['-n','systemctl',...args],{encoding:'utf8',timeout:3000,maxBuffer:16384});
  return {status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout??'',stderr:r.stderr??''};
}
export const systemdOwner={
  now:()=>Date.now(),
  wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  stop:async unit=>systemctl(['stop','--no-block',unit]),
  inspect:async unit=>{
    const result=systemctl(['show',unit,'--property=LoadState,ActiveState,SubState,MainPID']);
    const fields=Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
    const cgroup='/sys/fs/cgroup/system.slice/'+unit;
    const absent=!fs.existsSync(cgroup);
    const known=!result.error&&(fields.LoadState==='not-found'||(result.status===0&&['inactive','failed'].includes(fields.ActiveState)&&fields.MainPID==='0'));
    return {at:new Date().toISOString(),result,fields,cgroup,absent,quiescent:known&&absent};
  }
};

export async function reconcilePhase(directory,owner=systemdOwner){
  const plan=JSON.parse(fs.readFileSync(directory+'/plan.json'));
  if(!/^android-catalog-hosted-\d+-(access|prepare|native|finalize)$/.test(plan.id))throw Error('Unexpected owned unit identity');
  const unit=plan.id+'.service',observations=[];
  let observed=await owner.inspect(unit),stop=null;
  observations.push(observed);
  if(!observed.quiescent){
    stop=await owner.stop(unit);
    const deadline=owner.now()+30000;
    do{
      await owner.wait(500);observed=await owner.inspect(unit);observations.push(observed);
    }while(!observed.quiescent&&owner.now()<deadline);
  }
  let terminal=null,knownCarry=null,receiptError=null;
  try{
    terminal=JSON.parse(fs.readFileSync(directory+'/terminal.json'));
    if(terminal.cgroup!=='/sys/fs/cgroup/system.slice/'+unit)throw Error('Stop receipt belongs to another unit');
    if(!terminal.stopped||terminal.remainingPids.length)throw Error('Missing empty stopped group proof');
    if(terminal.accountingStatus!=='complete'||terminal.samplingError||Object.keys(terminal.errors).length)throw Error('Final writer accounting is unavailable');
    let maximum=terminal.charge.chargedBytes;
    const input=createInterface({input:fs.createReadStream(directory+'/resources.jsonl'),crlfDelay:Infinity});
    for await(const line of input)if(line.trim())maximum=Math.max(maximum,JSON.parse(line).charge.chargedBytes);
    knownCarry=maximum+terminal.tailHoldBytes;
  }catch(error){receiptError=String(error);}
  const stopped=observed.quiescent&&terminal?.cgroup==='/sys/fs/cgroup/system.slice/'+unit&&terminal.stopped===true&&terminal.remainingPids.length===0;
  const complete=stopped&&knownCarry!==null;
  return {unit,stopped,groupAbsent:observed.absent,complete,carryBytes:complete?knownCarry:null,lastKnownCarryBytes:plan.prechargedBytes,unknownCostHoldBytes:complete?null:WRITE_LIMIT,receiptError,stop,observations,terminal};
}

export async function runManagedCommand(command,{stdout,stderr,signal,timeoutMs,stop}){
  let child,joined=false;
  const completed=new Promise(resolve=>{
    child=spawn(command[0],command.slice(1),{stdio:['ignore',stdout,stderr]});
    child.once('error',error=>{joined=true;resolve({code:null,signal:null,error:String(error),clientJoined:true});});
    child.once('close',(code,childSignal)=>{joined=true;resolve({code,signal:childSignal,clientJoined:true});});
  });
  let cancel,deadline;
  const interrupted=new Promise(resolve=>{
    cancel=()=>resolve({interrupted:true,reason:String(signal.reason??'owner interrupted')});
    signal.addEventListener('abort',cancel,{once:true});
    deadline=setTimeout(()=>resolve({interrupted:true,reason:'managed launcher deadline'}),timeoutMs);
    if(signal.aborted)cancel();
  });
  let result=await Promise.race([completed,interrupted]);
  clearTimeout(deadline);signal.removeEventListener('abort',cancel);
  if(result.interrupted){
    const stopResult=await stop();
    let timer;
    const joinedResult=await Promise.race([completed,new Promise(resolve=>{timer=setTimeout(()=>resolve({clientJoined:false}),10000);})]);
    clearTimeout(timer);result={...result,...joinedResult,stopResult};
    // A service owns workload lifetime. A client that cannot join remains
    // explicit evidence; it cannot establish a stopped service or a final cost.
    if(!joined){child.unref();result.clientPid=child.pid;}
  }
  return result;
}

export function finalIdentity({runResult,reconciliations,fit,finalizerResult}){
  const unknown=reconciliations.some(r=>!r.complete)||reconciliations.length===0;
  const finalized=finalizerResult?.code===0&&finalizerResult?.interrupted!==true;
  const failed=runResult?.code!==0||runResult?.interrupted===true||unknown||fit?.fits!==true||!finalized;
  return {at:new Date().toISOString(),exitCode:failed?1:0,completeExport:!unknown&&fit?.fits===true&&finalized,
    carryBytes:unknown?null:Math.max(...reconciliations.map(r=>r.carryBytes)),
    lastKnownCarryBytes:Math.max(INITIAL_HOLD,...reconciliations.map(r=>r.carryBytes??r.lastKnownCarryBytes)),
    unknownCostHoldBytes:unknown?WRITE_LIMIT:null,
    lifecycle:unknown?'unresolved; retained files are a partial snapshot':'all owned groups stopped with complete accounting',
    exportFit:fit??null,runResult,finalizerResult,
    semanticAcceptance:'pending independent judgment; collection exit is not a product verdict'};
}
