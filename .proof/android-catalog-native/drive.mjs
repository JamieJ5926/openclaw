import fs from 'node:fs';
import {readFixtureEndpoint} from './fixture-endpoint.mjs';
import {execFileSync} from 'node:child_process';
import {nodes, point, applicationNodes, createStartupRecovery} from './startup-surface.mjs';
const out=process.env.EVIDENCE+'/public';
let sequence=0, lastCapture=null, startupDeadline=null, startupComplete=false;
function commandTimeout(maximum=15000){
  if(startupDeadline===null)return maximum;
  const remaining=startupDeadline-Date.now();
  if(remaining<=0)throw Error('Startup deadline expired');
  return Math.min(maximum,remaining);
}
const adb=(...args)=>execFileSync('adb',['-s','emulator-5554',...args],{timeout:commandTimeout()});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const record=(event,data)=>fs.appendFileSync(out+'/actions.jsonl',JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');
function capture(label){
  const name=String(++sequence).padStart(3,'0')+'-'+label;
  fs.writeFileSync(out+'/'+name+'.png',adb('exec-out','screencap','-p'),{flag:'wx'});
  adb('shell','uiautomator','dump','/sdcard/catalog-window.xml');
  const xml=adb('exec-out','cat','/sdcard/catalog-window.xml').toString();
  fs.writeFileSync(out+'/'+name+'.xml',xml,{flag:'wx'});
  lastCapture=name;record('capture',{name});
  if(startupComplete)applicationNodes(xml);
  return xml;
}
async function expect(label){
  const end=Date.now()+30000;
  while(Date.now()<end){
    adb('shell','uiautomator','dump','/sdcard/catalog-window.xml');
    const xml=adb('exec-out','cat','/sdcard/catalog-window.xml').toString();
    if(startupComplete)applicationNodes(xml);
    if(nodes(xml).some(n=>n.text===label||n['content-desc']===label))return capture('observed');
    await wait(500);
  }
  capture('missing-surface');throw Error('Expected app control not observed: '+label);
}
async function tap(label,xml){
  if(!xml)await expect(label);
  xml=capture('before-app-tap');
  if(label==='Test connection')record('fixture-endpoint-readback',{capture:lastCapture,...readFixtureEndpoint(xml)});
  const matches=nodes(xml).filter(n=>(n.text===label||n['content-desc']===label)&&n.enabled==='true');
  const unique=new Map(matches.map(n=>[n.bounds,n]));if(unique.size!==1)throw Error('Ambiguous or disabled control: '+label);
  const xy=point([...unique.values()][0]);record('tap',{label,xy});adb('shell','input','tap',...xy);await wait(300);
}
function typeField(index,text){
  const xml=capture('before-field'),fields=nodes(xml).filter(n=>n.class==='android.widget.EditText');
  if(!fields[index])throw Error('Expected manual setup field absent');
  const xy=point(fields[index]);record('type-fixture-field',{index,value:index===2?'[synthetic fixture token]':text,xy});
  adb('shell','input','tap',...xy);adb('shell','input','text',text);adb('shell','input','keyevent','KEYCODE_BACK');
}
async function startupWelcome(){
  const recovery=createStartupRecovery();
  let usedWait=false,sawDialog=false;
  startupDeadline=Date.now()+30000;
  try{
    while(Date.now()<startupDeadline){
      let xml=capture('startup');
      let action=recovery.observe(xml);
      if(action.action==='diagnose'){
        sawDialog=true;
        record('startup-dialog-diagnostics',{capture:lastCapture,deadline:startupDeadline});
        execFileSync(process.execPath,[process.env.INPUT+'/diagnose-native.mjs','startup-recovery'],{timeout:commandTimeout(25000),stdio:'inherit'});
        xml=capture('startup-before-wait');
        action=recovery.afterDiagnostics(xml);
        if(action.action==='wait'){
          commandTimeout();
          usedWait=true;
          record('startup-platform-wait',{capture:lastCapture,title:action.title,button:action.button,xy:action.xy,deadline:startupDeadline,diagnostics:'diagnostic-startup-recovery.json'});
          adb('shell','input','tap',...action.xy);
          await wait(300);
          continue;
        }
      }
      if(action.action==='welcome'){
        record(usedWait?'startup-recovery-cleared':'startup-recovery-not-needed',{capture:lastCapture,sawDialog,usedWait});
        startupComplete=true;
        return xml;
      }
      await wait(500);
    }
    throw Error('Startup welcome did not become available within the existing 30-second deadline');
  }finally{startupDeadline=null;}
}
try{
  await tap('Continue',await startupWelcome());
  await tap('Set up manually');
  await expect('Manual setup');typeField(0,'127.0.0.1');typeField(2,'fixture-android-catalog');
  await tap('Test connection');
  await tap('Continue',await expect('Gateway paired'));
  await tap('Continue',await expect('Only enable access you are comfortable letting OpenClaw use while this phone is connected. You can change these later in Android Settings.'));
  await tap('Show Sidebar');await tap('Settings');
  await tap('Providers & Models');
  await expect('Refresh');capture('initial-catalog');
  const response=await fetch('http://127.0.0.1:18789/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'failed'})});
  if(!response.ok)throw Error('Fixture control refused');record('fixture-control',await response.json());
  await tap('Refresh');await expect('Refresh');
  capture('after-failed-refresh');
  // Capture below the fold without asserting a producer-selected success verdict.
  capture('before-app-scroll');
  record('swipe',{from:[540,1500],to:[540,500]});adb('shell','input','swipe','540','1500','540','500','400');
  await wait(500);capture('after-failed-refresh-lower');
  record('sequence-complete',{semanticVerdict:'not assigned; inspect complete UI and wire observations'});
}catch(error){
  process.exitCode=1;
  record('sequence-stopped',{error:String(error)});
  try{capture('stop');}
  catch(captureError){record('stop-capture-failed',{error:String(captureError)});}
}
