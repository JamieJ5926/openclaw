import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createCaptureOwner, createAdbExecutor} from './capture-owner.mjs';
import {createStartupWelcome} from './startup-welcome.mjs';
import {readFixtureEndpoint} from './fixture-endpoint.mjs';
import {nodes, point, applicationNodes} from './startup-surface.mjs';

const out = process.env.EVIDENCE + '/public';
const preflight = JSON.parse(fs.readFileSync(out + '/capture-preflight.json'));
if (preflight.serial !== 'emulator-5554' || preflight.shellExitCode !== 42 || preflight.helpExitCode !== 0) throw Error('Missing current capture transport admission');
const startup = createStartupWelcome();
const owner = createCaptureOwner({directory: out, execute: createAdbExecutor({temporaryDirectory: process.env.TMPDIR}), timeout: () => startup.commandTimeout(), nonce: preflight.nonce});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (event, data) => fs.appendFileSync(out + '/actions.jsonl', JSON.stringify({at: new Date().toISOString(), event, ...data}) + '\n');
function currentXml(observation) {
  const xml = owner.requireCurrent(observation);
  if (startup.complete) applicationNodes(xml);
  return xml;
}
function capture(label) {
  const observation = owner.observe(label, {screenshot: true});
  currentXml(observation);
  record('capture', {name: observation.id});
  return observation;
}
async function expect(label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const observation = owner.observe('expect');
    const xml = currentXml(observation);
    if (nodes(xml).some(node => node.text === label || node['content-desc'] === label)) {
      record('observed-label', {label, observation: observation.id});
      return observation;
    }
    await wait(500);
  }
  capture('missing-surface');
  throw Error('Expected app control not observed: ' + label);
}
async function tap(label, observed) {
  if (!observed) await expect(label);
  const observation = capture('before-app-tap'), xml = currentXml(observation);
  if (label === 'Test connection') record('fixture-endpoint-readback', {capture: observation.id, ...readFixtureEndpoint(xml)});
  const matches = nodes(xml).filter(node => (node.text === label || node['content-desc'] === label) && node.enabled === 'true');
  const unique = new Map(matches.map(node => [node.bounds, node]));
  if (unique.size !== 1) throw Error('Ambiguous or disabled control: ' + label);
  const xy = point([...unique.values()][0]);
  record('tap', {label, xy, observation: observation.id});
  owner.input(observation, ['input', 'tap', ...xy]);
  await wait(300);
}
function typeField(index, text) {
  const observation = capture('before-field'), fields = nodes(currentXml(observation)).filter(node => node.class === 'android.widget.EditText');
  if (!fields[index]) throw Error('Expected manual setup field absent');
  const xy = point(fields[index]);
  record('type-fixture-field', {index, value: index === 2 ? '[synthetic fixture token]' : text, xy, observation: observation.id});
  owner.input(observation, ['input', 'tap', ...xy]);
  owner.input(observation, ['input', 'text', text], {secret: index === 2});
  owner.input(observation, ['input', 'keyevent', 'KEYCODE_BACK']);
}

try {
  await tap('Continue', await startup.run({owner, record, wait, diagnose: timeout => execFileSync(process.execPath, [process.env.INPUT + '/diagnose-native.mjs', 'startup-recovery'], {timeout, stdio: 'inherit'})}));
  await tap('Set up manually');
  await expect('Manual setup'); typeField(0, '127.0.0.1'); typeField(2, 'fixture-android-catalog');
  await tap('Test connection');
  await tap('Continue', await expect('Gateway paired'));
  await tap('Continue', await expect('Only enable access you are comfortable letting OpenClaw use while this phone is connected. You can change these later in Android Settings.'));
  await tap('Show Sidebar'); await tap('Settings'); await tap('Providers & Models');
  await expect('Refresh'); capture('initial-catalog');
  const response = await fetch('http://127.0.0.1:18789/control', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mode: 'failed'})});
  if (!response.ok) throw Error('Fixture control refused');
  record('fixture-control', await response.json());
  await tap('Refresh'); await expect('Refresh'); capture('after-failed-refresh');
  const observation = capture('before-app-scroll');
  record('swipe', {from: [540, 1500], to: [540, 500], observation: observation.id});
  owner.input(observation, ['input', 'swipe', '540', '1500', '540', '500', '400']);
  await wait(500); capture('after-failed-refresh-lower');
  record('sequence-complete', {semanticVerdict: 'not assigned; inspect complete UI and wire observations'});
} catch (error) {
  process.exitCode = 1;
  record('sequence-stopped', {error: String(error)});
  try { capture('stop'); }
  catch (captureError) { record('stop-capture-failed', {error: String(captureError)}); }
}
