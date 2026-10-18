// Lists every translatable string in the app: the first argument of t(),
// tk() and tEl(), the two forms of tn() (as "one|other"), and the text and
// attributes marked with data-i18n in index.html.
//   node scripts/i18n-keys.js            keys as JSON (an array)
//   node scripts/i18n-keys.js --missing  keys each locale doesn't have yet
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = [
  ...fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => path.join('renderer', f)),
  ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => path.join('src', f)),
  ...fs.readdirSync(path.join(ROOT, 'src', 'providers')).filter((f) => f.endsWith('.js')).map((f) => path.join('src', 'providers', f)),
];

// A JS string literal starting at i ('...', "..." or `...` without ${}): [value, end] or null.
function literalAt(src, i) {
  const q = src[i];
  if (!["'", '"', '`'].includes(q)) return null;
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j += 1;
    else if (q === '`' && src[j] === '$' && src[j + 1] === '{') return null;
    j += 1;
  }
  const raw = src.slice(i, j + 1);
  // eslint-disable-next-line no-new-func
  return [Function(`"use strict"; return (${raw});`)(), j + 1];
}

const skipSpace = (src, i) => {
  while (/\s/.test(src[i] || '')) i += 1;
  return i;
};

// The index after the first top-level comma from i (inside a call's arguments).
function afterArg(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (["'", '"', '`'].includes(c)) {
      const q = c;
      for (i += 1; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i += 1;
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (c === ',' && depth === 0) return i + 1;
  }
  return -1;
}

function keysOfJs(src, file, out) {
  for (const m of src.matchAll(/(?<![\w$.])(?:I18n\.)?(t|tk|tEl|tn)\(/g)) {
    let i = skipSpace(src, m.index + m[0].length);
    if (m[1] === 'tn') {
      i = afterArg(src, i);
      if (i < 0) continue;
      const one = literalAt(src, skipSpace(src, i));
      if (!one) { out.problems.push(`${file}: tn() without literal forms near "${src.slice(m.index, m.index + 60)}"`); continue; }
      const comma = skipSpace(src, one[1]);
      const other = src[comma] === ',' ? literalAt(src, skipSpace(src, comma + 1)) : null;
      if (!other) { out.problems.push(`${file}: tn() without literal forms near "${src.slice(m.index, m.index + 60)}"`); continue; }
      out.keys.add(`${one[0]}|${other[0]}`);
    } else {
      const lit = literalAt(src, i);
      if (lit) out.keys.add(lit[0]);
      else if (m[1] !== 't') out.problems.push(`${file}: ${m[1]}() without a literal near "${src.slice(m.index, m.index + 60)}"`);
    }
  }
}

function keysOfHtml(html, out) {
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  for (const m of html.matchAll(/<(\w+)\b([^>]*)\bdata-i18n(?![-\w])[^>]*>([\s\S]*?)<\/\1>/g)) out.keys.add(text(m[3]));
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const m of html.matchAll(new RegExp(`<\\w+\\b[^>]*\\bdata-i18n-${attr}\\b[^>]*>`, 'g'))) {
      const v = m[0].match(new RegExp(`\\s${attr}="([^"]*)"`));
      if (v && v[1]) out.keys.add(text(v[1]));
    }
  }
}

function collect() {
  const out = { keys: new Set(), problems: [] };
  for (const f of SOURCES) keysOfJs(fs.readFileSync(path.join(ROOT, f), 'utf8'), f, out);
  keysOfHtml(fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8'), out);
  out.keys.delete('');
  return { keys: [...out.keys].sort(), problems: out.problems };
}

if (require.main === module) {
  const { keys, problems } = collect();
  if (process.argv.includes('--missing')) {
    const I18n = require('../renderer/i18n');
    require('../renderer/locales');
    for (const l of I18n.LANGS.filter((x) => x.id !== 'en')) {
      const d = I18n.dictionaries[l.id] || {};
      const missing = keys.filter((k) => !(k in d));
      console.log(`${l.id}: ${missing.length} missing`);
    }
  } else {
    process.stdout.write(`${JSON.stringify(keys, null, 1)}\n`);
  }
  for (const p of problems) console.error(p);
}

module.exports = { collect };
