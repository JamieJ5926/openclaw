import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const label=process.argv[2];assert(['before-app','startup-recovery','after-app'].includes(label));
const out=process.env.EVIDENCE+'/public',prefix=out+'/diagnostic-'+label;
const rawGroup=fs.readFileSync('/proc/self/cgroup','utf8');
const group=rawGroup.trim().split('\n').find(line=>line.startsWith('0::'))?.slice(3);
assert(/^[/]system[.]slice[/]android-catalog-hosted-[0-9]+-native[.]service$/.test(group));
const counters={};for(const name of ['cpu.stat','memory.events'])counters[name]=fs.readFileSync('/sys/fs/cgroup'+group+'/'+name,'utf8');
const commands=[['logcat',['logcat','-d','-v','time']],['system-ui-memory',['shell','dumpsys','meminfo','--local','com.android.systemui']]];
const results=[];
for(const [name,args] of commands){
 const stdout=prefix+'-'+name+'.stdout.txt',stderr=prefix+'-'+name+'.stderr.txt';
 const outfd=fs.openSync(stdout,'wx'),errfd=fs.openSync(stderr,'wx'),startedAt=new Date().toISOString();
 const r=spawnSync('adb',['-s','emulator-5554',...args],{stdio:['ignore',outfd,errfd],timeout:10000});
 fs.closeSync(outfd);fs.closeSync(errfd);
 results.push({name,command:['adb','-s','emulator-5554',...args],startedAt,finishedAt:new Date().toISOString(),status:r.status,signal:r.signal,error:r.error?.message,stdout,stderr});
}
fs.writeFileSync(prefix+'.json',JSON.stringify({at:new Date().toISOString(),label,cgroup:rawGroup,counters,results,scope:'Read-only diagnostic from this disposable emulator and native service; no log clearing, settings, dialog response or acceptance judgment.'},null,2)+'\n',{flag:'wx'});
if(results.some(r=>r.status!==0))process.exitCode=1;
