import {applicationNodes} from './startup-surface.mjs';

function manualField(xml, index) {
  const values = applicationNodes(xml);
  const caption = index === 0 ? 'Gateway URL' : index === 2 ? 'Token' : null;
  if (!caption) throw Error('Unselected manual entry field');
  const labels = values.filter(node => node.class === 'android.widget.TextView' && node.text === caption);
  if (labels.length !== 1) throw Error('The selected manual field caption is not unique');
  const following = values.slice(values.indexOf(labels[0]) + 1);
  const nextCaption = following.findIndex(node => node.class === 'android.widget.TextView' && ['Token', 'Password', 'Connection security'].includes(node.text));
  const section = nextCaption === -1 ? following : following.slice(0, nextCaption);
  const field = section.find(node => node.class === 'android.widget.EditText');
  return {field, fields: values.filter(node => node.class === 'android.widget.EditText')};
}

export function requireEmptyFocusedField(xml, index) {
  const {fields, field} = manualField(xml, index);
  if (!field || field.enabled !== 'true' || field.focused !== 'true' || fields.filter(node => node.focused === 'true').length !== 1) {
    throw Error('The selected manual field is not uniquely focused');
  }
  if (field.text !== '') throw Error('The selected manual field is not empty; no retyping is allowed');
  return field;
}

export function requireHostReadback(xml, expected) {
  const {field: host} = manualField(xml, 0);
  if (!host || host.text !== expected) throw Error('Entered host differs from the single requested value');
  return host;
}
