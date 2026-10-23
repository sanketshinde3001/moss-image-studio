// Run with node tests/test_i18n.js. No browser, server, model or npm dependency.
// The checks are static on purpose. "No [data-i18n] element has element children" is
// exactly the invariant that makes applyStaticI18n()'s textContent assignment safe,
// independent of how any particular DOM implementation behaves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '../studio/index.html');
const html = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const dict = name => {
  const start = html.indexOf('\n  ' + name + ': {');
  const end = html.indexOf('\n  },', start);
  return [...html.slice(start, end).matchAll(/"([a-zA-Z0-9.]+)":/g)].map(match => match[1]);
};
const en = dict('en');
const zh = dict('zh');

// 1. Both tables stay symmetric so t() never falls back to English by accident.
assert.deepEqual(en.slice().sort(), zh.slice().sort(), 'en and zh key sets differ');
assert.ok(en.length > 300, 'dictionary looks truncated');

// 2. Every key referenced from code or markup must exist.
for (const [, key] of html.matchAll(/\bt\("([a-zA-Z0-9.]+)"(?=[),])/g)) {
  assert.ok(en.includes(key), 'missing i18n key used by t(): ' + key);
}
for (const [, key] of html.matchAll(/ data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) {
  assert.ok(en.includes(key), 'missing i18n key used by markup: ' + key);
}

// 3. data-i18n may only sit on text-only elements: applyStaticI18n() assigns
//    textContent, which deletes nested counters, controls and the brush slider.
const markup = html.slice(html.indexOf('<body'), html.indexOf('<script', html.indexOf('<body')));
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const stack = [{ tag: '#root', key: null, kids: 0, line: 1 }];
const offenders = [];
let token, line = 1, last = 0;
while ((token = tagRe.exec(markup))) {
  line += markup.slice(last, token.index).split('\n').length - 1;
  last = token.index;
  const tag = token[1].toLowerCase();
  const attrs = token[2] || '';
  if (token[0].startsWith('</')) {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag !== tag) continue;
      if (stack[i].key && stack[i].kids) offenders.push(stack[i].key + ' (line ' + stack[i].line + ')');
      stack.length = i;
      break;
    }
    continue;
  }
  stack[stack.length - 1].kids++;
  const key = attrs.match(/ data-i18n="([^"]+)"/);
  const el = { tag, key: key ? key[1] : null, kids: 0, line };
  if (!(attrs.trimEnd().endsWith('/') || VOID.has(tag))) stack.push(el);
}
assert.deepEqual(offenders, [], 'data-i18n element(s) still contain child elements');

// 4. Attributes on a closing tag are invalid HTML and are dropped by the parser.
assert.ok(!/<\/[a-zA-Z][a-zA-Z0-9]*[^>]*\s[a-zA-Z0-9-]+=/.test(markup), 'attribute on a closing tag');

// 5. Any preferred zh* tag must win over en*, per the PR description.
const detectSrc = html.slice(html.indexOf('function detectLang'), html.indexOf('const LANG'));
const detect = nav => new Function('navigator', detectSrc + '; return detectLang();')(nav);
assert.equal(detect({ languages: ['en-US', 'zh-CN'] }), 'zh', 'mixed en+zh list must pick Chinese');
assert.equal(detect({ languages: ['zh-TW'] }), 'zh');
assert.equal(detect({ languages: ['de-DE'] }), 'en');
assert.equal(detect({}), 'en');

// 6. Keys built at runtime cannot be found by the literal scan above:
//    t("meta." + k) in the compare view and t("state." + job.state) in the queue.
//    A missing entry renders the raw key ("meta.width") instead of failing loudly.
const compare = html.slice(html.indexOf('function openCompare'), html.indexOf('function setBefore', html.indexOf('function openCompare')));
assert.ok(compare.length > 200, 'openCompare() not found');
const compared = compare.match(/const diff = \[([^\]]+)\]/);
assert.ok(compared, 'openCompare(): compared metadata list not found');
const comparedKeys = [...compared[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
assert.ok(comparedKeys.length >= 5, 'openCompare(): compared metadata list looks empty');
for (const key of comparedKeys) {
  assert.ok(en.includes('meta.' + key), 'missing i18n key used by the compare view: meta.' + key);
}

// server.py writes job states as kwarg, dict literal and item assignment alike.
const serverFile = path.join(__dirname, '../studio/server.py');
const jobStates = new Set();
if (fs.existsSync(serverFile)) {
  const server = fs.readFileSync(serverFile, 'utf8');
  for (const match of server.matchAll(/(?:state="|\["state"\]\s*=\s*"|"state":\s*")([a-z]+)"/g)) jobStates.add(match[1]);
  assert.ok(jobStates.size >= 4, 'server.py: job states not found, this check would be vacuous');
  for (const state of jobStates) {
    assert.ok(en.includes('state.' + state), 'missing i18n key for job state: state.' + state);
  }
}

console.log('i18n checks passed: ' + en.length + ' keys x2, ' + comparedKeys.length + ' dynamic compare keys, ' + jobStates.size + ' job states, no destructive data-i18n, detectLang ok');
