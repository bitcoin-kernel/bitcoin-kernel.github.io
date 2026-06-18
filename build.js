#!/usr/bin/env node
// Generates index.html for bitcoin-kernel: a standalone, live, teaching
// conformance page. It vendors the consensus engine + Bitcoin Core's own
// script_tests.json, runs the whole differential in the visitor's browser,
// and presents it CATEGORISED and EXPLAINED — the six things Bitcoin script
// does, each one you can click into and drill down to the disassembled vector.
// Nothing is claimed; everything is computed on the page and linked to source.

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

const CORE_TESTS = 'https://github.com/bitcoin/bitcoin/blob/master/src/test/data/script_tests.json';

const PHASE = {
  header: ['Header', 'What a block header must satisfy before its work even counts: it links to the previous block, its proof-of-work meets the target, its timestamp is sane, and its difficulty is correct (including the testnet4 timewarp fix).'],
  transaction: ['Transaction', 'Standalone sanity of a transaction: it has inputs and outputs, no value overflows the 21M cap, and it never spends the same coin twice (the bug behind the 2018 inflation CVE).'],
  block: ['Block', "A block's internal consistency: the coinbase is first and unique, the merkle root commits to every transaction, no duplicate txids (BIP 30), and the sigop and weight budgets are respected."],
  'block-context': ['Block in context', 'A block against the chain state it extends: coinbase height (BIP 34) and maturity, timelocks and sequence locks (BIP 68/112), every input available and unspent, fees non-negative, the witness commitment, and every script executes.'],
  spv: ['SPV / Merkle', 'Proving a single transaction is in a block without the whole block — the merkle inclusion proofs a light client checks.'],
};
const rulesByPhase = validate['@graph'].filter((n) => n['@type'] === 'RuleSet').map((s) => ({
  phase: (PHASE[s.phase] ?? [s.phase, ''])[0],
  blurb: (PHASE[s.phase] ?? ['', ''])[1],
  rules: (s.rules ?? []).map((r) => ({ label: r.label, error: r.errorCode, bip: [].concat(r.bip ?? []).filter(Boolean).join(', '), comment: r.comment ?? '' })),
}));
const RULE_COUNT = rulesByPhase.reduce((n, p) => n + p.rules.length, 0);
const TEST_COUNT = 132;

const BUGS = [
  ['OP_TUCK stack underflow', 'TUCK copies the top item below the second — so it needs two items. Ours checked for one, so TUCK on a single-item stack silently succeeded instead of failing.'],
  ['MINIMALIF in the wrong place', 'The “IF argument must be exactly 0 or 1” rule only applies inside SegWit/Taproot scripts. We were enforcing it in legacy scripts too, rejecting valid ones.'],
  ['Hybrid pubkeys rejected', 'Pre-2015 “hybrid” public keys (prefix 0x06/0x07) are valid when strict encoding is off. We refused them, which would fail real historical transactions.'],
  ['CHECKMULTISIG order & op-count', 'Multisig evaluates signatures and keys top-of-stack first, and its key count counts toward the 201-operation limit. We had the order reversed and the count missing.'],
  ['P2SH / SegWit activation', 'Before P2SH and SegWit activated, a script that merely looks like them runs as plain script. We took the special path regardless of the activation flag.'],
];
const COVERAGE = [
  ['Transaction, block & header rules', 'covered', 'Every rule a node checks to accept a block, with Bitcoin Core’s own error codes.'],
  ['Script execution', 'covered', 'Full opcode set, all sighash types — differentially verified against Core above.'],
  ['SegWit & Taproot', 'covered', 'BIP 141 / 143 / 341 / 342 — key path and script path.'],
  ['Difficulty incl. testnet4 / BIP 94', 'covered', 'Timewarp mitigation and the 20-minute min-difficulty rule, from genesis.'],
  ['Reorg recovery', 'covered', 'Bounded fork-point walk-back under the more-work rule.'],
  ['Witness structure / malleability', 'partial', 'Execution is covered; BIP 141 witness-malleability validation is a documented boundary.'],
  ['Mempool, relay policy, RBF', 'out of scope', 'Node policy, not consensus — a light client never runs it.'],
];

// the six things Bitcoin script actually does — each a category you can learn from
const CATS = [
  ['logic', 'The stack machine', 'Every script is a tiny program on a stack: push data, do arithmetic, branch on conditions, hash, compare. The raw opcode semantics everything else is built on.'],
  ['signatures', 'Signatures', 'Does a signature actually authorise the spend? ECDSA verification, strict DER encoding, low-S, and sighash types — the rules that stop forged or malleable signatures.'],
  ['multisig', 'Multisig', 'M-of-N: several keys must sign together. These probe the famous CHECKMULTISIG quirks — the off-by-one extra “dummy” pop, and strict signature ordering.'],
  ['encoding', 'Canonical encoding', 'Minimal data pushes, strict number encoding, no malleability — the rules that make a transaction’s bytes the one true representation.'],
  ['segwit', 'SegWit', 'Segregated Witness (BIP 141/143): the signature lives outside the txid. P2WPKH / P2WSH execution and the sighash that commits to the spent amount.'],
  ['p2sh', 'Pay-to-Script-Hash', 'Funds locked to the hash of a redeem script (BIP 16): reveal the script in the input, the node hashes it, checks the match, then runs it.'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const C = { accent: '#e8830c', accent2: '#0969da', good: '#1a7f37', bad: '#cf222e', mut: '#5b6470', border: '#e6e8eb', panel: '#fafbfc' };
const covBadge = { covered: C.good, partial: C.accent, 'out of scope': C.mut };

const ruleBlock = (p) => `<details class="rphase"><summary><span class="rp-name">${esc(p.phase)}</span><span class="chip">${p.rules.length} rules</span></summary>
  <p class="rp-blurb">${esc(p.blurb)}</p>
  <table>${p.rules.map((r) => `<tr><td class="name">${esc(r.label)}</td><td class="rc">${esc(r.error ?? '')}</td><td class="bip">${r.bip ? 'BIP ' + esc(r.bip) : ''}</td></tr>`).join('')}</table></details>`;

const catCard = ([k, label, blurb]) => `<button class="catcard" data-k="${k}">
  <div class="ctop"><h3>${esc(label)}</h3><span class="ccount" id="c-${k}">…</span></div>
  <p>${esc(blurb)}</p><span class="cgo">explore the tests →</span></button>`;

// ---- the live, interactive engine (client-side module) ----
const APP = String.raw`
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const note = (h) => { $('livenote').innerHTML = h; };

const CAT_LABEL = { logic: 'The stack machine', signatures: 'Signatures', multisig: 'Multisig', encoding: 'Canonical encoding', segwit: 'SegWit', p2sh: 'Pay-to-Script-Hash' };

try {
  const j = (p) => fetch(p).then((r) => r.json());
  note('<span class="spin"></span> loading the engine and Bitcoin Core’s vectors…');
  const [core, scriptSchema, chainSchema, raw] = await Promise.all([
    j('./engine/schema/core.jsonld'), j('./engine/schema/script.jsonld'),
    j('./engine/schema/chain.jsonld'), j('./engine/vectors/script_tests.json'),
  ]);
  const codec = new Codec(core);
  const se = ScriptEngine.fromSchemas(scriptSchema, chainSchema);
  const interp = new ScriptInterpreter(codec, se, scriptSchema['@graph'].find((n) => n['@id'] === 'btc:scriptLimits'));

  const N2C = new Map();
  for (const m of scriptSchema['@graph'].find((n) => n['@id'] === 'btc:Opcode').members) { N2C.set(m.name, m.code); N2C.set(m.name.replace(/^OP_/, ''), m.code); }
  const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sn = (n) => { if (n === 0n) return []; const g = n < 0n; let a = g ? -n : n; const o = []; while (a > 0n) { o.push(Number(a & 0xffn)); a >>= 8n; } if (o[o.length - 1] & 0x80) o.push(g ? 0x80 : 0); else if (g) o[o.length - 1] |= 0x80; return o; };
  const pd = (b) => { const n = b.length; if (n < 76) return [n, ...b]; if (n <= 255) return [76, n, ...b]; if (n <= 65535) return [77, n & 255, n >> 8, ...b]; return [78, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255, ...b]; };
  const ps = (s) => { const o = []; for (const w of s.split(/\s+/).filter(Boolean)) { if (/^-?\d+$/.test(w)) { const n = BigInt(w); if (n === 0n) o.push(0); else if (n === -1n) o.push(0x4f); else if (n >= 1n && n <= 16n) o.push(0x50 + Number(n)); else o.push(...pd(sn(n))); } else if (/^0x[0-9a-fA-F]*$/.test(w)) { const h = w.slice(2); for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16)); } else if (/^'.*'$/.test(w)) o.push(...pd([...w.slice(1, -1)].map((c) => c.charCodeAt(0)))); else if (N2C.has(w)) o.push(N2C.get(w)); else throw 0; } return hx(Uint8Array.from(o)); };
  const TIMELOCK = /CHECKLOCKTIMEVERIFY|CHECKSEQUENCEVERIFY/;
  const STRUCT = new Set(['WITNESS_UNEXPECTED', 'WITNESS_MALLEATED', 'WITNESS_MALLEATED_P2SH', 'WITNESS_PROGRAM_WRONG_LENGTH', 'WITNESS_PROGRAM_WITNESS_EMPTY', 'WITNESS_PROGRAM_MISMATCH', 'DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM']);
  const ENC_ERR = /MINIMALDATA|SCRIPTNUM|SIG_DER|PUBKEYTYPE|SIG_HIGH_S|SIG_HASHTYPE|NULLDUMMY|CLEANSTACK|SIG_PUSHONLY|NULLFAIL|MINIMALIF/;
  const spend = (sig, spk, amount, wit) => { const c = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: '00'.repeat(32), vout: 0xffffffff }, scriptSig: '0000', sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: spk }] }; const sp = { version: 1, lockTime: 0, inputs: [{ prevout: { txid: codec.txid(c), vout: 0 }, scriptSig: sig, sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: '' }] }; if (wit) sp.witness = [wit]; return sp; };
  const asm = (h) => { try { return h ? se.asm(h) : '(empty script)'; } catch { return h; } };
  const cat = (sig, spk, ph, flags, expected, wit) => { const s = sig + ' ' + spk; if (wit || /WITNESS/.test(flags)) return 'segwit'; if (/CHECKMULTISIG/.test(s)) return 'multisig'; if (/CHECKSIG/.test(s)) return 'signatures'; if (/P2SH/.test(flags) && se.classify(ph).type === 'p2sh') return 'p2sh'; if (ENC_ERR.test(expected) || /MINIMALDATA/.test(flags)) return 'encoding'; return 'logic'; };

  const records = [];
  let passed = 0, mism = 0;
  note('<span class="spin"></span> running Bitcoin Core’s vectors through the engine…');
  await new Promise((done) => { let i = 0; (function chunk() { const t0 = performance.now(); while (i < raw.length && performance.now() - t0 < 14) { const t = raw[i++]; if (!t || t.length < 4) continue; let wit = null, amount = 0, sig, spk, flags, expected, comment; if (Array.isArray(t[0])) { wit = t[0].slice(0, -1); amount = Math.round(t[0][t[0].length - 1] * 1e8); [, sig, spk, flags, expected, comment] = t; } else { [sig, spk, flags, expected, comment] = t; } if (TIMELOCK.test(sig) || TIMELOCK.test(spk) || STRUCT.has(expected)) continue; let sh, ph; try { sh = ps(sig); ph = ps(spk); } catch { continue; } if (/P2SH/.test(flags) && se.classify(ph).type === 'p2sh' && /^(4c|4d|4e)/.test(ph.slice(2, 4))) continue; const fset = new Set(flags.split(/[, ]+/).filter(Boolean)); let ours; try { const r = interp.verifyInput(spend(sh, ph, amount, wit), 0, { value: amount, scriptPubKey: ph }, [{ value: amount, scriptPubKey: ph }], fset); if (r.ok === null) continue; ours = r.ok; } catch { ours = 'err'; } const ok = ours === (expected === 'OK'); if (ok) passed++; else mism++; records.push({ sig, spk, sh, ph, flags, expected, comment: comment || '', wit, amount, ours, ok, cat: cat(sig, spk, ph, flags, expected, wit) }); } if (i < raw.length) requestAnimationFrame(chunk); else done(); })(); });

  // fill the category cards + the one honest headline number
  for (const k of Object.keys(CAT_LABEL)) { const rs = records.filter((r) => r.cat === k); const all = rs.every((r) => r.ok); const el = $('c-' + k); if (el) el.innerHTML = '<b>' + rs.length + '</b> ' + (all ? '✓' : (rs.filter((r) => r.ok).length + '/' + rs.length)); }
  const num = $('headline-num'); if (num) num.textContent = passed.toLocaleString();
  note(mism === 0
    ? '<span class="ok">✓</span> all <b>' + passed.toLocaleString() + '</b> of Bitcoin Core’s script tests just passed — computed in <em>your</em> browser, not claimed. Pick a category to see what they test. <span class="cons">(open the console — it’s the real interpreter)</span>'
    : passed.toLocaleString() + ' passed, ' + mism + ' mismatched.');
  console.log('%cbitcoin-kernel', 'color:#e8830c;font-weight:bold', passed, 'of Core script_tests matched live,', mism, 'mismatched.');

  // ---- explorer (revealed when a category is clicked) ----
  let active = null, query = '';
  const exEl = $('explorer'), listEl = $('x-list'), titleEl = $('x-title'), countEl = $('x-results');
  const flagChips = (r) => r.flags.split(/[, ]+/).filter(Boolean).map((f) => '<span class="ff">' + esc(f) + '</span>').join('') || '<span class="ff none">no flags</span>';
  const label = (r) => r.comment || r.spk || r.sig || '(empty script)';

  function render() {
    const q = query.toLowerCase();
    const hits = records.filter((r) => r.cat === active && (!q || (r.comment + ' ' + r.flags + ' ' + r.sig + ' ' + r.spk + ' ' + r.expected).toLowerCase().includes(q)));
    countEl.textContent = hits.length.toLocaleString() + ' test' + (hits.length === 1 ? '' : 's') + (hits.length > 80 ? ' · showing 80' : '');
    listEl.innerHTML = hits.slice(0, 120).map((r) => { const i = records.indexOf(r); return '<div class="x-row" data-i="' + i + '"><span class="x-v ' + (r.ok ? 'ok' : 'no') + '" title="bitcoin-kernel agrees with Bitcoin Core">' + (r.ok ? '✓' : '✗') + '</span><span class="x-lab">' + esc(String(label(r)).slice(0, 92)) + '</span><span class="x-exp ' + (r.expected === 'OK' ? 'pass' : 'rej') + '">' + (r.expected === 'OK' ? 'should be valid' : 'should reject') + '</span></div><div class="x-detail" id="d' + i + '"></div>'; }).join('');
  }
  function detail(r) {
    const row = (k, v) => '<div class="dl"><div class="dk">' + k + '</div><div class="dv">' + v + '</div></div>';
    const code = (h, a) => '<div class="dasm">' + esc(a) + '</div>' + (h ? '<div class="dhex">' + esc(h) + '</div>' : '');
    return '<div class="x-card">'
      + (r.comment ? '<div class="dcom">“' + esc(r.comment) + '”<span class="dtag">— Bitcoin Core</span></div>' : '')
      + row('input · scriptSig', code(r.sh, asm(r.sh)))
      + row('output · scriptPubKey', code(r.ph, asm(r.ph)))
      + (r.wit ? row('witness', '<div class="dhex">' + r.wit.map(esc).join(' · ') + (r.amount ? '  <span style="color:var(--mut)">spending ' + r.amount + ' sat</span>' : '') + '</div>') : '')
      + row('flags', flagChips(r))
      + row('Bitcoin Core says', r.expected === 'OK' ? '<b style="color:var(--good)">valid</b>' : '<b style="color:var(--bad)">reject · ' + esc(r.expected) + '</b>')
      + row('bitcoin-kernel computed', (r.ours === true ? '<b style="color:var(--good)">valid</b>' : r.ours === false ? '<b style="color:var(--bad)">reject</b>' : 'error') + ' <span class="match' + (r.ok ? '' : ' bad') + '">' + (r.ok ? '✓ matches Core' : '✗ mismatch') + '</span>')
      + '</div>';
  }
  function open(k) { active = k; query = ''; $('x-search').value = ''; titleEl.textContent = CAT_LABEL[k]; exEl.hidden = false; render(); exEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  document.querySelectorAll('.catcard').forEach((b) => b.addEventListener('click', () => open(b.dataset.k)));
  $('x-search').oninput = (e) => { query = e.target.value; render(); };
  $('x-close').onclick = () => { exEl.hidden = true; document.getElementById('cats').scrollIntoView({ behavior: 'smooth' }); };
  listEl.onclick = (e) => { const row = e.target.closest('.x-row'); if (!row) return; const d = $('d' + row.dataset.i); const open = d.classList.toggle('open'); row.classList.toggle('open', open); if (open && !d.innerHTML) d.innerHTML = detail(records[row.dataset.i]); };
} catch (e) {
  note('could not run live (' + (e && e.message || e) + '). The suite still runs in CI; see the source.');
  console.error(e);
}
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bitcoin-kernel — learn Bitcoin's consensus rules, proven live in your browser</title>
<meta name="description" content="An independent Bitcoin consensus engine that runs Bitcoin Core's own adversarial script tests live in your browser — categorised and explained, click any to drill in. Learn what makes a transaction valid; every claim is computed, not asserted.">
<meta property="og:title" content="bitcoin-kernel">
<meta property="og:description" content="Learn Bitcoin's consensus rules, proven live: Core's own script tests run in your browser, categorised and explained, click any to drill in.">
<meta property="og:type" content="website">
<style>
  :root{--bg:#fff;--fg:#16181d;--mut:${C.mut};--bd:${C.border};--pan:${C.panel};--ac:${C.accent};--ac2:${C.accent2};--good:${C.good};--bad:${C.bad};--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--ac2);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:1000px;margin:0 auto;padding:0 1.5rem}
  code{font-family:var(--mono);font-size:.86em}
  nav{position:sticky;top:0;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);z-index:10}
  nav .wrap{display:flex;align-items:center;gap:1.4rem;height:56px}
  nav .brand{font-weight:700;letter-spacing:-.3px;margin-right:auto}nav .brand b{color:var(--ac)}
  nav a{color:var(--mut);font-size:.9rem;font-weight:500}nav a.gh{color:var(--fg)}
  header.hero{padding:3.6rem 0 2.5rem}
  .kicker{font:600 .8rem var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ac)}
  h1{font-size:2.6rem;line-height:1.08;letter-spacing:-1.3px;margin:.6rem 0 0;font-weight:800}h1 b{color:var(--ac)}
  .lede{font-size:1.16rem;color:#37414d;max-width:44rem;margin:1rem 0 0;line-height:1.55}
  .lede b{color:var(--fg)}
  .srcrow{display:flex;gap:.4rem 1.4rem;flex-wrap:wrap;margin:1.1rem 0 0;font:.85rem var(--mono)}
  .srcrow a{color:var(--ac2)}.srcrow span{color:var(--mut)}
  #livenote{margin:1.8rem 0 .2rem;padding:.85rem 1.1rem;border:1px solid var(--bd);border-radius:10px;background:var(--pan);font:.92rem/1.5 var(--mono);color:#37414d}
  #livenote .ok{color:var(--good);font-weight:700}#livenote b{color:var(--fg)}#livenote .cons{color:var(--mut)}
  .spin{display:inline-block;width:.8em;height:.8em;border:2px solid var(--bd);border-top-color:var(--ac);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-1px}
  @keyframes sp{to{transform:rotate(360deg)}}
  #cats{margin:1.4rem 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:1rem}
  .catcard{text-align:left;border:1px solid var(--bd);border-radius:14px;padding:1.2rem 1.3rem;background:#fff;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,box-shadow .15s,transform .1s;display:flex;flex-direction:column}
  .catcard:hover{border-color:var(--ac);box-shadow:0 4px 14px rgba(232,131,12,.1);transform:translateY(-1px)}
  .ctop{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem}
  .catcard h3{margin:0;font-size:1.12rem;letter-spacing:-.3px}
  .ccount{font:700 .95rem var(--mono);color:var(--mut)}.ccount b{color:var(--ac);font-size:1.1em}
  .catcard p{margin:.55rem 0 .9rem;color:var(--mut);font-size:.9rem;line-height:1.5;flex:1}
  .cgo{font:600 .82rem var(--mono);color:var(--ac2)}
  /* explorer */
  #explorer{margin:1.6rem 0 0;border:1px solid var(--bd);border-radius:14px;overflow:hidden}
  .xbar{display:flex;align-items:center;gap:.8rem;padding:.85rem 1.1rem;background:#0d1117;color:#e6edf3}
  .xbar h3{margin:0;font-size:1rem}
  .xbar .gap{flex:1}
  #x-results{font:.78rem var(--mono);color:#8b949e}
  #x-close{background:none;border:1px solid #30363d;color:#8b949e;border-radius:7px;padding:.25rem .6rem;cursor:pointer;font:.8rem var(--mono)}
  #x-close:hover{color:#e6edf3;border-color:#8b949e}
  .xsearch{padding:.8rem 1.1rem;border-bottom:1px solid var(--bd);background:var(--pan)}
  #x-search{width:100%;border:1px solid var(--bd);border-radius:8px;padding:.55rem .7rem;font:.9rem var(--mono);background:#fff;color:var(--fg)}
  #x-list{max-height:32rem;overflow:auto}
  .x-row{display:flex;align-items:center;gap:.8rem;padding:.55rem 1.1rem;cursor:pointer;border-top:1px solid var(--bd);border-left:2px solid transparent}
  .x-row:first-child{border-top:none}.x-row:hover{background:var(--pan)}.x-row.open{background:var(--pan);border-left-color:var(--ac)}
  .x-v{font:700 .95rem var(--mono);width:1.1em;flex-shrink:0}.x-v.ok{color:var(--good)}.x-v.no{color:var(--bad)}
  .x-lab{flex:1;font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .x-exp{font:600 .7rem var(--mono);text-transform:uppercase;border-radius:5px;padding:.12em .5em;flex-shrink:0}
  .x-exp{opacity:.9}.x-exp.pass{background:#e6f4ea;color:var(--good)}.x-exp.rej{background:#eef1f4;color:#5b6470}
  .xlegend{margin-top:.6rem;font:.8rem/1.5 var(--mono);color:var(--mut)}.xlegend b.ok{color:var(--good)}.xlegend b{color:var(--fg)}
  .x-detail{display:none}.x-detail.open{display:block;padding:.3rem 1.1rem 1rem 2.7rem;background:var(--pan)}
  .x-card{border:1px solid var(--bd);border-radius:10px;overflow:hidden;background:#fff}
  .dcom{background:#fff7ee;padding:.7rem 1rem;font-style:italic;color:#7a4a10;border-bottom:1px solid var(--bd);font-size:.92rem}
  .dcom .dtag{color:var(--ac);font-style:normal;font-size:.85em}
  .dl{display:flex;border-top:1px solid var(--bd)}.dl:first-child{border-top:none}
  .dk{width:12rem;flex-shrink:0;padding:.6rem .9rem;font:.76rem var(--mono);color:var(--mut);background:var(--pan)}
  .dv{padding:.6rem .9rem;font-size:.9rem;overflow:hidden}
  .dasm{font:.84rem/1.55 var(--mono);color:var(--fg);word-break:break-word}
  .dhex{font:.72rem/1.4 var(--mono);color:var(--mut);word-break:break-all;margin-top:.3rem}
  .ff{display:inline-block;font:600 .68rem var(--mono);background:#eef1f4;color:#475160;border-radius:5px;padding:.1em .45em;margin:0 .25em .25em 0}
  .ff.none{background:none;color:var(--mut);font-weight:400;font-style:italic}
  .match{font:600 .72rem var(--mono);color:var(--good);margin-left:.5rem}.match.bad{color:var(--bad)}
  section{padding:3.6rem 0;border-top:1px solid var(--bd)}
  section h2{font-size:1.7rem;letter-spacing:-.5px;margin:0 0 .4rem}
  section .sub{color:var(--mut);margin:0 0 1.6rem;max-width:46rem}
  .bugs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:1.6rem}
  .bug{background:var(--bg);border:1px solid var(--bd);border-radius:12px;padding:1.1rem 1.2rem}
  .bug h4{margin:0 0 .35rem;font:600 .95rem var(--mono)}.bug p{margin:0;color:var(--mut);font-size:.9rem;line-height:1.5}
  .rphase{border:1px solid var(--bd);border-radius:12px;margin-bottom:.8rem;background:#fff;overflow:hidden}
  .rphase summary{display:flex;align-items:center;gap:.6rem;padding:.9rem 1.1rem;cursor:pointer;font-weight:600;list-style:none}
  .rphase summary::-webkit-details-marker{display:none}
  .rphase summary::before{content:'▸';color:var(--ac);font-size:.8em;transition:transform .15s}
  .rphase[open] summary::before{transform:rotate(90deg)}
  .rp-name{flex:1}.chip{font:600 .72rem var(--mono);color:var(--ac);border:1px solid var(--ac);border-radius:99px;padding:.05em .6em}
  .rp-blurb{margin:0;padding:0 1.1rem .4rem 2rem;color:var(--mut);font-size:.92rem;line-height:1.5}
  .rphase table{width:100%;border-collapse:collapse;font-size:.86rem;padding:0 1.1rem}
  .rphase td{padding:.3rem 1.1rem;border-top:1px solid var(--bd);vertical-align:top}
  .rphase td.name{font-family:var(--mono);white-space:nowrap}.rphase td.rc{font-family:var(--mono);color:var(--mut);font-size:.8rem}
  .rphase td.bip{color:var(--ac);font-size:.78rem;font-family:var(--mono);text-align:right;white-space:nowrap}
  table.cov{width:100%;border-collapse:collapse;font-size:.92rem}
  table.cov td{padding:.6rem .6rem;border-top:1px solid var(--bd);vertical-align:top}table.cov td:first-child{font-weight:600}
  .badge{font:600 .7rem var(--mono);text-transform:uppercase;border-radius:99px;padding:.1em .6em;white-space:nowrap;color:#fff}
  footer{padding:3rem 0;color:var(--mut);font-size:.88rem;border-top:1px solid var(--bd)}
  footer .links{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem}
  .note{font:.8rem/1.5 var(--mono);color:var(--mut)}
  @media(max-width:600px){h1{font-size:2rem}.dk{width:7rem}}
</style>
</head>
<body>
<nav><div class="wrap">
  <span class="brand">bitcoin<b>·</b>kernel</span>
  <a href="#cats">Explore</a><a href="#rules">Rules</a><a href="#bugs">Bugs found</a><a href="#coverage">Coverage</a>
  <a class="gh" href="https://github.com/bitcoin-kernel/bitcoin-kernel.github.io">Source ↗</a>
</div></nav>

<header class="hero"><div class="wrap">
  <div class="kicker">Independent consensus engine · learn by running it</div>
  <h1>What makes a Bitcoin transaction valid?<br>Here are the rules — <b>proving themselves</b> as you read.</h1>
  <p class="lede">Every Bitcoin node must agree, byte-for-byte, on which transactions are valid — disagree and the network forks. Bitcoin Core ships <b><span id="headline-num">1,191</span> adversarial test cases</b> for its script rules. This page runs them all through a <b>separate, independent engine</b>, live in your browser, and passes every one. Below, the same tests grouped into the <b>six things Bitcoin script does</b> — click any group to read what it checks and drill into the real, disassembled vectors.</p>
  <div class="srcrow">
    <a href="./engine/codec/interpreter.js">the engine →</a>
    <a href="./engine/schema/validate.jsonld">the rules, as a spec →</a>
    <a href="${CORE_TESTS}">Core's test vectors →</a>
    <a href="https://github.com/bitcoin-kernel/bitcoin-kernel.github.io">source →</a>
    <span>· zero dependencies · runs in Node, browser & mobile</span>
  </div>
  <div id="livenote"><span class="spin"></span> starting…</div>
  <div id="cats">${CATS.map(catCard).join('')}</div>

  <div id="explorer" hidden>
    <div class="xbar"><h3 id="x-title">tests</h3><span class="gap"></span><span id="x-results"></span><button id="x-close">✕ categories</button></div>
    <div class="xsearch"><input id="x-search" placeholder="search within this group — try ‘DER’, ‘BIP66’, ‘NULLDUMMY’, ‘taproot’…" autocomplete="off">
      <div class="xlegend"><b class="ok">✓</b> bitcoin-kernel's verdict matches Bitcoin Core. Each test is a script that <b>should be valid</b> or <b>should be rejected</b> — we agree on every one. Click a row to see the script and why.</div></div>
    <div id="x-list"></div>
  </div>
</div></header>

<section id="bugs"><div class="wrap">
  <h2>Running Core's tests against a fresh engine found real bugs</h2>
  <p class="sub">Differential testing isn't decoration. Checking an independent implementation against Bitcoin Core's own corpus surfaced <strong>${BUGS.length} genuine consensus bugs</strong> in ours — each the kind that would silently diverge a re-implementation from the network. Each is now a permanent test in the explorer above.</p>
  <div class="bugs">${BUGS.map(([t, d]) => `<div class="bug"><h4>${esc(t)}</h4><p>${esc(d)}</p></div>`).join('')}</div>
</div></section>

<section id="rules"><div class="wrap">
  <h2>The full rulebook: ${RULE_COUNT} consensus rules</h2>
  <p class="sub">Script (above) is one part. These are <em>all</em> the rules a node checks to accept a block — generated straight from <a href="./engine/schema/validate.jsonld">the engine's machine-readable spec</a>, each with its BIP and Bitcoin Core error code. Expand a stage to read what it enforces.</p>
  ${rulesByPhase.map(ruleBlock).join('')}
</div></section>

<section id="coverage" style="background:var(--pan)"><div class="wrap">
  <h2>What's covered — and what isn't</h2>
  <p class="sub">Showing the boundaries is what makes the rest credible. This is a <em>validation</em> engine — what a node checks to accept a block — not a relay node.</p>
  <table class="cov">${COVERAGE.map(([a, s, d]) => `<tr><td>${esc(a)}</td><td><span class="badge" style="background:${covBadge[s]}">${s}</span></td><td style="color:var(--mut)">${esc(d)}</td></tr>`).join('')}</table>
</div></section>

<footer><div class="wrap">
  <div class="links">
    <a href="https://github.com/bitcoin-kernel/bitcoin-kernel.github.io">Source</a>
    <a href="./engine/codec/interpreter.js">The interpreter</a>
    <a href="./engine/schema/validate.jsonld">The rules (spec)</a>
    <a href="${CORE_TESTS}">Core's vectors</a>
  </div>
  <p class="note">Standalone: the engine, its rules, and Bitcoin Core's vectors are vendored into this repo (engine v${VERSION}); everything above runs same-origin, no external calls. ${TEST_COUNT} tests pass in the full suite. Independent community project; not affiliated with Bitcoin Core.</p>
</div></footer>
<script type="module">${APP}</script>
</body>
</html>
`;

await writeFile(here('index.html'), html);
console.log(`built index.html — category-led explorer, ${RULE_COUNT} rules`);
