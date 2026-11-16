#!/usr/bin/env node
/* =====================================================================
   Talli — the logging rules, as scripts/check.sh enforces them.

   Every edge function logs through supabase/functions/_shared/log.ts,
   and every page reports its errors through assets/talli-errors.js. A
   rule that lives only in a document is the first thing a fast change
   forgets, so each one is checked here, on every run of check.sh and
   so on every PR.

   Edge functions (supabase/functions):

     L1  console.* only inside _shared/log.ts. Anything else bypasses
         the ref, the scrubbing and the JSON shape.
     L2  Deno.serve only inside _shared/log.ts. serve() is what logs
         each request and turns a throw into a ref instead of a stack.
     L3  every function's index.ts starts with serve('<its own name>'),
         so its lines say which function wrote them.
     L4  no response is built from an error's own message. Database,
         Stripe and runtime messages go to the log; the caller gets
         named() or unexpected().
     L5  no catch swallows an error. Each one logs it (log.*), rethrows
         it, hands it to named(), or says why not with a comment that
         starts "not logged:" — a decision someone made, in writing.
     L6  every remote import names an exact version, so what was tested
         is what deploys.

   Pages:

     L7  every page that loads talli-config.js loads talli-errors.js
         straight after it, including the pages functions/_lib/site.js
         renders.

   Prints one line per rule — "ok|…" or "fail|…" followed by "detail|…"
   lines — for check.sh to report. Exit status 1 if any rule failed.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN_DIR = path.join(ROOT, 'supabase', 'functions');
const LOG_TS = path.join(FN_DIR, '_shared', 'log.ts');

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// Comments out, line numbers kept: a rule should not fire on a comment
// that mentions console.error, nor miss code because a comment is near it.
// Strings stay, which is good enough for code this size.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

function matching(src, open) {
  const pair = { '(': ')', '{': '}' }[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === pair && --depth === 0) return i;
  }
  return src.length - 1;
}

const results = [];
function rule(name, failures) {
  results.push({ name, failures });
}

const tsFiles = walk(FN_DIR, '.ts');
const sources = tsFiles.map((f) => {
  const raw = fs.readFileSync(f, 'utf8');
  return { file: f, raw, code: stripComments(raw) };
});
const notLog = sources.filter((s) => s.file !== LOG_TS);

// ---------------------------------------------------------------- L1, L2
function grepRule(name, re) {
  const bad = [];
  for (const s of notLog) {
    let m;
    const g = new RegExp(re.source, 'g');
    while ((m = g.exec(s.code))) bad.push(`${rel(s.file)}:${lineOf(s.code, m.index)}  ${m[0]}`);
  }
  rule(name, bad);
}
grepRule('edge functions log through _shared/log.ts, never console.* (L1)', /\bconsole\.[a-z]+\s*\(/);
grepRule('edge functions start through serve(), never Deno.serve (L2)', /\bDeno\.serve\s*\(/);

// -------------------------------------------------------------------- L3
{
  const bad = [];
  for (const dir of fs.readdirSync(FN_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('_')) continue;
    const index = path.join(FN_DIR, dir.name, 'index.ts');
    if (!fs.existsSync(index)) continue;
    const code = stripComments(fs.readFileSync(index, 'utf8'));
    if (!new RegExp(`\\bserve\\(\\s*['"]${dir.name}['"]`).test(code)) {
      bad.push(`${rel(index)}  does not call serve('${dir.name}', …)`);
    }
    if (!/from\s+['"]\.\.\/_shared\/log\.ts['"]/.test(code)) {
      bad.push(`${rel(index)}  does not import ../_shared/log.ts`);
    }
  }
  rule("every edge function is served as serve('<its name>') (L3)", bad);
}

// -------------------------------------------------------------------- L4
{
  const bad = [];
  // One line at a time: these files have no semicolons, so anything wider
  // would join a json( to an unrelated .message further down.
  const leak = /\b(?:json|Response)\s*\([^;\n]*?\(?\b(?:err|error|e|\w+Err)\b(?:\s+as\s+\w+\)?)?\??\.message\b/g;
  for (const s of notLog) {
    let m;
    while ((m = leak.exec(s.code))) bad.push(`${rel(s.file)}:${lineOf(s.code, m.index)}  ${m[0].slice(0, 90)}`);
  }
  rule("no response carries an error's own message (L4)", bad);
}

// -------------------------------------------------------------------- L5
{
  const bad = [];
  const handled = /\blog\.(?:info|warn|error)\s*\(|\bthrow\b|\bnamed\s*\(|\/\/\s*not logged:/;
  for (const s of notLog) {
    const re = /(\.)?\bcatch\b\s*/g;
    let m;
    while ((m = re.exec(s.code))) {
      let start = m.index + m[0].length;
      let body;
      if (m[1]) {
        // promise.catch( handler )
        if (s.code[start] !== '(') continue;
        body = s.raw.slice(start, matching(s.code, start) + 1);
      } else {
        // try { } catch (err) { body }
        if (s.code[start] === '(') start = matching(s.code, start) + 1;
        const open = s.code.indexOf('{', start);
        if (open < 0) continue;
        body = s.raw.slice(open, matching(s.code, open) + 1);
      }
      if (!handled.test(body)) {
        bad.push(`${rel(s.file)}:${lineOf(s.code, m.index)}  ${body.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  rule('no catch swallows an error without logging it or saying why (L5)', bad);
}

// -------------------------------------------------------------------- L6
{
  const bad = [];
  const spec = /['"](https:\/\/esm\.sh\/[^'"]+|jsr:[^'"]+|npm:[^'"]+)['"]/g;
  for (const s of sources) {
    let m;
    while ((m = spec.exec(s.code))) {
      const at = m[1].replace(/^jsr:@?|^npm:@?|^https:\/\/esm\.sh\/@?/, '');
      const version = (at.split('@')[1] || '').split(/[/?]/)[0];
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        bad.push(`${rel(s.file)}:${lineOf(s.code, m.index)}  ${m[1]}`);
      }
    }
  }
  rule('every edge function import is pinned to an exact version (L6)', bad);
}

// -------------------------------------------------------------------- L7
{
  const bad = [];
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f));
  pages.push(path.join(ROOT, 'functions', '_lib', 'site.js'));
  for (const p of pages) {
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (!/talli-config\.js/.test(src)) continue;
    if (!/<script src="\/?assets\/talli-config\.js"><\/script>\s*\n<script src="\/?assets\/talli-errors\.js"><\/script>/.test(src)) {
      bad.push(`${rel(p)}  loads talli-config.js without talli-errors.js straight after it`);
    }
  }
  rule('every page reports its errors through talli-errors.js (L7)', bad);
}

// ---------------------------------------------------------------- report
let failed = false;
for (const r of results) {
  if (r.failures.length) {
    failed = true;
    console.log(`fail|${r.name}`);
    for (const f of r.failures) console.log(`detail|${f}`);
  } else {
    console.log(`ok|${r.name}`);
  }
}
process.exit(failed ? 1 : 0);
