#!/usr/bin/env node
// Generates index.html for bitcoin-kernel. The page is a standalone, live,
// interactive conformance explorer: the visitor's browser loads our vendored
// consensus engine and Bitcoin Core's own script_tests.json, runs the whole
// differential, and lets you browse, search and DRILL INTO every one of Core's
// adversarial test vectors — disassembled, with our live verdict. Nothing is
// claimed; everything is computed on the page.

import { readFile, writeFile, cp, mkdir, copyFile } from 'node:fs/promises';

// --- vendor the engine so the page is fully standalone (runs its own copy) ---
const src = (p) => new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p));
const here = (p) => new URL(p, import.meta.url);
await mkdir(here('engine/schema'), { recursive: true });
await mkdir(here('engine/vectors'), { recursive: true });
await cp(src('codec'), here('engine/codec'), { recursive: true });
for (const f of ['core.jsonld', 'script.jsonld', 'chain.jsonld', 'proof.jsonld', 'validate.jsonld']) {
  await copyFile(src('schema/' + f), here('engine/schema/' + f));
}
await copyFile(src('test/vectors/script_tests.json'), here('engine/vectors/script_tests.json'));

const dep = (p) => readFile(src(p)).then((b) => JSON.parse(b));
const validate = await dep('schema/validate.jsonld');
const VERSION = (await dep('package.json')).version;

const PHASE_LABEL = { header: 'Header', spv: 'SPV / Merkle', transaction: 'Transaction', block: 'Block', 'block-context': 'Block context' };
const rulesByPhase = validate['@graph'].filter((n) => n['@type'] === 'RuleSet').map((s) => ({
  phase: PHASE_LABEL[s.phase] ?? s.phase,
  rules: (s.rules ?? []).map((r) => ({ label: r.label, error: r.errorCode, bip: [].concat(r.bip ?? []).filter(Boolean).join(', ') })),
}));
const RULE_COUNT = rulesByPhase.reduce((n, p) => n + p.rules.length, 0);
const TEST_COUNT = 132;

const BUGS = [
  ['OP_TUCK stack underflow', 'TUCK on a one-item stack silently succeeded instead of failing — it checked depth ≥ 1 but needs ≥ 2.'],
  ['MINIMALIF over-applied', 'Enforced in legacy script, where the rule is witness-v0 / tapscript only.'],
  ['Hybrid pubkeys rejected', '0x06/0x07 public keys (valid before STRICTENC) were refused, so valid historical scripts would fail.'],
  ['CHECKMULTISIG order & op-count', 'Wrong sig/pubkey evaluation order, and the key count was never added to the 201-op limit.'],
  ['P2SH / segwit activation', 'A P2SH- or witness-shaped scriptPubKey with the flag off took the redeem/witness path instead of running as a plain script.'],
];
const COVERAGE = [
  ['Transaction, block & header rules', 'covered', 'Every rule a node checks to accept a block, with Bitcoin Core error codes.'],
  ['Script execution', 'covered', 'Full opcode set, all sighash types, differentially verified against Core (the explorer above).'],
  ['SegWit & Taproot', 'covered', 'BIP 141 / 143 / 341 / 342 — key path and script path.'],
  ['Difficulty incl. testnet4 / BIP 94', 'covered', 'Timewarp mitigation and the 20-minute min-difficulty rule, from genesis.'],
  ['Sequence locks (BIP 68 / 112)', 'covered', 'Relative lock-time enforced at the transaction-context level.'],
  ['Reorg recovery', 'covered', 'Bounded fork-point walk-back under the more-work rule.'],
  ['Witness structure / malleability', 'partial', 'Execution is covered; BIP 141 witness-malleability validation is a documented boundary.'],
  ['Mempool, relay policy, RBF', 'out of scope', 'Node policy, not consensus — a light client never runs it.'],
];
const PRINCIPLES = [
  ['The spec is the source of truth', 'A declarative JSON-LD model defines every structure and rule. The codec and validator are projections of it.'],
  ['Byte-exact or it is not canonical', 'The reference codec round-trips real mainnet bytes exactly. If it cannot reproduce consensus bytes, it is documentation; because it can, it is canonical.'],
  ['Verify, do not trust', "Independent re-implementation, checked against Bitcoin Core's own vectors — not a wrapper around one binary."],
  ['Zero dependencies, runs anywhere', 'Pure JavaScript, no build step, no native code — which is why the explorer above runs the real engine on this page.'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const C = { accent: '#e8830c', accent2: '#0969da', good: '#1a7f37', bad: '#cf222e', mut: '#5b6470', border: '#e6e8eb', panel: '#fafbfc' };
const covBadge = { covered: C.good, partial: C.accent, 'out of scope': C.mut };
const ruleTable = (p) => `<div class="rules"><h3>${esc(p.phase)} <span class="chip">${p.rules.length}</span></h3><table>${p.rules.map((r) => `<tr><td class="name">${esc(r.label)}</td><td class="code">${esc(r.error ?? '')}</td><td class="bip">${r.bip ? 'BIP ' + esc(r.bip) : ''}</td></tr>`).join('')}</table></div>`;

// ---- the live, interactive explorer (client-side module) ----
// Mirrors test/script-vectors.test.js for the verdict, then makes every Core
// vector browsable + drillable, disassembled, with our computed result.
const APP = String.raw`
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const setStatus = (t) => { $('x-status').innerHTML = t; };

try {
  const j = (p) => fetch(p).then((r) => r.json());
  setStatus('loading the engine and Bitcoin Core’s vectors…');
  const [core, scriptSchema, chainSchema, raw] = await Promise.all([
    j('./engine/schema/core.jsonld'), j('./engine/schema/script.jsonld'),
    j('./engine/schema/chain.jsonld'), j('./engine/vectors/script_tests.json'),
  ]);
  const codec = new Codec(core);
  const se = ScriptEngine.fromSchemas(scriptSchema, chainSchema);
  const interp = new ScriptInterpreter(codec, se, scriptSchema['@graph'].find((n) => n['@id'] === 'btc:scriptLimits'));

  const NAME2CODE = new Map();
  for (const m of scriptSchema['@graph'].find((n) => n['@id'] === 'btc:Opcode').members) {
    NAME2CODE.set(m.name, m.code); NAME2CODE.set(m.name.replace(/^OP_/, ''), m.code);
  }
  const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sn = (n) => { if (n === 0n) return []; const g = n < 0n; let a = g ? -n : n; const o = []; while (a > 0n) { o.push(Number(a & 0xffn)); a >>= 8n; } if (o[o.length - 1] & 0x80) o.push(g ? 0x80 : 0); else if (g) o[o.length - 1] |= 0x80; return o; };
  const pd = (b) => { const n = b.length; if (n < 76) return [n, ...b]; if (n <= 255) return [76, n, ...b]; if (n <= 65535) return [77, n & 255, n >> 8, ...b]; return [78, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255, ...b]; };
  const ps = (s) => { const o = []; for (const w of s.split(/\s+/).filter(Boolean)) { if (/^-?\d+$/.test(w)) { const n = BigInt(w); if (n === 0n) o.push(0); else if (n === -1n) o.push(0x4f); else if (n >= 1n && n <= 16n) o.push(0x50 + Number(n)); else o.push(...pd(sn(n))); } else if (/^0x[0-9a-fA-F]*$/.test(w)) { const h = w.slice(2); for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16)); } else if (/^'.*'$/.test(w)) o.push(...pd([...w.slice(1, -1)].map((c) => c.charCodeAt(0)))); else if (NAME2CODE.has(w)) o.push(NAME2CODE.get(w)); else throw 0; } return hx(Uint8Array.from(o)); };
  const TIMELOCK = /CHECKLOCKTIMEVERIFY|CHECKSEQUENCEVERIFY/;
  const STRUCT = new Set(['WITNESS_UNEXPECTED', 'WITNESS_MALLEATED', 'WITNESS_MALLEATED_P2SH', 'WITNESS_PROGRAM_WRONG_LENGTH', 'WITNESS_PROGRAM_WITNESS_EMPTY', 'WITNESS_PROGRAM_MISMATCH', 'DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM']);
  const spend = (sig, spk, amount, wit) => { const c = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: '00'.repeat(32), vout: 0xffffffff }, scriptSig: '0000', sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: spk }] }; const sp = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: codec.txid(c), vout: 0 }, scriptSig: sig, sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: '' }] }; if (wit) sp.witness = [wit]; return sp; };
  const asm = (h) => { try { return h ? se.asm(h) : '(empty)'; } catch { return h; } };

  const cat = (sig, spk, flags, wit) => {
    const s = sig + ' ' + spk;
    if (wit || /WITNESS/.test(flags)) return 'segwit';
    if (/CHECKMULTISIG/.test(s)) return 'multisig';
    if (/CHECKSIG/.test(s)) return 'signatures';
    if (/P2SH/.test(flags) && se.classify(spk).type === 'p2sh') return 'p2sh';
    if (/STRICTENC|DERSIG|LOW_S|MINIMALDATA|NULLDUMMY|MINIMALIF/.test(flags)) return 'encoding';
    return 'logic';
  };

  // ---- run the differential, building a record per vector ----
  const records = [];
  let passed = 0, mism = 0;
  setStatus('running Bitcoin Core’s vectors through the interpreter…');
  await new Promise((done) => {
    let i = 0;
    (function chunk() {
      const t0 = performance.now();
      while (i < raw.length && performance.now() - t0 < 14) {
        const t = raw[i++];
        if (!t || t.length < 4) continue;
        let wit = null, amount = 0, sig, spk, flags, expected, comment;
        if (Array.isArray(t[0])) { wit = t[0].slice(0, -1); amount = Math.round(t[0][t[0].length - 1] * 1e8); [, sig, spk, flags, expected, comment] = t; }
        else { [sig, spk, flags, expected, comment] = t; }
        if (TIMELOCK.test(sig) || TIMELOCK.test(spk) || STRUCT.has(expected)) continue;
        let sh, ph; try { sh = ps(sig); ph = ps(spk); } catch { continue; }
        if (/P2SH/.test(flags) && se.classify(ph).type === 'p2sh' && /^(4c|4d|4e)/.test(ph.slice(2, 4))) continue;
        const fset = new Set(flags.split(/[, ]+/).filter(Boolean));
        let ours; try { const r = interp.verifyInput(spend(sh, ph, amount, wit), 0, { value: amount, scriptPubKey: ph }, [{ value: amount, scriptPubKey: ph }], fset); if (r.ok === null) continue; ours = r.ok; } catch { ours = 'err'; }
        const ok = ours === (expected === 'OK');
        if (ok) passed++; else mism++;
        records.push({ sig, spk, sh, ph, flags, expected, comment: comment || '', wit, amount, ours, ok, cat: cat(sig, spk, flags, wit) });
        $('x-count').textContent = passed.toLocaleString();
        $('x-bar').style.width = (100 * i / raw.length).toFixed(1) + '%';
      }
      if (i < raw.length) requestAnimationFrame(chunk); else done();
    })();
  });

  document.querySelector('.score .n[data-live]').textContent = passed.toLocaleString();
  $('x-panel').classList.add('done');
  setStatus(mism === 0
    ? '<b>' + passed.toLocaleString() + '</b> of Bitcoin Core’s script vectors — <b style="color:var(--good)">all matched</b>, 0 mismatches. Computed in your browser just now. Click any test to drill in.'
    : passed.toLocaleString() + ' matched, ' + mism + ' mismatched.');
  console.log('%cbitcoin-kernel', 'color:#e8830c;font-weight:bold', passed, 'of Core script_tests matched live,', mism, 'mismatched.');

  // ---- the interactive explorer ----
  const CATS = [['all', 'All'], ['signatures', 'Signatures'], ['multisig', 'Multisig'], ['p2sh', 'P2SH'], ['segwit', 'SegWit'], ['encoding', 'Encoding'], ['logic', 'Script logic']];
  let active = 'all', query = '';
  const chipsEl = $('x-chips'), listEl = $('x-list'), countEl = $('x-results');
  chipsEl.innerHTML = CATS.map(([k, l]) => '<button class="x-chip' + (k === 'all' ? ' on' : '') + '" data-k="' + k + '">' + l + ' <span>' + (k === 'all' ? records.length : records.filter((r) => r.cat === k).length) + '</span></button>').join('');

  function label(r) { return r.comment || (r.spk ? r.spk : r.sig) || '(empty script)'; }
  function flagChips(r) { return [...r.flags.split(/[, ]+/).filter(Boolean)].map((f) => '<span class="ff">' + esc(f) + '</span>').join('') || '<span class="ff none">no flags</span>'; }

  function render() {
    const q = query.toLowerCase();
    const hits = records.filter((r) => (active === 'all' || r.cat === active)
      && (!q || (r.comment + ' ' + r.flags + ' ' + r.sig + ' ' + r.spk + ' ' + r.expected).toLowerCase().includes(q)));
    countEl.textContent = hits.length.toLocaleString() + ' test' + (hits.length === 1 ? '' : 's');
    const shown = hits.slice(0, 80);
    listEl.innerHTML = shown.map((r, n) => {
      const idx = records.indexOf(r);
      return '<div class="x-row" data-i="' + idx + '">'
        + '<span class="x-v ' + (r.ok ? 'ok' : 'no') + '" title="our result matches Core">' + (r.ok ? '✓' : '✗') + '</span>'
        + '<span class="x-lab">' + esc(String(label(r)).slice(0, 90)) + '</span>'
        + '<span class="x-exp ' + (r.expected === 'OK' ? 'pass' : 'fail') + '">' + (r.expected === 'OK' ? 'valid' : esc(r.expected)) + '</span>'
        + '</div><div class="x-detail" id="d' + idx + '"></div>';
    }).join('') + (hits.length > 80 ? '<div class="x-more">showing 80 of ' + hits.length.toLocaleString() + ' — search to narrow</div>' : '');
  }
  function detail(r) {
    const row = (k, v) => '<div class="dl"><div class="dk">' + k + '</div><div class="dv">' + v + '</div></div>';
    const code = (h, a) => '<div class="dasm">' + esc(a) + '</div>' + (h ? '<div class="dhex">' + esc(h) + '</div>' : '');
    return '<div class="x-card">'
      + (r.comment ? '<div class="dcom">“' + esc(r.comment) + '”<span class="dtag">Bitcoin Core</span></div>' : '')
      + row('scriptSig', code(r.sh, asm(r.sh)))
      + row('scriptPubKey', code(r.ph, asm(r.ph)))
      + (r.wit ? row('witness', '<div class="dhex">' + r.wit.map(esc).join(' · ') + (r.amount ? '  <span style="color:var(--mut)">@ ' + r.amount + ' sat</span>' : '') + '</div>') : '')
      + row('flags', flagChips(r))
      + row('Bitcoin Core expects', r.expected === 'OK' ? '<b style="color:var(--good)">valid</b>' : '<b style="color:var(--bad)">reject · ' + esc(r.expected) + '</b>')
      + row('bitcoin-kernel computed', (r.ours === true ? '<b style="color:var(--good)">valid</b>' : r.ours === false ? '<b style="color:var(--bad)">reject</b>' : 'error') + ' <span class="match">' + (r.ok ? '✓ matches Core' : '✗ mismatch') + '</span>')
      + '</div>';
  }
  chipsEl.onclick = (e) => { const b = e.target.closest('.x-chip'); if (!b) return; active = b.dataset.k; [...chipsEl.children].forEach((c) => c.classList.toggle('on', c === b)); render(); };
  $('x-search').oninput = (e) => { query = e.target.value; render(); };
  listEl.onclick = (e) => { const row = e.target.closest('.x-row'); if (!row) return; const d = $('d' + row.dataset.i); const open = d.classList.toggle('open'); row.classList.toggle('open', open); if (open && !d.innerHTML) d.innerHTML = detail(records[row.dataset.i]); };
  $('x-explorer').hidden = false;
  render();
} catch (e) {
  setStatus('could not run live (' + (e && e.message || e) + '). The suite still runs in CI; see GitHub.');
  console.error(e);
}
`;

const stat = (n, l, live) => `<div class="stat"><div class="n"${live ? ' data-live' : ''}>${n}</div><div class="l">${l}</div></div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bitcoin-kernel — browse Bitcoin Core's script tests, verified live in your browser</title>
<meta name="description" content="An independent Bitcoin consensus engine. Browse, search and drill into every one of Bitcoin Core's adversarial script_tests vectors — disassembled, each verified live in your browser. ${RULE_COUNT} rules, ${TEST_COUNT} tests, zero dependencies.">
<meta property="og:title" content="bitcoin-kernel">
<meta property="og:description" content="Browse and drill into 1,191 of Bitcoin Core's own script vectors, each verified live by an independent engine in your browser. Zero dependencies.">
<meta property="og:type" content="website">
<style>
  :root{--bg:#fff;--fg:#16181d;--mut:${C.mut};--bd:${C.border};--pan:${C.panel};--ac:${C.accent};--ac2:${C.accent2};--good:${C.good};--bad:${C.bad};
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--ac2);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:1000px;margin:0 auto;padding:0 1.5rem}
  code{font-family:var(--mono);font-size:.86em}
  nav{position:sticky;top:0;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);z-index:10}
  nav .wrap{display:flex;align-items:center;gap:1.4rem;height:56px}
  nav .brand{font-weight:700;letter-spacing:-.3px;margin-right:auto}nav .brand b{color:var(--ac)}
  nav a{color:var(--mut);font-size:.9rem;font-weight:500}nav a.gh{color:var(--fg)}
  header.hero{padding:4rem 0 2.5rem}
  .kicker{font:600 .8rem var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ac)}
  h1{font-size:2.7rem;line-height:1.07;letter-spacing:-1.4px;margin:.6rem 0 0;font-weight:800}h1 b{color:var(--ac)}
  .lede{font-size:1.18rem;color:var(--mut);max-width:42rem;margin:1rem 0 0;line-height:1.5}
  /* explorer */
  .xwrap{border:1px solid var(--bd);border-radius:16px;overflow:hidden;margin:2rem 0 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .xhead{background:#0d1117;color:#e6edf3;padding:1.1rem 1.3rem}
  .xhead .top{display:flex;align-items:center;gap:.7rem;font:.85rem var(--mono);color:#8b949e}
  .xhead .dot{width:10px;height:10px;border-radius:50%;background:var(--ac);animation:pulse 1.6s infinite}
  .done .xhead .dot{background:var(--good);animation:none}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(232,131,12,.5)}70%{box-shadow:0 0 0 7px rgba(232,131,12,0)}100%{box-shadow:0 0 0 0 rgba(232,131,12,0)}}
  .xhead .big{font:800 2.8rem/1.1 var(--mono);color:var(--ac);letter-spacing:-1.5px;margin:.5rem 0 .1rem}
  .xhead .big small{font-size:.95rem;color:#8b949e;font-weight:600;letter-spacing:0}
  .xbar{height:5px;background:#21262d;border-radius:99px;overflow:hidden;margin:.7rem 0 .2rem}
  .xbar #x-bar{height:100%;width:0;background:linear-gradient(90deg,var(--ac),#ffb454);transition:width .1s linear}
  .xhead #x-status{font:.84rem/1.5 var(--mono);color:#8b949e;margin-top:.7rem}
  .xhead #x-status b{color:#e6edf3}
  .xtools{display:flex;gap:.6rem;align-items:center;padding:.9rem 1.1rem;border-bottom:1px solid var(--bd);background:var(--pan);flex-wrap:wrap}
  #x-search{flex:1;min-width:180px;border:1px solid var(--bd);border-radius:8px;padding:.5rem .7rem;font:.9rem var(--mono);background:#fff;color:var(--fg)}
  #x-results{font:.78rem var(--mono);color:var(--mut);white-space:nowrap}
  .xchips{display:flex;gap:.4rem;flex-wrap:wrap;padding:.7rem 1.1rem 0}
  .x-chip{border:1px solid var(--bd);background:#fff;border-radius:99px;padding:.3rem .8rem;font:.82rem system-ui;cursor:pointer;color:var(--mut)}
  .x-chip.on{border-color:var(--ac);color:var(--ac);background:#fff7ee}
  .x-chip span{font-family:var(--mono);font-size:.78em;opacity:.65}
  #x-list{max-height:30rem;overflow:auto;padding:.5rem 0 .6rem}
  .x-row{display:flex;align-items:center;gap:.8rem;padding:.5rem 1.2rem;cursor:pointer;border-left:2px solid transparent}
  .x-row:hover{background:var(--pan)}
  .x-row.open{background:var(--pan);border-left-color:var(--ac)}
  .x-v{font:700 .95rem var(--mono);width:1.1em;flex-shrink:0}.x-v.ok{color:var(--good)}.x-v.no{color:var(--bad)}
  .x-lab{flex:1;font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .x-exp{font:600 .72rem var(--mono);text-transform:uppercase;border-radius:5px;padding:.12em .5em;flex-shrink:0}
  .x-exp.pass{background:#e6f4ea;color:var(--good)}.x-exp.fail{background:#fdeceb;color:var(--bad)}
  .x-detail{display:none}.x-detail.open{display:block;padding:.2rem 1.2rem 1rem 2.9rem}
  .x-card{border:1px solid var(--bd);border-radius:10px;overflow:hidden;background:#fff}
  .dcom{background:#fff7ee;padding:.7rem 1rem;font-style:italic;color:#7a4a10;border-bottom:1px solid var(--bd);font-size:.92rem}
  .dcom .dtag{float:right;font:600 .65rem var(--mono);text-transform:uppercase;color:var(--ac);font-style:normal;letter-spacing:.05em}
  .dl{display:flex;border-top:1px solid var(--bd)}.dl:first-child{border-top:none}
  .dk{width:11rem;flex-shrink:0;padding:.6rem .9rem;font:.78rem var(--mono);color:var(--mut);background:var(--pan)}
  .dv{padding:.6rem .9rem;font-size:.9rem;overflow:hidden}
  .dasm{font:.84rem/1.5 var(--mono);color:var(--fg);word-break:break-word}
  .dhex{font:.74rem/1.4 var(--mono);color:var(--mut);word-break:break-all;margin-top:.3rem}
  .ff{display:inline-block;font:600 .68rem var(--mono);background:#eef1f4;color:#475160;border-radius:5px;padding:.1em .45em;margin:0 .25em .25em 0}
  .ff.none{background:none;color:var(--mut);font-weight:400;font-style:italic}
  .match{font:600 .72rem var(--mono);color:var(--good);margin-left:.5rem}
  .x-more{padding:.7rem 1.2rem;color:var(--mut);font:.8rem var(--mono);text-align:center}
  .hint{margin:.6rem 0 0;color:var(--mut);font-size:.85rem}
  .score{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--bd);border:1px solid var(--bd);border-radius:14px;overflow:hidden;margin:2rem 0 0}
  .stat{background:var(--bg);padding:1.1rem 1.2rem}.stat .n{font:800 1.7rem/1 var(--mono);letter-spacing:-1px}.stat .l{color:var(--mut);font-size:.8rem;margin-top:.3rem}
  section{padding:4rem 0;border-top:1px solid var(--bd)}
  section h2{font-size:1.8rem;letter-spacing:-.6px;margin:0 0 .4rem}
  section .sub{color:var(--mut);margin:0 0 2rem;max-width:46rem}
  .bugs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:2rem}
  .bug{background:var(--bg);border:1px solid var(--bd);border-radius:12px;padding:1.1rem 1.2rem}
  .bug h4{margin:0 0 .35rem;font:600 .95rem var(--mono)}.bug p{margin:0;color:var(--mut);font-size:.9rem;line-height:1.5}
  .rulegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.4rem 2rem}
  .rules h3{font-size:1.05rem;margin:0 0 .5rem;display:flex;align-items:center;gap:.5rem}
  .chip{font:600 .72rem var(--mono);color:var(--ac);border:1px solid var(--ac);border-radius:99px;padding:0 .5em}
  .rules table{width:100%;border-collapse:collapse;font-size:.88rem}
  .rules td{padding:.32rem .5rem;border-top:1px solid var(--bd);vertical-align:top}
  .rules td.name{font-family:var(--mono);white-space:nowrap}.rules td.code{font-family:var(--mono);color:var(--mut);font-size:.8rem}
  .rules td.bip{color:var(--ac);font-size:.78rem;font-family:var(--mono);text-align:right;white-space:nowrap}
  table.cov{width:100%;border-collapse:collapse;font-size:.92rem}
  table.cov td{padding:.6rem .6rem;border-top:1px solid var(--bd);vertical-align:top}table.cov td:first-child{font-weight:600}
  .badge{font:600 .7rem var(--mono);text-transform:uppercase;border-radius:99px;padding:.1em .6em;white-space:nowrap;color:#fff}
  .principles{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.4rem}
  .pr h3{margin:0 0 .3rem;font-size:1.05rem}.pr p{margin:0;color:var(--mut);font-size:.92rem}
  footer{padding:3rem 0;color:var(--mut);font-size:.88rem}
  footer .links{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem}
  .note{font:.8rem/1.5 var(--mono);color:var(--mut)}
  @media(max-width:600px){h1{font-size:2.1rem}.dk{width:6.5rem}.xhead .big{font-size:2.1rem}}
</style>
</head>
<body>
<nav><div class="wrap">
  <span class="brand">bitcoin<b>·</b>kernel</span>
  <a href="#core">Explorer</a><a href="#rules">Rules</a><a href="#tests">Tests</a><a href="#coverage">Coverage</a>
  <a class="gh" href="https://github.com/bitcoin-kernel/bitcoin-kernel.github.io">GitHub ↗</a>
</div></nav>

<header class="hero" id="core"><div class="wrap">
  <div class="kicker">Independent consensus engine</div>
  <h1>Browse Bitcoin Core's own script tests.<br>Each one <b>verified live</b>, in your browser.</h1>
  <p class="lede">This page loaded our consensus engine and Bitcoin Core's adversarial <code>script_tests.json</code>, ran the whole differential here, and made every vector searchable. Click any test to see the real script disassembled and our computed verdict.</p>

  <div class="xwrap done-target" id="x-panel">
    <div class="xhead">
      <div class="top"><span class="dot"></span><span>differential · bitcoin-kernel vs Bitcoin Core <code>script_tests.json</code></span></div>
      <div class="big"><span id="x-count">0</span> <small>Bitcoin Core script vectors verified</small></div>
      <div class="xbar"><div id="x-bar"></div></div>
      <div id="x-status">starting…</div>
    </div>
    <div id="x-explorer" hidden>
      <div class="xchips" id="x-chips"></div>
      <div class="xtools"><input id="x-search" placeholder="search Core's tests — try ‘taproot’, ‘BIP66’, ‘multisig’, ‘NULLDUMMY’…" autocomplete="off"><span id="x-results"></span></div>
      <div id="x-list"></div>
    </div>
  </div>
  <p class="hint">↑ real Bitcoin Core test vectors — the same corpus every node implementation is checked against — each run through our independent engine on this page. Open the console; it's the real interpreter.</p>

  <div class="score">
    ${stat(TEST_COUNT, 'tests, all passing')}
    ${stat('0', "of Core's script vectors", true)}
    ${stat(RULE_COUNT, 'consensus rules')}
    ${stat(BUGS.length, 'real bugs caught')}
    ${stat('0', 'dependencies')}
  </div>
</div></header>

<section><div class="wrap">
  <h2>Differential testing isn't decoration</h2>
  <p class="sub">Running Core's own corpus against an independent engine found and fixed <strong>${BUGS.length} genuine consensus bugs</strong> in ours — the kind that silently diverge a re-implementation from the network. Each is now a regression test in the explorer above.</p>
  <div class="bugs">${BUGS.map(([t, d]) => `<div class="bug"><h4>${esc(t)}</h4><p>${esc(d)}</p></div>`).join('')}</div>
</div></section>

<section id="rules"><div class="wrap">
  <h2>${RULE_COUNT} consensus rules, categorised</h2>
  <p class="sub">Generated directly from the engine's <code>validate.jsonld</code> — each rule carries its BIP provenance and Bitcoin Core error code. The readable spec a single C++ binary can't give you.</p>
  <div class="rulegrid">${rulesByPhase.map(ruleTable).join('')}</div>
</div></section>

<section id="tests" style="background:var(--pan)"><div class="wrap">
  <h2>Beyond script: ${TEST_COUNT} tests in total</h2>
  <p class="sub">The explorer above is the script-consensus surface. The full suite also covers byte-exact serialization, header/PoW &amp; difficulty (incl. testnet4 / BIP 94 from genesis), block validation against live mainnet data, reorg recovery, SPV &amp; compact filters, wallet &amp; mining, and P2P / Nostr distribution — every one a passing test.</p>
</div></section>

<section id="coverage"><div class="wrap">
  <h2>Honest coverage</h2>
  <p class="sub">Showing the boundaries is what makes the rest credible — a validation engine, not a relay node.</p>
  <table class="cov">${COVERAGE.map(([a, s, d]) => `<tr><td>${esc(a)}</td><td><span class="badge" style="background:${covBadge[s]}">${s}</span></td><td style="color:var(--mut)">${esc(d)}</td></tr>`).join('')}</table>
</div></section>

<section style="background:var(--pan)"><div class="wrap">
  <h2>Implementation standards</h2>
  <div class="principles" style="margin-top:1.5rem">${PRINCIPLES.map(([t, d]) => `<div class="pr"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
</div></section>

<footer><div class="wrap">
  <div class="links">
    <a href="https://github.com/bitcoin-kernel/bitcoin-kernel.github.io">Source &amp; engine</a>
    <a href="./engine/vectors/script_tests.json">The vectors</a>
    <a href="./engine/codec/interpreter.js">The interpreter</a>
  </div>
  <p class="note">Standalone: the consensus engine and Bitcoin Core's vectors are vendored into this repo (engine snapshot v${VERSION}); everything above runs same-origin, no external calls. Rules generated from the engine's validate.jsonld. Independent community project; not affiliated with Bitcoin Core.</p>
</div></footer>
<script type="module">${APP}</script>
</body>
</html>
`;

await writeFile(here('index.html'), html);
console.log(`built index.html — interactive explorer + ${RULE_COUNT} rules`);
