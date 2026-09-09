import {initialHierarchyPending} from './capture-owner.mjs';
import {createStartupRecovery} from './startup-surface.mjs';

export function createStartupWelcome({now = Date.now} = {}) {
  let startupDeadline = null, startupComplete = false;
function commandTimeout(maximum = 15000) {
  if (startupDeadline === null) return maximum;
  const remaining = startupDeadline - now();
  if (remaining <= 0) throw Error('Startup deadline expired');
  return Math.min(maximum, remaining);
}
async function run({owner, record, wait, diagnose}) {
  let usedWait = false, hierarchySeen = false;
  startupDeadline = now() + 30000;
  try {
    record('startup-diagnostics-started', {deadline: startupDeadline});
    diagnose(commandTimeout(25000));
    commandTimeout();
    record('startup-diagnostics-complete', {deadline: startupDeadline, diagnostics: 'diagnostic-startup-recovery.json'});
    commandTimeout();
    const recovery = createStartupRecovery();
    while (now() < startupDeadline) {
      const observation = owner.observe('startup', {screenshot: true});
      commandTimeout();
      if (initialHierarchyPending(observation, hierarchySeen)) {
        record('startup-hierarchy-pending', {observation: observation.id, productionExit: observation.productionExit, deadline: startupDeadline});
        await wait(500);
        continue;
      }
      const xml = owner.requireCurrent(observation);
      hierarchySeen = true;
      const action = recovery.observe(xml);
      if (action.action === 'wait') {
        commandTimeout(); usedWait = true;
        record('startup-platform-wait', {capture: observation.id, title: action.title, button: action.button, xy: action.xy, deadline: startupDeadline, diagnostics: 'diagnostic-startup-recovery.json'});
        owner.input(observation, ['input', 'tap', ...action.xy]);
        await wait(300);
        continue;
      }
      if (action.action === 'welcome') {
        record(usedWait ? 'startup-recovery-cleared' : 'startup-recovery-not-needed', {capture: observation.id, usedWait});
        commandTimeout();
        startupComplete = true;
        return observation;
      }
      await wait(500);
    }
    throw Error('Startup welcome did not become available within the existing 30-second deadline');
  } finally { startupDeadline = null; }
}
  return {run, commandTimeout, get complete() {return startupComplete;}};
}
