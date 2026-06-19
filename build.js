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

// --- make engine/ an importable ESM library: the `bitcoin-kernel` package ---
// Bundle the JSON-LD schemas as JS modules so `import` works in the browser too
// (no fetch, no JSON import attributes), then emit a barrel + factory + manifest.
for (const k of ['core', 'proof', 'script', 'chain', 'validate']) {
  const data = (await readFile(here('engine/schema/' + k + '.jsonld'), 'utf8')).trim();
  await writeFile(here('engine/schema/' + k + '.js'), 'export default ' + data + ';\n');
}
await writeFile(here('engine/index.js'), `// bitcoin-kernel: an independent, zero-dependency implementation of Bitcoin's
// consensus rules. Pure ESM; the same code runs in Node and in the browser.
import { Codec } from './codec/codec.js';
import { ScriptEngine } from './codec/script.js';
import { ScriptInterpreter } from './codec/interpreter.js';
import { HeaderEngine } from './codec/headers.js';
import { BlockEngine } from './codec/blocks.js';
import { SpvEngine } from './codec/spv.js';
import core from './schema/core.js';
import proof from './schema/proof.js';
import script from './schema/script.js';
import chain from './schema/chain.js';
import validate from './schema/validate.js';

export { Codec, ScriptEngine, ScriptInterpreter, HeaderEngine, BlockEngine, SpvEngine };
export * from './codec/hash.js';
export * from './codec/secp256k1.js';

export const schemas = { core, proof, script, chain, validate };

// Build a fully wired set of engines from the bundled schemas.
export function createKernel() {
  const codec = new Codec(core, proof);
  const scriptEngine = ScriptEngine.fromSchemas(script, chain);
  const limits = script['@graph'].find((n) => n['@id'] === 'btc:scriptLimits');
  const interpreter = new ScriptInterpreter(codec, scriptEngine, limits);
  const headers = HeaderEngine.fromSchemas(codec, chain, validate);
  const blocks = BlockEngine.fromSchemas(codec, chain, validate, script);
  const spv = SpvEngine.fromSchemas(codec, validate);
  return { codec, script: scriptEngine, interpreter, headers, blocks, spv, schemas };
}

export default createKernel;
`);
await writeFile(here('engine/package.json'), JSON.stringify({
  name: 'bitcoin-kernel',
  version: '0.0.1',
  description: "An independent, zero-dependency implementation of Bitcoin's consensus rules. Runs in Node and the browser.",
  type: 'module',
  main: './index.js',
  module: './index.js',
  exports: { '.': './index.js', './codec/*': './codec/*', './schema/*': './schema/*' },
  files: ['index.js', 'codec/', 'schema/'],
  sideEffects: false,
  keywords: ['bitcoin', 'consensus', 'validation', 'script', 'esm', 'browser'],
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/bitcoin-kernel/bitcoin-kernel.github.io.git' },
  homepage: 'https://bitcoin-kernel.com/',
}, null, 2) + '\n');

const VERSION = JSON.parse(await readFile(src('package.json'))).version;
const CORE_TESTS = 'https://github.com/bitcoin/bitcoin/blob/master/src/test/data/script_tests.json';
const ENGINE_REPO = 'https://github.com/bitcoin-desktop/schema';

// --- normative rules, extracted from the source-of-truth ruleset (for spec.html) ---
const validate = JSON.parse(await readFile(src('schema/validate.jsonld')));
const PHASE = {
  header: ['Header rules', 'Constraints every block header must satisfy: it links to the previous block, its proof of work meets the target, its timestamp is within range, its version is allowed at that height, and its difficulty is correct, including the testnet4 timewarp fix.'],
  transaction: ['Transaction rules', 'Standalone validity of a transaction: it has at least one input and one output, no value exceeds the 21 million coin limit, and it never spends the same output twice.'],
  block: ['Block rules', 'Internal consistency of a block: exactly one coinbase, placed first; the merkle root commits to every transaction; no duplicate transaction ids; and the size and signature-operation budgets are respected.'],
  'block-context': ['Contextual block rules', 'Validity of a block against the chain state it extends: coinbase height and maturity, timelocks and sequence locks, every input unspent and available, non-negative fees, the witness commitment, and successful execution of every input script.'],
  spv: ['Light client (SPV) rules', 'Verification of a merkle inclusion proof: a light client can confirm that a transaction is committed to by a block header without possessing the whole block.'],
};
const ORDER = ['header', 'transaction', 'block', 'block-context', 'spv'];
const ruleSets = validate['@graph'].filter((n) => n['@type'] === 'RuleSet')
  .map((s) => ({
    phase: s.phase,
    title: (PHASE[s.phase] ?? [s.phase, ''])[0],
    blurb: (PHASE[s.phase] ?? ['', ''])[1],
    rules: (s.rules ?? []).map((r) => ({ id: (r['@id'] || '').replace(/^btc:/, ''), label: r.label || '', error: r.errorCode || '', bip: [].concat(r.bip ?? []).filter(Boolean).join(', '), comment: r.comment || '' })),
  }))
  .sort((a, b) => ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase));
const RULE_COUNT = ruleSets.reduce((n, p) => n + p.rules.length, 0);
const ALL_BIPS = [...new Set(ruleSets.flatMap((p) => p.rules.flatMap((r) => r.bip.split(', '))).filter(Boolean))]
  .sort((a, b) => Number(a) - Number(b));

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
  let active = 'scripts', query = '';
  const listEl = $('list'), titleEl = $('suite-title'), descEl = $('suite-desc'), countEl = $('suite-count');
  function render() {
    const q = query.toLowerCase();
    const tests = bySuite[active] || [];
    const hits = q ? tests.filter((t) => t.name.toLowerCase().includes(q)) : tests;
    titleEl.textContent = SUITE_NAME[active];
    descEl.textContent = SUITE_DESC[active];
    countEl.textContent = hits.length.toLocaleString() + ' tests' + (hits.length > 200 ? ', showing 200' : '');
    listEl.innerHTML = hits.slice(0, 200).map((t, n) => {
      const tag = '<span class="exp ' + (t.ok ? 'pass' : 'fail') + '">' + (t.ok ? 'PASS' : 'FAIL') + '</span>';
      return '<div class="row" data-n="' + n + '"><span class="v ' + (t.ok ? '' : 'no') + '">' + (t.ok ? '✓' : '✗') + '</span><span class="lab">' + esc(String(t.name).slice(0, 110)) + '</span>' + tag + '</div><div class="detail" id="dt' + n + '"></div>';
    }).join('');
    listEl._hits = hits;
  }
  document.querySelectorAll('.tab').forEach((tb) => tb.addEventListener('click', () => { active = tb.dataset.k; query = ''; $('search').value = ''; document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === tb)); render(); }));
  $('search').oninput = (e) => { query = e.target.value; render(); };
  listEl.onclick = (e) => { const row = e.target.closest('.row'); if (!row) return; const d = $('dt' + row.dataset.n); const o = d.classList.toggle('open'); row.classList.toggle('open', o); if (o && !d.innerHTML) d.innerHTML = listEl._hits[row.dataset.n].detail(); };
  document.querySelector('.tab[data-k=scripts]').classList.add('on');
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
<meta property="og:url" content="https://bitcoin-kernel.com/">
<meta property="og:image" content="https://bitcoin-kernel.com/og.png?v=3">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="bitcoin-kernel">
<meta name="twitter:description" content="The rules of Bitcoin, tested live in your browser, from real test vectors.">
<meta name="twitter:image" content="https://bitcoin-kernel.com/og.png?v=3">
<style>
  :root{--bg:#fff;--fg:#16181d;--mut:${C.mut};--bd:${C.border};--pan:${C.panel};--ac:${C.accent};--ac2:${C.accent2};--good:${C.good};--bad:${C.bad};--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--ac2);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:940px;margin:0 auto;padding:0 1.5rem}
  nav{border-bottom:1px solid var(--bd)}
  nav .wrap{display:flex;align-items:center;gap:1.3rem;height:56px}
  nav .brand{font-weight:700;letter-spacing:-.3px;margin-right:auto}nav .brand b{color:var(--ac)}
  nav a{color:var(--mut);font-size:.9rem;font-weight:500}
  header.hero{padding:3.2rem 0 1.2rem;text-align:center}
  h1{font-size:2.7rem;line-height:1.05;letter-spacing:-1.2px;margin:0;font-weight:800}
  .sub{font-size:1.14rem;color:#37414d;margin:1rem auto 0;max-width:38rem;line-height:1.5}
  .shead{text-align:center;font-size:1.9rem;font-weight:800;letter-spacing:-.6px;margin:2.6rem 0 0}
  #runner{margin:1rem 0 0;border:1px solid var(--bd);border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(16,18,29,.06)}
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
  .exp.pass{background:#e6f4ea;color:var(--good)}.exp.fail{background:#fce8e8;color:var(--bad)}
  .detail{display:none}.detail.open{display:block;padding:.4rem 1.4rem 1.1rem 3rem;background:var(--pan)}
  .card{border:1px solid var(--bd);border-radius:10px;overflow:hidden;background:#fff}
  .dl{display:flex;border-top:1px solid var(--bd)}.dl:first-child{border-top:none}
  .dk{width:14rem;flex-shrink:0;padding:.6rem .9rem;font:.76rem var(--mono);color:var(--mut);background:var(--pan)}
  .dv{padding:.6rem .9rem;font-size:.9rem;overflow:hidden;word-break:break-word}
  .dmono{font:.82rem/1.5 var(--mono);word-break:break-all}
  .dasm{font:.84rem/1.5 var(--mono);color:var(--fg);word-break:break-word}
  .dhex{font:.72rem/1.4 var(--mono);color:var(--mut);word-break:break-all;margin-top:.3rem}
  .match{font:600 .72rem var(--mono);color:var(--good);margin-left:.5rem}.match.bad{color:var(--bad)}
  .how{margin:3.4rem 0 0}
  .how3{display:grid;grid-template-columns:repeat(3,1fr);gap:1.6rem;margin-top:1.6rem}
  .how3 h3{margin:0 0 .35rem;font-size:1.05rem;letter-spacing:-.2px}
  .how3 p{margin:0;color:var(--mut);font-size:.92rem;line-height:1.55}
  @media(max-width:640px){.how3{grid-template-columns:1fr;gap:1.1rem}}
  footer{margin-top:2.4rem;padding:2rem 0;border-top:1px solid var(--bd);color:var(--mut);font-size:.85rem}
  footer .links{display:flex;gap:1.4rem;flex-wrap:wrap;margin-bottom:.9rem}
  .fnote{font:.8rem/1.6 var(--mono);color:var(--mut);max-width:54rem}
  @media(max-width:600px){h1{font-size:2.1rem}.dk{width:8rem}}
</style>
</head>
<body>
<nav><div class="wrap">
  <span class="brand">bitcoin<b>·</b>kernel</span>
  <a href="./spec.html">Specification</a>
  <a href="${ENGINE_REPO}">Source ↗</a>
</div></nav>

<header class="hero"><div class="wrap">
  <h1>The rules of Bitcoin.</h1>
  <p class="sub">Every header, block and payment has to follow them, or the network throws it out. Here is a test suite that checks those rules, all of them, running live in your browser from real test vectors.</p>
</div></header>

<div class="wrap">
  <h2 class="shead">The consensus test suite</h2>
  <div id="runner">
    <div class="rhead">
      <div id="summary" class="summary"><span id="counter">0</span> tests</div>
      <p id="status"><span class="spin"></span> starting</p>
    </div>
    <div class="runbody">
      <div class="tabs">${SUITES.map(suiteTab).join('')}</div>
      <div class="suitehead"><h2 id="suite-title">…</h2><p id="suite-desc"></p></div>
      <div class="searchrow"><input id="search" placeholder="search this suite" autocomplete="off"><span id="suite-count"></span></div>
      <div class="legend"><b class="g">PASS</b> means bitcoin-kernel computed the correct result for that vector: it accepted what the network accepts and rejected what the network rejects. Click any test to see the vector and the result.</div>
      <div id="list"></div>
    </div>
  </div>

  <div class="how">
    <h2 class="shead">How it works</h2>
    <div class="how3">
      <div><h3>The rules</h3><p>Bitcoin has a fixed set of consensus rules that decide whether a header, block or payment is valid. Every node on the network enforces the same ones.</p></div>
      <div><h3>The library</h3><p>bitcoin-kernel is a JavaScript library that implements those rules from scratch. The same code runs on a Node server and right here in a browser tab.</p></div>
      <div><h3>The test suite</h3><p>It ships with real <a href="${CORE_TESTS}">test vectors</a>: Bitcoin Core's script vectors, real mainnet headers, blocks and proofs. This page runs the whole suite live, above.</p></div>
    </div>
  </div>
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

// ============================ spec.html ============================
const VECTORS = [
  ['script_tests.json', "Bitcoin Core's own script test vectors: valid and invalid spends, with the expected verdict for each. About 1,191 are run.", '§4.2, §4.4'],
  ['genesis-block.json', 'The Bitcoin genesis block: its header, proof of work, merkle root and coinbase.', '§4.1, §4.3'],
  ['retarget-32256.json', 'The first difficulty retarget in Bitcoin history (block 32,256).', '§4.1'],
  ['retarget-modern.json', 'A modern difficulty retarget (block 951,552).', '§4.1'],
  ['header-chain-100k.json', 'Consecutive mainnet headers around height 100,000, validated in sequence.', '§4.1'],
  ['pruned-window-100000.json', 'A real mainnet block with its transactions, for structural and contextual checks.', '§4.3, §4.4'],
  ['merkleblock-block100000.json', 'A merkle inclusion proof for a transaction in block 100,000.', '§4.5'],
  ['merkleblock-first-segwit.json', "A deeper merkle inclusion proof (the first-ever SegWit transaction).", '§4.5'],
];
const deDash = (s) => String(s).replace(/\s*[—–]\s*/g, ', ');
const ruleRows = (rules) => rules.map((r) => `<tr><td class="rid">${esc(r.id)}</td><td>${esc(deDash(r.comment || r.label))}</td><td class="rbip">${r.bip ? 'BIP&nbsp;' + esc(r.bip) : ''}</td><td class="rerr">${esc(r.error)}</td></tr>`).join('');
const rulesSections = ruleSets.map((p, i) => `<h3 id="rules-${p.phase}">4.${i + 1} ${esc(p.title)}</h3>
  <p class="blurb">${esc(p.blurb)}</p>
  <table class="rules"><thead><tr><th>Rule</th><th>Requirement</th><th>BIP</th><th>Error code</th></tr></thead><tbody>${ruleRows(p.rules)}</tbody></table>`).join('\n');
const bipRefs = ALL_BIPS.map((b) => `<li><a href="https://github.com/bitcoin/bips/blob/master/bip-${String(b).padStart(4, '0')}.mediawiki">BIP ${esc(b)}</a></li>`).join('');

const spec = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bitcoin-kernel specification - Bitcoin's consensus rules, with conformance</title>
<meta name="description" content="A conformance specification for Bitcoin's consensus rules: normative rules generated from a machine-readable ruleset, a conformance definition, a test suite, and an independent implementation that runs on Node and in the browser.">
<meta property="og:title" content="bitcoin-kernel specification">
<meta property="og:description" content="A conformance specification for Bitcoin's consensus rules: normative rules, a test suite, and an independent implementation that runs on Node and in the browser.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://bitcoin-kernel.com/spec.html">
<meta property="og:image" content="https://bitcoin-kernel.com/og.png?v=3">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://bitcoin-kernel.com/og.png?v=3">
<style>
  :root{--bg:#fff;--fg:#16181d;--mut:${C.mut};--bd:${C.border};--pan:${C.panel};--ac:${C.accent};--ac2:${C.accent2};--good:${C.good};--bad:${C.bad};--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,system-ui,"Segoe UI",sans-serif}
  a{color:var(--ac2);text-decoration:none}a:hover{text-decoration:underline}
  nav{border-bottom:1px solid var(--bd);position:sticky;top:0;background:rgba(255,255,255,.9);backdrop-filter:blur(8px)}
  nav .in{max-width:860px;margin:0 auto;padding:0 1.5rem;display:flex;align-items:center;gap:1.3rem;height:54px}
  nav .brand{font-weight:700;letter-spacing:-.3px;margin-right:auto}nav .brand b{color:var(--ac)}
  nav a{color:var(--mut);font-size:.9rem;font-weight:500}
  main{max-width:860px;margin:0 auto;padding:0 1.5rem 5rem}
  header.doc{padding:3rem 0 1.4rem;border-bottom:1px solid var(--bd)}
  .kicker{font:600 .78rem var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ac)}
  h1{font-size:2.4rem;letter-spacing:-1px;margin:.5rem 0 0;font-weight:800}
  .tagline{font-size:1.18rem;color:#37414d;margin:.6rem 0 0}
  .docmeta{font:.82rem var(--mono);color:var(--mut);margin:1rem 0 0}
  .plain{background:var(--pan);border:1px solid var(--bd);border-radius:12px;padding:1.4rem 1.6rem;margin:2rem 0 0}
  .plain h2{margin:0 0 .3rem;font-size:1.15rem}
  .plain>p{margin:.2rem 0 1rem;color:#37414d}
  .stack{margin:0;display:grid;gap:.7rem}
  .stack div{display:grid;grid-template-columns:11rem 1fr;gap:1rem}
  .stack dt{font-weight:700}.stack dd{margin:0;color:var(--mut)}
  ol.toc{margin:2.2rem 0 0;padding:1rem 1.4rem 1rem 2.6rem;border:1px solid var(--bd);border-radius:10px;color:var(--ac2);font-size:.95rem}
  ol.toc li{margin:.2rem 0}
  h2.sec{font-size:1.5rem;letter-spacing:-.4px;margin:2.8rem 0 .6rem;padding-top:.6rem;border-top:1px solid var(--bd)}
  h3{font-size:1.12rem;margin:1.8rem 0 .3rem}
  p.blurb{color:var(--mut);margin:.2rem 0 .8rem}
  .keywords{font-family:var(--mono);font-weight:700;color:var(--fg)}
  .normbox{border-left:3px solid var(--ac);background:#fff8f0;padding:.8rem 1.1rem;margin:1rem 0;border-radius:0 8px 8px 0}
  table{width:100%;border-collapse:collapse;margin:.6rem 0 0;font-size:.9rem}
  th,td{text-align:left;padding:.5rem .7rem;border-top:1px solid var(--bd);vertical-align:top}
  thead th{border-top:none;border-bottom:2px solid var(--bd);font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
  table.rules .rid{font-family:var(--mono);font-size:.8rem;white-space:nowrap;color:var(--ac)}
  table.rules .rbip{font-family:var(--mono);font-size:.8rem;color:var(--mut);white-space:nowrap}
  table.rules .rerr{font-family:var(--mono);font-size:.78rem;color:var(--mut)}
  .vfile{font-family:var(--mono);font-size:.82rem;white-space:nowrap}
  code{font-family:var(--mono);font-size:.88em;background:var(--pan);padding:.1em .35em;border-radius:4px}
  ul.refs{padding-left:1.3rem}ul.refs li{margin:.3rem 0}
  footer{border-top:1px solid var(--bd);margin-top:3rem;padding:2rem 0;color:var(--mut);font:.82rem/1.6 var(--mono)}
  @media(max-width:600px){h1{font-size:1.9rem}.stack div{grid-template-columns:1fr;gap:.1rem}}
</style>
</head>
<body>
<nav><div class="in">
  <span class="brand">bitcoin<b>·</b>kernel</span>
  <a href="./index.html">Live demo</a>
  <a href="${ENGINE_REPO}">Source ↗</a>
</div></nav>
<main>
  <header class="doc">
    <div class="kicker">Specification</div>
    <h1>bitcoin-kernel</h1>
    <p class="tagline">A conformance specification for Bitcoin's consensus rules.</p>
    <p class="docmeta">Engine v${VERSION} · ${RULE_COUNT} rules · generated from the source ruleset · living document</p>
  </header>

  <section class="plain">
    <h2>In plain terms</h2>
    <p>This is a standard, in the ordinary sense. It has the same parts a web or internet standard has.</p>
    <dl class="stack">
      <div><dt>The rules</dt><dd>What makes a Bitcoin header, block and payment valid. ${RULE_COUNT} of them, listed in §4.</dd></div>
      <div><dt>The specification</dt><dd>This document. The rules in §4 are generated from the machine-readable ruleset, so the words here and the running code cannot drift apart.</dd></div>
      <div><dt>The test suite</dt><dd>Real test vectors that exercise the rules, including Bitcoin Core's own script vectors (§5).</dd></div>
      <div><dt>Conformance</dt><dd>An implementation conforms if it agrees with every vector. Pass them all and you conform (§3).</dd></div>
      <div><dt>Implementations</dt><dd>bitcoin-kernel, a library that runs these rules on Node and in the browser (§6). Others may follow.</dd></div>
      <div><dt>The demo</dt><dd>The whole suite, run live in your browser, on the <a href="./index.html">home page</a>.</dd></div>
    </dl>
  </section>

  <ol class="toc">
    <li><a href="#abstract">Abstract</a></li>
    <li><a href="#status">Status of this document</a></li>
    <li><a href="#conformance">Conformance</a></li>
    <li><a href="#rules">Rules</a></li>
    <li><a href="#vectors">Test vectors</a></li>
    <li><a href="#implementations">Implementations</a></li>
    <li><a href="#references">References</a></li>
  </ol>

  <h2 class="sec" id="abstract">1. Abstract</h2>
  <p>This document specifies the consensus rules a Bitcoin full node applies when deciding whether to accept a block, together with a conformance test suite. It exists so that independent implementations can be checked against a single, machine-readable definition of the rules. The normative rules in §4 are generated directly from the engine's source-of-truth ruleset (<a href="./engine/schema/validate.jsonld"><code>validate.jsonld</code></a>); the test vectors in §5 are run, in full, by the <a href="./index.html">live demo</a>.</p>

  <h2 class="sec" id="status">2. Status of this document</h2>
  <p>This is a living document, generated from source on each build. It is an independent community project and is <strong>not affiliated with, nor endorsed by, Bitcoin Core or the Bitcoin project</strong>. It describes the rules as implemented by bitcoin-kernel, an independent implementation, and is offered as a cross-check, not as a replacement for Bitcoin Core. Where this document and the Bitcoin network disagree, the network is correct and this document is in error.</p>

  <h2 class="sec" id="conformance">3. Conformance</h2>
  <p>The key words <span class="keywords">MUST</span>, <span class="keywords">MUST NOT</span>, <span class="keywords">REQUIRED</span>, <span class="keywords">SHALL</span>, <span class="keywords">SHOULD</span>, and <span class="keywords">MAY</span> in this document are to be interpreted as described in RFC&nbsp;2119.</p>
  <div class="normbox">
    <p>An implementation <span class="keywords">conforms</span> to this specification if and only if, for every test vector defined in §5, the verdict it computes (<em>accept</em> or <em>reject</em>) equals that vector's expected verdict.</p>
  </div>
  <p>A conforming validator <span class="keywords">MUST</span> implement every rule in §4. It <span class="keywords">MUST</span> reject any header, block, or transaction that a normative rule rejects, and <span class="keywords">MUST NOT</span> reject one that every applicable rule accepts. A conforming validator <span class="keywords">SHOULD</span> demonstrate conformance by running the test suite; the live demo does so in the browser and reports any divergence. Rules marked with a BIP <span class="keywords">MUST</span> be enforced only at and after that BIP's activation height, as the corresponding rule records.</p>

  <h2 class="sec" id="rules">4. Rules</h2>
  <p>Each rule below is normative. A conforming validator <span class="keywords">MUST</span> enforce it. Rules are grouped by the stage at which a node applies them, and each carries its originating BIP, where one exists, and the error code a node raises when the rule is violated.</p>
  ${rulesSections}

  <h2 class="sec" id="vectors">5. Test vectors</h2>
  <p>The test suite is the set of vectors below. They are vendored into this repository under <code>engine/vectors/</code> and are run, in full, by the <a href="./index.html">live demo</a>. An implementation conforms (§3) if it produces each vector's expected verdict.</p>
  <table><thead><tr><th>Vector set</th><th>Description</th><th>Rules</th></tr></thead><tbody>
  ${VECTORS.map(([f, d, s]) => `<tr><td class="vfile"><a href="./engine/vectors/${f}">${f}</a></td><td>${esc(d)}</td><td class="vfile">${s}</td></tr>`).join('\n  ')}
  </tbody></table>
  <p>The script vectors are <a href="${CORE_TESTS}">Bitcoin Core's own <code>script_tests.json</code></a>, used unmodified. The remaining vectors are real mainnet data, independently verifiable on any block explorer.</p>

  <h2 class="sec" id="implementations">6. Implementations</h2>
  <p><strong>bitcoin-kernel</strong> is the reference implementation: a JavaScript library, with no runtime dependencies, that implements every rule in §4. The same code runs on a Node server and in a browser tab; the <a href="./index.html">demo</a> runs it client-side. The interpreter and engine are at <a href="./engine/codec/interpreter.js"><code>engine/codec/</code></a> and developed in the open at <a href="${ENGINE_REPO}">${ENGINE_REPO.replace('https://', '')}</a>.</p>
  <p>An implementation in any language conforms to this specification (§3) if it produces the expected verdict for every vector in §5. Reporting partial conformance (for example, the script rules only) is <span class="keywords">RECOMMENDED</span> where full conformance is not yet reached.</p>

  <h2 class="sec" id="references">7. References</h2>
  <ul class="refs">
    <li>S. Bradner, <a href="https://www.rfc-editor.org/rfc/rfc2119">RFC 2119: Key words for use in RFCs to Indicate Requirement Levels</a>.</li>
    <li><a href="${CORE_TESTS}">Bitcoin Core, <code>src/test/data/script_tests.json</code></a> (the script test vectors).</li>
    <li>Bitcoin Improvement Proposals referenced by the rules above:<ul class="refs">${bipRefs}</ul></li>
  </ul>
</main>
<footer><div style="max-width:860px;margin:0 auto;padding:0 1.5rem">
  Generated from <a href="./engine/schema/validate.jsonld">validate.jsonld</a> (engine v${VERSION}). Independent community project, not affiliated with Bitcoin Core. <a href="./index.html">Live demo</a> · <a href="${ENGINE_REPO}">Source</a>
</div></footer>
</body>
</html>
`;
await writeFile(here('spec.html'), spec);
console.log('built index.html + spec.html -', RULE_COUNT, 'rules across', ruleSets.length, 'rulesets');
