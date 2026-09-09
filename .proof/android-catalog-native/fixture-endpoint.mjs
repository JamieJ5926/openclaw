import {applicationNodes, point} from './startup-surface.mjs';

export function readFixtureEndpoint(xml) {
  const values = applicationNodes(xml);
  const fields = values.filter(node => node.class === 'android.widget.EditText');
  if (fields[0]?.text !== '127.0.0.1' || fields[1]?.text !== '18789') {
    throw Error('Rendered host/port does not match the isolated fixture');
  }
  const controls = values.filter(node => node.checkable === 'true');
  if (controls.length !== 2) throw Error('Expected two connection-security controls');
  const choice = label => {
    const labels = values.filter(node => node.text === label);
    if (labels.length !== 1) throw Error('Missing or ambiguous transport label');
    const [x, y] = point(labels[0]).map(Number);
    const matches = controls.filter(node => {
      const match = node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
      if (!match) throw Error('Missing transport control bounds');
      const [x1, y1, x2, y2] = match.slice(1).map(Number);
      return x1 < x2 && y1 < y2 && x >= x1 && x < x2 && y >= y1 && y < y2;
    });
    if (matches.length !== 1 || matches[0].enabled !== 'true' || !['true', 'false'].includes(matches[0].checked)) {
      throw Error('Transport control is ambiguous, disabled or unreadable');
    }
    return matches[0];
  };
  const cleartext = choice('Unencrypted'), secure = choice('Secure (TLS)');
  if (cleartext === secure || cleartext.checked !== 'true' || secure.checked !== 'false') {
    throw Error('Rendered transport does not match the loopback fixture');
  }
  return {host: fields[0].text, port: 18789, endpoint: 'ws://127.0.0.1:18789', cleartext: {checked: cleartext.checked, bounds: cleartext.bounds}, secure: {checked: secure.checked, bounds: secure.bounds}};
}
