import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {validateHierarchy} from './uia-hierarchy.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const completePng = bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const byteRecord = bytes => {
  const text = bytes.toString('utf8');
  return Buffer.from(text).equals(bytes) ? {bytes: bytes.length, sha256: digest(bytes), text} : {bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64')};
};

export function createAdbExecutor({temporaryDirectory, serial = 'emulator-5554'}) {
  return command => {
    const key = randomUUID(), stdoutFile = path.join(temporaryDirectory, key + '.stdout'), stderrFile = path.join(temporaryDirectory, key + '.stderr');
    const stdout = fs.openSync(stdoutFile, 'wx'), stderr = fs.openSync(stderrFile, 'wx');
    const startedAt = new Date().toISOString();
    const result = spawnSync('adb', ['-s', serial, ...command.args], {stdio: ['ignore', stdout, stderr], timeout: command.timeoutMs});
    fs.closeSync(stdout); fs.closeSync(stderr);
    return {startedAt, finishedAt: new Date().toISOString(), status: result.status, signal: result.signal, error: result.error?.message, stdout: fs.readFileSync(stdoutFile), stderr: fs.readFileSync(stderrFile)};
  };
}

export function dumpCommand(directory, file) {
  return [
    `mkdir ${quote(directory)}`,
    'mkdir_status=$?',
    'printf "capture_mkdir_exit=%s\\n" "$mkdir_status" >&2',
    'if [ "$mkdir_status" -ne 0 ]; then exit 70; fi',
    `uiautomator dump ${quote(file)}`,
    'dump_status=$?',
    'printf "capture_dump_exit=%s\\n" "$dump_status" >&2',
    'if [ "$dump_status" -ne 0 ]; then exit 71; fi',
    `if [ ! -d ${quote(directory)} ] || [ ! -r ${quote(directory)} ] || [ ! -x ${quote(directory)} ]; then exit 74; fi`,
    `if [ -L ${quote(file)} ]; then exit 73; fi`,
    `if [ ! -e ${quote(file)} ]; then exit 42; fi`,
    `if [ ! -f ${quote(file)} ] || [ ! -s ${quote(file)} ] || [ ! -r ${quote(file)} ]; then exit 73; fi`,
    'exit 0',
  ].join('\n');
}

export function createCaptureOwner({directory, execute, timeout, nonce = randomUUID()}) {
  if (!/^[0-9a-f-]+$/.test(nonce)) throw Error('Invalid capture namespace');
  let sequence = 0, latest = null;
  const append = (file, record) => fs.appendFileSync(path.join(directory, file), JSON.stringify(record) + '\n');
  const command = (phase, args, observation, binaryName, publicArgs = args) => {
    const timeoutMs = timeout();
    const result = execute({phase, args, observation, timeoutMs});
    let stdout;
    if (binaryName) {
      const file = binaryName + (result.status === 0 && completePng(result.stdout) ? '.png' : '.screen.bin');
      fs.writeFileSync(path.join(directory, file), result.stdout, {flag: 'wx'});
      stdout = {file, bytes: result.stdout.length, sha256: digest(result.stdout)};
    } else stdout = byteRecord(result.stdout);
    append('capture-commands.jsonl', {observation, phase, command: ['adb', '-s', 'emulator-5554', ...publicArgs], timeoutMs, startedAt: result.startedAt, finishedAt: result.finishedAt, status: result.status, signal: result.signal, error: result.error, stdout, stderr: byteRecord(result.stderr)});
    return result;
  };
  return {
    observe(label, {screenshot = false} = {}) {
      if (!/^[a-z-]+$/.test(label)) throw Error('Invalid observation label');
      const id = String(++sequence).padStart(3, '0') + '-' + label;
      const remoteDirectory = '/sdcard/openclaw-catalog-' + nonce + '-' + sequence;
      const remoteFile = remoteDirectory + '/hierarchy.xml';
      const record = {id, remoteDirectory, remoteFile, startedAt: new Date().toISOString(), status: 'error'};
      latest = null;
      try {
        if (screenshot) {
          const shot = command('screenshot', ['exec-out', 'screencap', '-p'], id, id);
          if (shot.status !== 0 || !completePng(shot.stdout)) throw Error('Screenshot command did not produce complete PNG');
          record.screenshot = id + '.png';
        }
        const production = command('produce', ['shell', '-T', dumpCommand(remoteDirectory, remoteFile)], id);
        record.productionExit = production.status;
        if (production.status === 42) {
          record.status = 'absent';
          record.absence = 'fresh directory created; completed dump produced no file';
        } else {
          if (production.status !== 0) throw Error('Current hierarchy production failed');
          const read = command('read', ['shell', '-T', 'cat ' + quote(remoteFile)], id);
          record.readExit = read.status;
          if (read.status !== 0) throw Error('Current hierarchy read failed');
          const validated = validateHierarchy(read.stdout);
          fs.writeFileSync(path.join(directory, id + '.xml'), read.stdout, {flag: 'wx'});
          record.status = 'hierarchy'; record.xml = validated.xml; record.nodeCount = validated.nodeCount;
          record.hierarchyFile = id + '.xml'; record.hierarchySha256 = digest(read.stdout);
        }
      } catch (error) { record.error = String(error); }
      record.finishedAt = new Date().toISOString();
      const {xml, ...publicRecord} = record;
      append('capture-observations.jsonl', publicRecord);
      latest = Object.freeze(record);
      return latest;
    },
    requireCurrent(observation) {
      if (observation !== latest || observation?.status !== 'hierarchy') throw Error('A newly produced current hierarchy is required');
      return observation.xml;
    },
    input(observation, args, {secret = false} = {}) {
      this.requireCurrent(observation);
      const words = args[0] === 'shell' ? args.slice(1) : args;
      const actual = ['shell', '-T', words.map(quote).join(' ')];
      const shown = secret ? ['shell', '-T', [...words.slice(0, -1).map(quote), "'[synthetic fixture token]'"].join(' ')] : actual;
      const result = command('input', actual, observation.id, null, shown);
      if (result.status !== 0) throw Error('Input command failed');
    },
  };
}

export function initialHierarchyPending(observation, hierarchySeen) {
  return !hierarchySeen && observation.status === 'absent' && observation.productionExit === 42;
}

export function capturePreflight({directory, execute}) {
  const results = [];
  for (const [phase, args, expected] of [
    ['shell-exit-probe', ['shell', '-T', 'exit 42'], 42],
    ['uiautomator-help', ['shell', '-T', 'uiautomator help'], 0],
  ]) {
    const result = execute({phase, args, observation: 'preflight', timeoutMs: 5000});
    const record = {observation: 'preflight', phase, command: ['adb', '-s', 'emulator-5554', ...args], expected, startedAt: result.startedAt, finishedAt: result.finishedAt, status: result.status, signal: result.signal, error: result.error, stdout: byteRecord(result.stdout), stderr: byteRecord(result.stderr)};
    fs.appendFileSync(path.join(directory, 'capture-commands.jsonl'), JSON.stringify(record) + '\n');
    results.push(record);
    if (result.status !== expected) throw Error('Capture transport preflight failed: ' + phase);
  }
  const preflight = {nonce: randomUUID(), serial: 'emulator-5554', shellExitCode: results[0].status, helpExitCode: results[1].status, at: new Date().toISOString()};
  fs.writeFileSync(path.join(directory, 'capture-preflight.json'), JSON.stringify(preflight, null, 2) + '\n', {flag: 'wx'});
  return preflight;
}
