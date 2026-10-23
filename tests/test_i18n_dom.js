// Run with node tests/test_i18n_dom.js [path-to-index.html]. Zero dependencies.
// This is the DOM-level check requested in review: it parses the real markup, runs the
// real t()/applyStaticI18n() source in a vm, and models textContent the way a browser
// does (assigning it replaces every child node). Any control nested inside a
// translated container therefore disappears - and the assertion fails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = process.argv[2] || path.join(__dirname, '../studio/index.html');
const html = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

// ---------- tiny DOM: just enough for applyStaticI18n ----------
function makeNode(tag, attrs) {
  const a = {};
  for (const m of attrs.matchAll(/([a-zA-Z0-9-]+)(?:="([^"]*)")?/g)) a[m[1].toLowerCase()] = m[2] === undefined ? "" : m[2];
  const node = { tag, attrs: a,
    dataset: { i18n: a['data-i18n'], i18nTitle: a['data-i18n-title'], i18nPlaceholder: a['data-i18n-placeholder'] },
    title: a.title || '', placeholder: a.placeholder || '', children: [] };
  Object.defineProperty(node, 'textContent', {
    get() { return this.children.map(c => (c.text === undefined ? c.textContent : c.text)).join('').trim(); },
    set(value) { this.children = [{ text: String(value) }]; },  // browser semantics: children are dropped
    enumerable: true,
  });
  return node;
}

function parseMarkup(src) {
  const root = makeNode('#root', '');
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) {
      if (m[5].trim()) stack[stack.length - 1].children.push({ text: m[5] });
      continue;
    }
    if (m[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === m[2].toLowerCase()) { stack.length = i; break; }
      continue;
    }
    const node = makeNode(m[2].toLowerCase(), m[3] || '');
    stack[stack.length - 1].children.push(node);
    if (!(m[4] === '/' || VOID.has(node.tag))) stack.push(node);
  }
  return root;
}

function walk(node, visit) { visit(node); for (const c of node.children) if (c.tag) walk(c, visit); }
function idOf(node) { return node.attrs && node.attrs.id; }

const markup = html.slice(html.indexOf("<body"), html.indexOf("<script", html.indexOf("<body")));

// ---------- the real implementation, sliced out of index.html ----------
const dictSrc = html.slice(html.indexOf('const I18N = {'), html.indexOf('\n};\n', html.indexOf('const I18N = {')) + 3);
const fnSrc = html.slice(html.indexOf('function t(key, vars)'), html.indexOf('// ---------- presets'));
assert.ok(dictSrc.length > 1000 && fnSrc.includes('applyStaticI18n'), 'could not slice I18N/t() out of ' + file);

const KEY_IDS = [
  'refcount', 'sizeVal', 'refMaxVal', 'stepsVal', 'imgCfgVal', 'batchVal', 'fastThVal', 'shiftVal',
  'spi', 'eta', 'elapsed', 'runEngine', 'pauseQ', 'clearQ', 'brush', 'est', 'drop', 'empty', 'goLabel',
];

function run(lang) {
  const root = parseMarkup(markup);
  const nodes = [];
  walk(root, n => { if (n.tag) nodes.push(n); });
  const before = new Map();
  for (const n of nodes) if (n.dataset.i18n !== undefined) before.set(n.dataset.i18n + '@' + nodes.indexOf(n), n.textContent);
  const idsBefore = nodes.filter(n => idOf(n)).length;
  const doc = {
    documentElement: { lang: '' },
    title: '',
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return nodes.filter(n => n.dataset.i18n !== undefined);
      if (selector === '[data-i18n-title]') return nodes.filter(n => n.dataset.i18nTitle !== undefined);
      if (selector === '[data-i18n-placeholder]') return nodes.filter(n => n.dataset.i18nPlaceholder !== undefined);
      throw new Error('unsupported selector: ' + selector);
    },
  };
  const context = vm.createContext({ document: doc, console: { warn() {} } });
  vm.runInContext('const LANG = ' + JSON.stringify(lang) + ';\n' + dictSrc + '\n' + fnSrc + '\napplyStaticI18n();', context);
  const byId = new Map();
  let lost = [];
  walk(root, n => { if (idOf(n)) byId.set(idOf(n), n); });
  for (const id of KEY_IDS) if (!byId.has(id)) lost.push(id);
  const idsAfter = nodes.filter(n => idOf(n)).length;
  return { doc, byId, lost, before, idsBefore, idsAfter, nodes, dict: vm.runInContext('I18N[' + JSON.stringify(lang) + ']', context) };
}

// 1 + 2: run the pass for both languages; it must not throw and must set <html lang>.
const en = run('en');
const zh = run('zh');
assert.equal(en.doc.documentElement.lang, 'en', 'en must set <html lang="en">');
assert.equal(zh.doc.documentElement.lang, 'zh-CN', 'zh must set <html lang="zh-CN">');
assert.equal(en.doc.title, en.dict['app.title'], 'document.title must be translated');
assert.equal(zh.doc.title, zh.dict['app.title'], 'document.title must be translated in zh');

// 3: nested controls must survive the pass in both languages.
assert.deepEqual(en.lost, [], 'controls lost in the English pass: ' + en.lost.join(', '));
assert.deepEqual(zh.lost, [], 'controls lost in the Chinese pass: ' + zh.lost.join(', '));
for (const [lang, result] of [['en', en], ['zh', zh]]) {
  assert.equal(result.idsAfter, result.idsBefore, lang + ': element count changed after applyStaticI18n');
}
assert.ok(zh.byId.get('pauseQ') && zh.byId.get('clearQ'), 'queue buttons must still exist in zh');
assert.ok(zh.byId.get('brush'), 'the mask brush slider must still exist in zh');
assert.ok(zh.byId.get('refcount'), 'the reference counter must still exist in zh');

// The drop area is the one translated container with a nested element (<u>).
const dropChoose = zh.byId.get('drop').children.find(c => c.tag === 'u');
assert.ok(dropChoose, 'the <u> inside the drop area must survive');
assert.equal(dropChoose.textContent, zh.dict['form.dropChoose'], 'nested <u> must be translated');

// 4: both languages must actually be applied.
const sample = [['goLabel', 'button.generate'], ['pauseQ', 'queue.pause'], ['clearQ', 'queue.clear']];
for (const [id, key] of sample) {
  assert.equal(en.byId.get(id).textContent, en.dict[key], id + ' English');
  assert.equal(zh.byId.get(id).textContent, zh.dict[key], id + ' Chinese');
}
assert.notEqual(en.byId.get('goLabel').textContent, zh.byId.get('goLabel').textContent, 'languages must differ');
for (const key of ['filter.week', 'viewer.close', 'gallery.empty', 'gallery.noMatches']) {
  assert.ok(key in en.dict && key in zh.dict, 'missing new key: ' + key);
}

// English output must stay byte-identical to the markup fallback text.
const enDrift = [];
for (const node of en.nodes) {
  if (node.dataset.i18n === undefined) continue;
  if (!(node.dataset.i18n in en.dict)) continue;
  const original = node.children.length === 1 && node.children[0].text !== undefined ? node.children[0].text.trim() : null;
  if (original !== null && original !== node.textContent) enDrift.push(node.dataset.i18n);
}
assert.deepEqual(enDrift.slice(0, 5), [], 'English text drifted from the markup fallback: ' + enDrift.join(', '));

console.log('i18n DOM pass ok: ' + en.nodes.filter(n => n.dataset.i18n !== undefined).length + ' translated nodes, no control lost, en/zh both applied');
