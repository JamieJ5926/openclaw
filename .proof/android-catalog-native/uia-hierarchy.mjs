const xmlCharacter = code => code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

// Validate the hierarchy/node document emitted by UiAutomator, not arbitrary XML.
export function validateHierarchy(bytes) {
  const xml = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  for (const character of xml) if (!xmlCharacter(character.codePointAt(0))) throw Error('Invalid XML character');
  let at = 0;
  const whitespace = /[\t\n\r ]*/y;
  const skip = () => { whitespace.lastIndex = at; whitespace.exec(xml); at = whitespace.lastIndex; };
  skip();
  const declaration = /<\?xml\s+version=(['"])1\.0\1(?:\s+encoding=(['"])UTF-8\2)?(?:\s+standalone=(['"])(?:yes|no)\3)?\s*\?>/y;
  declaration.lastIndex = at;
  if (!declaration.exec(xml)) throw Error('Missing UiAutomator XML declaration');
  at = declaration.lastIndex;
  const tag = /<\/(hierarchy|node)\s*>|<(hierarchy|node)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const attribute = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack = [];
  let rootSeen = false, rootClosed = false, count = 0;
  while (true) {
    skip();
    if (at === xml.length) break;
    if (rootClosed) throw Error('Trailing data after hierarchy');
    tag.lastIndex = at;
    const match = tag.exec(xml);
    if (!match) throw Error('Malformed hierarchy markup');
    at = tag.lastIndex;
    if (match[1]) {
      if (stack.pop() !== match[1]) throw Error('Mismatched hierarchy closing tag');
      if (!stack.length) rootClosed = true;
      continue;
    }
    const name = match[2], attrs = Object.create(null);
    for (const item of match[3].matchAll(attribute)) {
      if (Object.hasOwn(attrs, item[1])) throw Error('Duplicate XML attribute');
      const value = item[2] ?? item[3];
      const stripped = value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:[0-9]+|x[0-9a-fA-F]+);/g, entity => {
        if (entity.startsWith('&#')) {
          const code = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
          if (!xmlCharacter(code)) throw Error('Invalid numeric XML entity');
        }
        return '';
      });
      if (stripped.includes('&')) throw Error('Invalid XML entity');
      attrs[item[1]] = value;
    }
    if (name === 'hierarchy') {
      if (rootSeen || stack.length || !['0', '1', '2', '3'].includes(attrs.rotation)) throw Error('Invalid hierarchy root');
      rootSeen = true;
    } else {
      if (!stack.length || !['class', 'package', 'bounds'].every(key => Object.hasOwn(attrs, key))) throw Error('Invalid hierarchy node');
      count += 1;
    }
    if (!match[4]) stack.push(name);
    else if (name === 'hierarchy') rootClosed = true;
  }
  if (!rootSeen || !rootClosed || stack.length || !count) throw Error('Incomplete or empty hierarchy');
  return {xml, nodeCount: count};
}
