const APP_PACKAGE = 'ai.openclaw.app.debug';
const decode = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');

export function nodes(xml) {
  const result = [...xml.matchAll(/<node\s+([^>]+)>?/g)].map(match => Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], decode(attribute[2])])));
  if (!result.length) throw Error('Inaccessible or empty UI hierarchy');
  return result;
}

function bounds(node) {
  const match = node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) throw Error('Missing visible bounds');
  const value = match.slice(1).map(Number);
  if (value[2] <= value[0] || value[3] <= value[1]) throw Error('Empty visible bounds');
  return value;
}

export function point(node) {
  const [x1, y1, x2, y2] = bounds(node);
  return [String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2))];
}

export function applicationNodes(xml) {
  const values = nodes(xml);
  if (values.some(node => node.package !== APP_PACKAGE || node['resource-id'] === 'android:id/alertTitle' || node['resource-id']?.startsWith('android:id/aerr_'))) {
    throw Error('Unexpected or reappearing dialog blocks the application surface');
  }
  return values;
}

function startupSurface(xml) {
  const values = nodes(xml);
  if (values[0].package === APP_PACKAGE) {
    const app = applicationNodes(xml);
    return app.some(node => node.text === 'Welcome to OpenClaw' && node.enabled === 'true') && app.some(node => node.text === 'Continue' && node.enabled === 'true')
      ? {kind: 'welcome'} : {kind: 'pending'};
  }
  if (values.some(node => node.package !== 'android')) throw Error('Different platform surface at startup');
  const titles = values.filter(node => node['resource-id'] === 'android:id/alertTitle');
  const waits = values.filter(node => node['resource-id'] === 'android:id/aerr_wait');
  const closes = values.filter(node => node['resource-id'] === 'android:id/aerr_close');
  if (titles.length !== 1 || titles[0].text !== "System UI isn't responding" || titles[0].enabled !== 'true' || waits.length !== 1 || closes.length !== 1) {
    throw Error('Startup dialog identity does not match the selected System UI recovery');
  }
  const title = titles[0], button = waits[0], close = closes[0];
  if (button.text !== 'Wait' || button.class !== 'android.widget.Button' || button.enabled !== 'true' || button.clickable !== 'true' || close.text !== 'Close app' || close.class !== 'android.widget.Button' || close.enabled !== 'true' || close.clickable !== 'true') {
    throw Error('Selected platform Wait control is not uniquely actionable');
  }
  const buttons = values.filter(node => node.class === 'android.widget.Button' && node.clickable === 'true');
  if (buttons.length !== 2) throw Error('Unexpected platform dialog controls');
  const root = bounds(values[0]), wait = bounds(button), other = bounds(close);
  if (wait[0] < root[0] || wait[1] < root[1] || wait[2] > root[2] || wait[3] > root[3] || (wait[0] < other[2] && wait[2] > other[0] && wait[1] < other[3] && wait[3] > other[1])) {
    throw Error('Wait bounds are outside the dialog or overlap Close app');
  }
  return {kind: 'system-ui-dialog', title, button, xy: point(button)};
}

export function createStartupRecovery() {
  let state = 'initial';
  return {
    observe(xml) {
      const surface = startupSurface(xml);
      if (state === 'complete') {
        if (surface.kind !== 'welcome') throw Error('Startup dialog reappeared after recovery');
        return {action: 'welcome'};
      }
      if (surface.kind === 'welcome') {
        state = 'complete';
        return {action: 'welcome'};
      }
      if (surface.kind === 'system-ui-dialog' && state === 'initial') {
        state = 'needs-diagnostics';
        return {action: 'diagnose'};
      }
      if (state === 'needs-diagnostics') throw Error('Diagnostics must finish before recovery can continue');
      if (surface.kind === 'system-ui-dialog' && state === 'cleared-awaiting-welcome') throw Error('Startup dialog reappeared after recovery');
      if (surface.kind === 'pending' && state === 'waiting-for-clear') state = 'cleared-awaiting-welcome';
      return {action: 'pending'};
    },
    afterDiagnostics(xml) {
      if (state !== 'needs-diagnostics') throw Error('No second or unprepared startup recovery is allowed');
      const surface = startupSurface(xml);
      if (surface.kind === 'welcome') {
        state = 'complete';
        return {action: 'welcome'};
      }
      if (surface.kind !== 'system-ui-dialog') throw Error('Selected startup dialog changed before Wait');
      state = 'waiting-for-clear';
      return {action: 'wait', title: surface.title, button: surface.button, xy: surface.xy};
    },
  };
}
