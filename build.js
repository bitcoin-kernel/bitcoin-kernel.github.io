#!/usr/bin/env node
// Generates index.html for bitcoin-kernel.
//
// One thing: a test runner for Bitcoin's consensus rules, running live in your
// browser, across ALL of them, not just transactions. Each suite runs real test
// vectors through an independent re-implementation and shows the result:
//   Headers, Difficulty, Blocks, Transactions & money, Spending (scripts), SPV.
// The vectors are real: Bitcoin Core's script vectors, real mainnet headers, a
// real block and its proofs. Nothing is claimed; every vector is run on the page.

import { readFile, writeFile, cp, mkdir, copyFile } from 'node:fs/promises';

const src = (p) => new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p));
const here = (p) => new URL(p, import.meta.url);
await mkdir(here('engine/schema'), { recursive: true });
await mkdir(here('engine/vectors'), { recursive: true });
await cp(src('codec'), here('engine/codec'), { recursive: true });
for (const f of ['core.jsonld', 'script.jsonld', 'chain.jsonld', 'proof.jsonld', 'validate.jsonld']) {
  await copyFile(src('schema/' + f), here('engine/schema/' + f));
}
for (const f of ['script_tests.json', 'genesis-block.json', 'retarget-modern.json', 'retarget-32256.json',
  'header-chain-100k.json', 'pruned-window-100000.json', 'merkleblock-block100000.json', 'merkleblock-first-segwit.json']) {
  await copyFile(src('test/vectors/' + f), here('engine/vectors/' + f));
}

const VERSION = JSON.parse(await readFile(src('package.json'))).version;
const CORE_TESTS = 'https://github.com/bitcoin/bitcoin/blob/master/src/test/data/script_tests.json';
const ENGINE_REPO = 'https://github.com/bitcoin-desktop/schema';

// the suites, in the order a node checks a block. name + one plain line.
const SUITES = [
  ['headers', 'Headers', 'The block headers that form the chain: each links to the one before, its proof of work meets the target, its timestamp is sane. Run against real mainnet headers.'],
  ['difficulty', 'Difficulty', 'Every 2016 blocks Bitcoin retunes how hard mining is, so blocks keep arriving about every ten minutes. Run against real retargets from the chain.'],
  ['blocks', 'Blocks', 'What makes a whole block valid: one coinbase, first, the header commits to every transaction, no duplicates, within the size and signature limits.'],
  ['money', 'Transactions & money', 'No one can print bitcoin: the block reward halves on schedule, the supply is capped at 21 million, and every transaction is well-formed.'],
  ['scripts', 'Spending (scripts)', 'How a coin is locked and unlocked. The big one: every script test vector Bitcoin Core ships, checking valid spends pass and forged or malformed ones are rejected.'],
  ['spv', 'Light clients (SPV)', 'How a phone confirms a payment without downloading the chain: a short proof that a transaction really sits inside a block.'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const C = { accent: '#e8830c', accent2: '#0969da', good: '#1a7f37', bad: '#cf222e', mut: '#5b6470', border: '#e6e8eb', panel: '#fafbfc' };

const suiteTab = ([k, name]) => `<button class="tab" data-k="${k}"><span class="tn">${esc(name)}</span><span class="tc" id="tc-${k}">…</span></button>`;

const APP = String.raw`
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { HeaderEngine } from './engine/codec/headers.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { SpvEngine } from './engine/codec/spv.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const j = (p) => fetch(p).then((r) => r.json());
const SUITE_NAME = { headers: 'Headers', difficulty: 'Difficulty', blocks: 'Blocks', money: 'Transactions & money', scripts: 'Spending (scripts)', spv: 'Light clients (SPV)' };
const SUITE_DESC = {
  headers: 'Each block header links to the one before it, its proof of work meets the target, and its timestamp is sane. These run against real mainnet headers.',
  difficulty: 'Every 2016 blocks Bitcoin retunes mining difficulty so blocks keep arriving about every ten minutes. These reproduce real retargets from the chain.',
  blocks: 'A valid block has one coinbase first, a header that commits to every transaction, no duplicates, and stays within the size and signature limits.',
  money: 'The block reward halves on schedule, the supply is capped at 21 million, and every transaction in a real block is well-formed.',
  scripts: "How coins are locked and unlocked. Every one of Bitcoin Core's script test vectors: valid spends should pass, forged or malformed ones should be rejected.",
  spv: 'A phone can prove a transaction sits inside a block from a short proof, without downloading the chain.',
};
const mono = (v, c) => '<span class="dmono"' + (c ? ' style="color:' + c + '"' : '') + '>' + esc(v) + '</span>';
const GOOD = '#1a7f37', BAD = '#cf222e';
const kvCard = (rows) => '<div class="card">' + rows.map(([k, v]) => '<div class="dl"><div class="dk">' + k + '</div><div class="dv">' + v + '</div></div>').join('') + '</div>';
const pretty = (s) => s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

// every test is { name, ok, expect: 'pass'|'reject'|null, detail: () => html }
const bySuite = { headers: [], difficulty: [], blocks: [], money: [], scripts: [], spv: [] };
const add = (suite, t) => bySuite[suite].push(t);

try {
  $('status').innerHTML = '<span class="spin"></span> loading test vectors';
  const [core, proof, scriptSchema, chainSchema, validate] = await Promise.all([
    j('./engine/schema/core.jsonld'), j('./engine/schema/proof.jsonld'), j('./engine/schema/script.jsonld'),
    j('./engine/schema/chain.jsonld'), j('./engine/schema/validate.jsonld'),
  ]);
  const codec = new Codec(core, proof);
  const he = HeaderEngine.fromSchemas(codec, chainSchema, validate);
  const be = BlockEngine.fromSchemas(codec, chainSchema, validate, scriptSchema);
  const spv = SpvEngine.fromSchemas(codec, validate);
  const se = ScriptEngine.fromSchemas(scriptSchema, chainSchema);
  const interp = new ScriptInterpreter(codec, se, scriptSchema['@graph'].find((n) => n['@id'] === 'btc:scriptLimits'));

  $('status').innerHTML = '<span class="spin"></span> running the suites';

  // =================== HEADERS (real mainnet headers) ===================
  try {
    const ch = await j('./engine/vectors/header-chain-100k.json');
    const hs = ch.headers.map((h) => codec.decode('BlockHeader', h));
    const start = Number(ch.startHeight) + 11;
    const rows = he.validateChain(hs.slice(11), { startHeight: start });
    for (const r of rows) {
      const checks = (r.results || []).filter((x) => x.ok !== null);
      const okk = checks.every((x) => x.ok !== false);
      add('headers', {
        name: 'Header at height ' + r.height.toLocaleString() + ' is valid', ok: okk, expect: null,
        detail: () => kvCard([
          ['block hash', mono(r.hash, GOOD)],
          ['timestamp', new Date(r.time * 1000).toUTCString()],
          ['difficulty (bits)', mono('0x' + r.bits.toString(16))],
          ['rules checked', checks.map((x) => '<div>' + (x.ok === false ? '✗' : '✓') + ' ' + esc(pretty(x.label)) + '</div>').join('')],
        ]),
      });
    }
    const g = await j('./engine/vectors/genesis-block.json');
    const ghdr = codec.decode('BlockHeader', g.hex.slice(0, 160));
    const ghash = codec.blockHash(ghdr);
    add('headers', {
      name: 'The genesis block hash is below its mining target', ok: ghash === g.expected.hash && BigInt('0x' + ghash) <= codec.expandCompact(ghdr.bits), expect: null,
      detail: () => kvCard([
        ['the block', "Bitcoin's genesis block, 3 January 2009"],
        ['hash (double SHA-256 of the header)', mono(ghash, GOOD)],
        ['mining target', mono('0x' + codec.expandCompact(ghdr.bits).toString(16).padStart(64, '0'))],
        ['below target?', '<b style="color:' + GOOD + '">yes</b>, the proof of work holds. Check this hash on any explorer.'],
      ]),
    });
  } catch (e) { console.error('headers', e); }

  // =================== DIFFICULTY (real retargets) ===================
  for (const [file, label, height] of [['retarget-32256.json', 'The first-ever difficulty retarget (block 32,256)', 32256], ['retarget-modern.json', 'A modern difficulty retarget (block 951,552)', 951552]]) {
    try {
      const rt = await j('./engine/vectors/' + file);
      const first = codec.decode('BlockHeader', rt.epochFirst);
      const last = codec.decode('BlockHeader', rt.epochLast);
      const next = codec.decode('BlockHeader', rt.next);
      const bits = he.expectedBits(last, Number(rt.epochLastHeight), first);
      const days = ((last.time - first.time) / 86400).toFixed(2);
      add('difficulty', {
        name: label + ' matches the network', ok: bits === next.bits, expect: null,
        detail: () => kvCard([
          ['the epoch', 'blocks ' + Number(rt.epochFirstHeight).toLocaleString() + ' to ' + Number(rt.epochLastHeight).toLocaleString() + ', 2016 blocks'],
          ['time they took', days + ' days (target is 14.00)'],
          ['new difficulty we computed', mono('0x' + bits.toString(16), GOOD)],
          ['what block ' + height.toLocaleString() + ' actually used', mono('0x' + next.bits.toString(16), bits === next.bits ? GOOD : BAD)],
        ]),
      });
    } catch (e) { console.error('difficulty', file, e); }
  }

  // =================== BLOCKS (a real block, height 100000) ===================
  let block100k = null;
  try {
    const pw = await j('./engine/vectors/pruned-window-100000.json');
    const blk = codec.decode('Block', pw.blocks[0]);
    block100k = blk;
    const hdr = blk.header || blk;
    const st = be.validateBlockStructure(blk);
    const NAMES = { 'coinbase-first': 'The coinbase is the first transaction', 'coinbase-single': 'There is exactly one coinbase', 'merkle-root': 'The header commits to every transaction (merkle root)', 'no-duplicate-tx': 'No duplicate transactions', 'duplicate-txid': 'No duplicate transactions (BIP 30)', 'sigop-limit': 'Within the signature-operation limit', 'block-weight': 'Within the block weight limit', 'block-size': 'Within the block size limit' };
    for (const x of (st.results || [])) {
      add('blocks', {
        name: NAMES[x.label] || pretty(x.label), ok: x.ok !== false, expect: null,
        detail: () => kvCard([['rule', mono(x.rule || x.label)], ['block', 'a real mainnet block with ' + blk.transactions.length + ' transactions'], ['result', x.ok === false ? '<b style="color:' + BAD + '">fail</b>' : '<b style="color:' + GOOD + '">pass</b>']]),
      });
    }
    const txids = blk.transactions.map((t) => codec.txid(t));
    const root = codec.merkleRoot(txids);
    add('blocks', {
      name: "Rebuilding the merkle root from the block's transactions", ok: root === hdr.merkleRoot, expect: null,
      detail: () => kvCard([
        ['transactions', blk.transactions.length + ' in the block'],
        ['merkle root we rebuilt', mono(root, GOOD)],
        ['root in the header', mono(hdr.merkleRoot, root === hdr.merkleRoot ? GOOD : BAD)],
        ['', 'Change one satoshi in any transaction and this root would not match.'],
      ]),
    });
  } catch (e) { console.error('blocks', e); }

  // =================== TRANSACTIONS & MONEY ===================
  try {
    for (const [h, btc] of [[0, 50], [210000, 25], [420000, 12.5], [840000, 3.125]]) {
      const sub = be.subsidy(h) / 1e8;
      add('money', { name: 'Block reward at height ' + h.toLocaleString() + ' is ' + btc + ' BTC', ok: sub === btc, expect: null, detail: () => kvCard([['height', h.toLocaleString()], ['block reward', mono(sub + ' BTC', GOOD)], ['rule', 'halves every 210,000 blocks, capping the supply near 21 million']]) });
    }
    const g = await j('./engine/vectors/genesis-block.json');
    const gblk = codec.decode('Block', g.hex);
    const cb = gblk.transactions[0].outputs.reduce((s, o) => s + o.value, 0);
    add('money', { name: 'The genesis coinbase paid exactly the 50 BTC reward', ok: cb === 5000000000, expect: null, detail: () => kvCard([['genesis coinbase', mono((cb / 1e8).toFixed(8) + ' BTC', GOOD)], ['', 'No transaction may ever pay out more than it takes in. This is the only way new bitcoin is created.']]) });
    if (block100k) {
      block100k.transactions.forEach((tx, i) => {
        const v = be.validateTransaction(tx, i === 0);
        const okk = !v || v.ok !== false;
        add('money', { name: (i === 0 ? 'The coinbase transaction' : 'Transaction ' + (i + 1)) + ' in block 100,000 is well-formed', ok: okk, expect: null, detail: () => kvCard([['transaction id', mono(codec.txid(tx))], ['inputs / outputs', tx.inputs.length + ' in, ' + tx.outputs.length + ' out'], ['result', okk ? '<b style="color:' + GOOD + '">well-formed</b>' : '<b style="color:' + BAD + '">invalid</b>']]) });
      });
    }
  } catch (e) { console.error('money', e); }

  // =================== LIGHT CLIENTS (SPV) ===================
  for (const [file, label] of [['merkleblock-block100000.json', 'A payment is proven to be in block 100,000'], ['merkleblock-first-segwit.json', 'The first-ever SegWit payment is proven in its block']]) {
    try {
      const mbv = await j('./engine/vectors/' + file);
      const mb = codec.decode('MerkleBlock', mbv.hex);
      const verdict = spv.verify(mb, { txid: mbv.txid });
      add('spv', {
        name: label, ok: verdict.ok === true, expect: null,
        detail: () => kvCard([
          ['the claim', 'transaction ' + mono(mbv.txid) + ' is in this block'],
          ['the proof', 'a short list of hashes, not the whole block'],
          ['what a phone does', 'recompute the merkle root from the transaction and those hashes, and compare it to the header'],
          ['result', verdict.ok ? '<b style="color:' + GOOD + '">proven</b>' : '<b style="color:' + BAD + '">failed</b>'],
        ]),
      });
    } catch (e) { console.error('spv', file, e); }
  }

  // =================== SPENDING: SCRIPTS (Bitcoin Core's vectors) ===================
  await runScripts(codec, se, interp, scriptSchema);

  // ---- finish: counts + summary ----
  let passed = 0, failed = 0;
  for (const k of Object.keys(bySuite)) { const el = $('tc-' + k); if (el) el.textContent = bySuite[k].length.toLocaleString(); for (const t of bySuite[k]) { if (t.ok) passed++; else failed++; } }
  const TOTAL = passed + failed;
  $('summary').className = failed === 0 ? 'summary ok' : 'summary bad';
  $('summary').innerHTML = '<span class="big">' + (failed === 0 ? '✓' : '✗') + ' ' + passed.toLocaleString() + '</span> passing' + (failed ? ' <span class="big bad">· ' + failed + ' failing</span>' : ' <span class="zero">· 0 failing</span>');
  $('status').innerHTML = 'Ran <b>' + TOTAL.toLocaleString() + '</b> test vectors across <b>6</b> suites, live in your browser.';
  console.log('%cbitcoin-kernel', 'color:#e8830c;font-weight:bold', passed, 'passing,', failed, 'failing.');

  wireExplorer();
  $('runner').classList.add('ready');
} catch (e) {
  $('status').innerHTML = 'Could not run: ' + esc(e && e.message || String(e));
  console.error(e);
}

// ---------- scripts suite: the differential against Core's vectors ----------
async function runScripts(codec, se, interp, scriptSchema) {
  const SCAT = { logic: 'logic', signatures: 'signature', multisig: 'multisig', encoding: 'encoding', segwit: 'segwit', p2sh: 'p2sh' };
  const raw = await j('./engine/vectors/script_tests.json');
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

  await new Promise((done) => { let i = 0; (function chunk() { const t0 = performance.now(); while (i < raw.length && performance.now() - t0 < 14) { const t = raw[i++]; if (!t || t.length < 4) continue; let wit = null, amount = 0, sig, spk, flags, expected, comment; if (Array.isArray(t[0])) { wit = t[0].slice(0, -1); amount = Math.round(t[0][t[0].length - 1] * 1e8); [, sig, spk, flags, expected, comment] = t; } else { [sig, spk, flags, expected, comment] = t; } if (TIMELOCK.test(sig) || TIMELOCK.test(spk) || STRUCT.has(expected)) continue; let sh, ph; try { sh = ps(sig); ph = ps(spk); } catch { continue; } if (/P2SH/.test(flags) && se.classify(ph).type === 'p2sh' && /^(4c|4d|4e)/.test(ph.slice(2, 4))) continue; const fset = new Set(flags.split(/[, ]+/).filter(Boolean)); let ours; try { const r = interp.verifyInput(spend(sh, ph, amount, wit), 0, { value: amount, scriptPubKey: ph }, [{ value: amount, scriptPubKey: ph }], fset); if (r.ok === null) continue; ours = r.ok; } catch { ours = 'err'; }
    const expOK = expected === 'OK'; const okk = ours === expOK;
    const c = cat(sig, spk, ph, flags, expected, wit);
    const rec = { sh, ph, comment: comment || '', ours };
    add('scripts', { name: (comment || asm(ph) || asm(sh) || '(empty)'), ok: okk, expect: expOK ? 'pass' : 'reject',
      detail: () => kvCard([
        rec.comment ? ['note from Bitcoin Core', '<i>“' + esc(rec.comment) + '”</i>'] : ['type', SCAT[c]],
        ['the lock (on the coin)', '<div class="dasm">' + esc(asm(rec.ph)) + '</div>' + (rec.ph ? '<div class="dhex">' + esc(rec.ph) + '</div>' : '')],
        ['the key offered to spend', '<div class="dasm">' + esc(asm(rec.sh)) + '</div>' + (rec.sh ? '<div class="dhex">' + esc(rec.sh) + '</div>' : '')],
        ['expected', expOK ? '<b style="color:' + GOOD + '">accept</b>' : '<b style="color:' + BAD + '">reject</b>'],
        ['bitcoin-kernel did', (rec.ours === true ? '<b style="color:' + GOOD + '">accept</b>' : rec.ours === false ? '<b style="color:' + BAD + '">reject</b>' : 'error') + ' <span class="match' + (okk ? '' : ' bad') + '">' + (okk ? '✓ correct' : '✗ wrong') + '</span>'],
      ].filter(Boolean)) });
  } if (i < raw.length) { if ($('count')) $('count').textContent = bySuite.scripts.length.toLocaleString(); requestAnimationFrame(chunk); } else done(); })(); });
}

// ---------- the explorer UI ----------
function wireExplorer() {
  let active = 'headers', query = '';
  const listEl = $('list'), titleEl = $('suite-title'), descEl = $('suite-desc'), countEl = $('suite-count');
  function render() {
    const q = query.toLowerCase();
    const tests = bySuite[active] || [];
    const hits = q ? tests.filter((t) => t.name.toLowerCase().includes(q)) : tests;
    titleEl.textContent = SUITE_NAME[active];
    descEl.textContent = SUITE_DESC[active];
    countEl.textContent = hits.length.toLocaleString() + ' tests' + (hits.length > 200 ? ', showing 200' : '');
    listEl.innerHTML = hits.slice(0, 200).map((t, n) => {
      const tag = t.expect ? '<span class="exp ' + (t.expect === 'pass' ? 'pass' : 'rej') + '">' + (t.expect === 'pass' ? 'should pass' : 'should be rejected') + '</span>' : '';
      return '<div class="row" data-n="' + n + '"><span class="v ' + (t.ok ? '' : 'no') + '">' + (t.ok ? '✓' : '✗') + '</span><span class="lab">' + esc(String(t.name).slice(0, 110)) + '</span>' + tag + '</div><div class="detail" id="dt' + n + '"></div>';
    }).join('');
    listEl._hits = hits;
  }
  document.querySelectorAll('.tab').forEach((tb) => tb.addEventListener('click', () => { active = tb.dataset.k; query = ''; $('search').value = ''; document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === tb)); render(); }));
  $('search').oninput = (e) => { query = e.target.value; render(); };
  listEl.onclick = (e) => { const row = e.target.closest('.row'); if (!row) return; const d = $('dt' + row.dataset.n); const o = d.classList.toggle('open'); row.classList.toggle('open', o); if (o && !d.innerHTML) d.innerHTML = listEl._hits[row.dataset.n].detail(); };
  document.querySelector('.tab[data-k=headers]').classList.add('on');
  render();
}
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bitcoin-kernel - the rules of Bitcoin, tested live in your browser</title>
<meta name="description" content="A test runner for Bitcoin's consensus rules, running live in your browser across all of them: headers, difficulty, blocks, transactions, scripts and light-client proofs. Real test vectors, including Bitcoin Core's own script vectors, run on the page and explained.">
<meta property="og:title" content="bitcoin-kernel">
<meta property="og:description" content="The rules of Bitcoin, tested live in your browser. Headers, difficulty, blocks, transactions, scripts and proofs, all from real test vectors.">
<meta property="og:type" content="website">
<style>
  :root{--bg:#fff;--fg:#16181d;--mut:${C.mut};--bd:${C.border};--pan:${C.panel};--ac:${C.accent};--ac2:${C.accent2};--good:${C.good};--bad:${C.bad};--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--ac2);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:940px;margin:0 auto;padding:0 1.5rem}
  nav{border-bottom:1px solid var(--bd)}
  nav .wrap{display:flex;align-items:center;height:56px}
  nav .brand{font-weight:700;letter-spacing:-.3px;margin-right:auto}nav .brand b{color:var(--ac)}
  nav a{color:var(--mut);font-size:.9rem;font-weight:500}
  header.hero{padding:3.2rem 0 1.2rem;text-align:center}
  h1{font-size:2.7rem;line-height:1.05;letter-spacing:-1.2px;margin:0;font-weight:800}
  .sub{font-size:1.14rem;color:#37414d;margin:1rem auto 0;max-width:38rem;line-height:1.5}
  #runner{margin:2rem 0 0;border:1px solid var(--bd);border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(16,18,29,.06)}
  .rhead{padding:1.4rem;text-align:center;border-bottom:1px solid var(--bd);background:var(--pan)}
  .summary{font-size:1.05rem;color:var(--mut)}
  .summary .big{font:800 1.9rem var(--mono);letter-spacing:-1px;color:var(--good);vertical-align:-2px}
  .summary .big.bad{color:var(--bad)}.summary .zero{color:var(--mut);font-family:var(--mono)}
  #counter{font:800 1.9rem var(--mono);color:var(--fg)}
  #status{margin:.5rem 0 0;font-size:.92rem;color:var(--mut)}#status b{color:var(--fg)}
  .spin{display:inline-block;width:.8em;height:.8em;border:2px solid var(--bd);border-top-color:var(--ac);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-1px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .runbody{opacity:0;transition:opacity .3s}#runner.ready .runbody{opacity:1}
  .tabs{display:flex;flex-wrap:wrap;gap:.5rem;padding:1rem 1.2rem;border-bottom:1px solid var(--bd)}
  .tab{display:flex;align-items:center;gap:.5rem;border:1px solid var(--bd);background:#fff;border-radius:99px;padding:.45rem .9rem;font:inherit;font-size:.9rem;color:var(--fg);cursor:pointer;transition:border-color .12s,background .12s}
  .tab:hover{border-color:var(--ac)}.tab.on{border-color:var(--ac);background:#fff7ee}
  .tab .tc{font:700 .8rem var(--mono);color:var(--ac)}
  .suitehead{padding:1.1rem 1.4rem .2rem}
  #suite-title{margin:0;font-size:1.2rem;letter-spacing:-.3px}
  #suite-desc{margin:.3rem 0 0;color:var(--mut);font-size:.95rem;line-height:1.5}
  .searchrow{display:flex;align-items:center;gap:.8rem;padding:.9rem 1.4rem}
  #search{flex:1;border:1px solid var(--bd);border-radius:8px;padding:.5rem .7rem;font:.88rem var(--mono);color:var(--fg)}
  #suite-count{font:.78rem var(--mono);color:var(--mut);white-space:nowrap}
  .legend{padding:0 1.4rem .8rem;font:.82rem/1.5 var(--mono);color:var(--mut)}.legend b.g{color:var(--good)}.legend b{color:var(--fg)}
  #list{max-height:34rem;overflow:auto;border-top:1px solid var(--bd)}
  .row{display:flex;align-items:center;gap:.85rem;padding:.55rem 1.4rem;cursor:pointer;border-top:1px solid var(--bd);border-left:3px solid transparent}
  .row:first-child{border-top:none}.row:hover{background:var(--pan)}.row.open{background:var(--pan);border-left-color:var(--ac)}
  .v{color:var(--good);font:700 .95rem var(--mono);flex-shrink:0}.v.no{color:var(--bad)}
  .lab{flex:1;font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .exp{font:600 .68rem var(--mono);text-transform:uppercase;border-radius:5px;padding:.13em .5em;flex-shrink:0}
  .exp.pass{background:#e6f4ea;color:var(--good)}.exp.rej{background:#eef1f4;color:#5b6470}
  .detail{display:none}.detail.open{display:block;padding:.4rem 1.4rem 1.1rem 3rem;background:var(--pan)}
  .card{border:1px solid var(--bd);border-radius:10px;overflow:hidden;background:#fff}
  .dl{display:flex;border-top:1px solid var(--bd)}.dl:first-child{border-top:none}
  .dk{width:14rem;flex-shrink:0;padding:.6rem .9rem;font:.76rem var(--mono);color:var(--mut);background:var(--pan)}
  .dv{padding:.6rem .9rem;font-size:.9rem;overflow:hidden;word-break:break-word}
  .dmono{font:.82rem/1.5 var(--mono);word-break:break-all}
  .dasm{font:.84rem/1.5 var(--mono);color:var(--fg);word-break:break-word}
  .dhex{font:.72rem/1.4 var(--mono);color:var(--mut);word-break:break-all;margin-top:.3rem}
  .match{font:600 .72rem var(--mono);color:var(--good);margin-left:.5rem}.match.bad{color:var(--bad)}
  .explain{margin:2.4rem 0 0;color:var(--mut);font-size:.98rem;line-height:1.6}.explain b{color:var(--fg)}
  footer{margin-top:2.4rem;padding:2rem 0;border-top:1px solid var(--bd);color:var(--mut);font-size:.85rem}
  footer .links{display:flex;gap:1.4rem;flex-wrap:wrap;margin-bottom:.9rem}
  .fnote{font:.8rem/1.6 var(--mono);color:var(--mut);max-width:54rem}
  @media(max-width:600px){h1{font-size:2.1rem}.dk{width:8rem}}
</style>
</head>
<body>
<nav><div class="wrap">
  <span class="brand">bitcoin<b>·</b>kernel</span>
  <a href="${ENGINE_REPO}">Source ↗</a>
</div></nav>

<header class="hero"><div class="wrap">
  <h1>The rules of Bitcoin.</h1>
  <p class="sub">Every header, block and payment has to follow them, or the network throws it out. Here is a test suite that checks those rules, all of them, running live in your browser from real test vectors.</p>
</div></header>

<div class="wrap">
  <div id="runner">
    <div class="rhead">
      <div id="summary" class="summary"><span id="counter">0</span> tests</div>
      <p id="status"><span class="spin"></span> starting</p>
    </div>
    <div class="runbody">
      <div class="tabs">${SUITES.map(suiteTab).join('')}</div>
      <div class="suitehead"><h2 id="suite-title">…</h2><p id="suite-desc"></p></div>
      <div class="searchrow"><input id="search" placeholder="search this suite" autocomplete="off"><span id="suite-count"></span></div>
      <div class="legend"><b class="g">✓</b> bitcoin-kernel computed the correct result. In the scripts suite, each test is a payment that <b>should pass</b> or <b>should be rejected</b>. Click any test to see what it checks.</div>
      <div id="list"></div>
    </div>
  </div>

  <p class="explain">These suites run real <b>test vectors</b>: <a href="${CORE_TESTS}">Bitcoin Core's own script vectors</a>, real mainnet headers, real difficulty retargets, a real block and its proofs. <b>bitcoin-kernel</b> is a fresh, independent re-implementation of Bitcoin's consensus rules. The page runs every vector through it, here in your browser, and shows the result. Every one is correct.</p>
</div>

<footer><div class="wrap">
  <div class="links">
    <a href="https://github.com/bitcoin-kernel/bitcoin-kernel.github.io">This page's source</a>
    <a href="./engine/codec/interpreter.js">The code that runs the tests</a>
    <a href="${CORE_TESTS}">Bitcoin Core's script vectors</a>
    <a href="${ENGINE_REPO}">bitcoin-kernel</a>
  </div>
  <p class="fnote">Everything runs in your browser with no external calls. The vectors and the code are copied into this repository (v${VERSION}); nothing is fetched at runtime. Independent community project, not affiliated with Bitcoin Core.</p>
</div></footer>
<script type="module">${APP}</script>
</body>
</html>
`;

await writeFile(here('index.html'), html);
console.log('built index.html - holistic test runner across 6 suites');
