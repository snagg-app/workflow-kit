import fs from 'node:fs';

// The recorded GitHub answers (gh-shapes/*.json, written by scripts/record-gh-shapes.mjs) and what the fake gh does with them:
// check that a query only asks for fields GitHub really answered, and answer a query from them.
// A shape is an answer without data: strings are "x" (or an enum value), numbers 1, a list has one merged element.

const dir = new URL('./gh-shapes/', import.meta.url);

/** Merges two shapes: the union of their fields; a list keeps one merged element; null and [] yield to anything known. */
export function merge(a, b) {
  if (a === undefined || a === null) return b ?? null;
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.length || b.length ? [merge(a[0], b[0])] : [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, merge(a[key], b[key])]));
  }
  return a;
}

let loaded;
/** All recorded answers as one tree. */
export const loadShapes = () => loaded ??= fs.readdirSync(dir).filter(file => file.endsWith('.json') && file !== 'probes.json')
  .reduce((all, file) => merge(all, JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'))), {});

const skip = (source, at) => { while (/[\s,]/.test(source[at] ?? '')) at++; return at; };
const name = (source, at) => /^\w+/.exec(source.slice(at))?.[0] ?? '';
/** The index after the parentheses opening at AT (arguments, with quoted strings). */
function skipArguments(source, at) {
  for (let depth = 0; at < source.length; at++) {
    if (source[at] === '"') { for (at++; source[at] !== '"'; at++) if (source[at] === '\\') at++; } else if (source[at] === '(') depth++;
    else if (source[at] === ')' && --depth === 0) return at + 1;
  }
  throw new Error('Unbalanced parentheses in the query');
}
/** The fields of the selection set opening at AT as { key (the alias if any), children }; fragments add their fields to the set they sit in. */
function selection(source, at) {
  const fields = [];
  for (at = skip(source, at + 1); source[at] !== '}'; at = skip(source, at)) {
    if (at >= source.length) throw new Error('Unbalanced braces in the query');
    if (source.startsWith('...', at)) { // ...on Type{…}
      at = skip(source, at + 3);
      at = skip(source, at + name(source, at).length);
      at = skip(source, at + name(source, at).length);
      const [inner, end] = selection(source, at);
      fields.push(...inner);
      at = end;
      continue;
    }
    let key = name(source, at);
    at = skip(source, at + key.length);
    if (source[at] === ':') { at = skip(source, at + 1); at = skip(source, at + name(source, at).length); }
    if (source[at] === '(') at = skip(source, skipArguments(source, at));
    let children;
    if (source[at] === '{') [children, at] = selection(source, at);
    fields.push({ key, children });
  }
  return [fields, at + 1];
}

/** The fields a query asks for, as selection(): null for a mutation (its answer cannot be recorded without writing). */
export function fieldsOf(query) {
  if (!/^\s*query\b/.test(query)) return null;
  let at = skip(query, 5);
  if (query[at] === '(') at = skip(query, skipArguments(query, at));
  return selection(query, at)[0];
}

function missingIn(fields, node, path) {
  if (Array.isArray(node)) node = node[0];
  if (node === null || node === undefined) return []; // nothing recorded below here (null, an empty list): nothing to check
  return fields.flatMap(({ key, children }) => {
    if (typeof node !== 'object' || !(key in node)) return [`${path}${key}`];
    return children ? missingIn(children, node[key], `${path}${key}.`) : [];
  });
}

/** The fields of QUERY (a query, not a mutation) that no recorded answer has, as paths. */
export const unknownFields = (query, shapes = loadShapes()) => missingIn(fieldsOf(query) ?? [], shapes, '');

/** The answer to QUERY from the recorded shapes (the data a test then changes), with OVERRIDES merged over it. */
export function answerFrom(query, overrides = {}, shapes = loadShapes()) {
  const build = (fields, node) => {
    if (Array.isArray(node)) return node.length ? [build(fields, node[0])] : [];
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(fields.filter(({ key }) => key in node).map(({ key, children }) => [key, children ? build(children, node[key]) : node[key]]));
  };
  const answer = build(fieldsOf(query), shapes), plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const over = (base, changes) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(changes)])]
    .map(key => [key, plain(base[key]) && plain(changes[key]) ? over(base[key], changes[key]) : key in changes ? changes[key] : base[key]]));
  return over(answer, overrides);
}
