import fs from 'node:fs';
import path from 'node:path';

const phasePercent = {access: 200, prepare: 200, native: 300, finalize: 200};
export const HOST_CPU_RESERVE = 1;
export const REQUIRED_HOST_CPUS = phasePercent.native / 100 + HOST_CPU_RESERVE;

export function cpuQuotaPercent(phase) {
  if (!Object.hasOwn(phasePercent, phase)) throw Error('Unknown CPU phase');
  return phasePercent[phase];
}

function cpuList(text) {
  if (!text.trim()) return [];
  let last = -1;
  return text.trim().split(',').map(item => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (!match) throw Error('Malformed CPU list');
    const first = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(end) || first <= last || end < first) throw Error('Invalid or overlapping CPU range');
    last = end;
    return [first, end];
  });
}

function intersect(left, right) {
  const result = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    const first = Math.max(left[i][0], right[j][0]), end = Math.min(left[i][1], right[j][1]);
    if (first <= end) result.push([first, end]);
    if (left[i][1] < right[j][1]) i++; else j++;
  }
  return result;
}

function bandwidth(text) {
  const match = /^(max|\d+) (\d+)\n?$/.exec(text);
  if (!match || BigInt(match[2]) <= 0n || (match[1] !== 'max' && BigInt(match[1]) <= 0n)) throw Error('Malformed cpu.max');
  return {quotaMicros: match[1], periodMicros: match[2]};
}

export function requirePhaseCpuQuota(phase, cpuMax, cpuBurst) {
  const percent = cpuQuotaPercent(phase), value = bandwidth(cpuMax);
  if (value.quotaMicros === 'max' || BigInt(value.quotaMicros) * 100n !== BigInt(percent) * BigInt(value.periodMicros)) throw Error('Actual CPU quota differs from selected phase');
  if (cpuBurst.trim() !== '0') throw Error('Unselected CPU burst allowance');
  return {percent, ...value, burstMicros: '0'};
}

// Called by the host launcher, before systemd-run. The optional root is only
// for source tests with a private filesystem containing the Linux interfaces.
export function inspectHostCpu({root = ''} = {}) {
  const reads = [], at = new Date().toISOString();
  const file = name => root + name;
  const raw = name => fs.readFileSync(file(name), 'utf8');
  const read = name => {const text = raw(name); reads.push({path: name, text}); return text;};
  const controllerWords = name => read(name).trim().split(/\s+/).filter(Boolean);
  try {
    const mounts = raw('/proc/self/mountinfo').trim().split('\n').filter(line => line.split(' - ')[1]?.startsWith('cgroup2 '));
    reads.push({path: '/proc/self/mountinfo', cgroup2Entries: mounts});
    const mount = mounts.filter(line => line.split(' - ')[0].split(' ')[4] === '/sys/fs/cgroup');
    if (mount.length !== 1 || mount[0].split(' - ')[0].split(' ')[3] !== '/') throw Error('A full host cgroup-v2 mount is required');
    if (read('/proc/1/comm').trim() !== 'systemd') throw Error('Expected the selected systemd host');
    const cgroupLine = read('/proc/self/cgroup'), match = /^0::(\/[^\n]*)\n?$/.exec(cgroupLine);
    if (!match || match[1].split('/').some(part => part === '..' || part === '.')) throw Error('Unexpected unified cgroup path');
    const processCgroup = match[1];
    if (/\/android-catalog-hosted-\d+-(access|prepare|native|finalize)\.service(?:\/|$)/.test(processCgroup)) throw Error('Host CPU measurement must be outside the owned phase');
    const status = raw('/proc/self/status'), affinity = /^Cpus_allowed_list:\s*([^\n]*)$/m.exec(status);
    if (!affinity) throw Error('Missing process CPU affinity');
    reads.push({path: '/proc/self/status', cpusAllowedList: affinity[1]});
    let effectiveSet = intersect(cpuList(affinity[1]), cpuList(read('/sys/devices/system/cpu/online')));
    const base = '/sys/fs/cgroup', available = controllerWords(base + '/cgroup.controllers');
    if (!available.includes('cpu')) throw Error('Host CPU controller is unavailable');
    if (available.includes('cpuset')) effectiveSet = intersect(effectiveSet, cpuList(read(base + '/cpuset.cpus.effective')));
    const directories = new Set();
    for (const leaf of [base + (processCgroup === '/' ? '' : processCgroup), base + '/system.slice']) {
      for (let directory = leaf; directory !== base; directory = path.posix.dirname(directory)) directories.add(directory);
    }
    const quotas = [], inherited = [];
    for (const directory of [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      const parent = path.posix.dirname(directory), enabled = controllerWords(parent + '/cgroup.subtree_control');
      for (const [controller, name] of [['cpu', 'cpu.max'], ['cpuset', 'cpuset.cpus.effective']]) {
        const namePath = directory + '/' + name;
        if (enabled.includes(controller)) {
          if (controller === 'cpu') quotas.push({path: namePath, ...bandwidth(read(namePath))});
          else effectiveSet = intersect(effectiveSet, cpuList(read(namePath)));
        } else {
          if (fs.existsSync(file(namePath))) throw Error('Controller state changed during CPU observation');
          inherited.push({path: namePath, parent, controller, reason: 'parent did not enable a child controller; ancestor limits still counted'});
        }
      }
    }
    const allowedCpuCount = effectiveSet.reduce((count, [first, end]) => count + end - first + 1, 0);
    let numerator = BigInt(allowedCpuCount), denominator = 1n;
    for (const quota of quotas) if (quota.quotaMicros !== 'max') {
      const q = BigInt(quota.quotaMicros), p = BigInt(quota.periodMicros);
      if (q * denominator < numerator * p) {numerator = q; denominator = p;}
    }
    const fits = numerator >= BigInt(REQUIRED_HOST_CPUS) * denominator;
    return {at, status: fits ? 'fit' : 'refused', processCgroup, outsideOwnedPhase: true, requiredHostCpus: REQUIRED_HOST_CPUS, nativeCpuQuotaPercent: cpuQuotaPercent('native'), reservedHostCpuCapacity: HOST_CPU_RESERVE, allowedCpuCount, effectiveCpuCapacity: {numerator: String(numerator), denominator: String(denominator)}, quotas, inherited, reads};
  } catch (error) {
    return {at, status: 'unavailable', error: String(error), reads};
  }
}

export function requireHostCpuFit(observation) {
  if (observation.status !== 'fit' || observation.outsideOwnedPhase !== true) throw Error('Hosted CPU admission refused: ' + (observation.error ?? observation.status));
}

export function canFinalizeCpuRefusal(runResult, startedPhases) {
  return runResult?.code === 1 && runResult.cpuAdmissionRefused === true && startedPhases.length === 0;
}
