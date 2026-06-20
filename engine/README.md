# bitcoin-kernel

An independent, zero-dependency implementation of Bitcoin's consensus rules.
Pure ESM, so the same code runs in Node and in the browser.

It validates headers, difficulty, blocks, transactions, scripts and merkle
inclusion proofs, and is checked against real test vectors including Bitcoin
Core's own `script_tests.json`. Live demo and specification:
**https://bitcoin-kernel.github.io/**

## Install

```sh
npm install bitcoin-kernel
```

## Use

```js
import { createKernel } from 'bitcoin-kernel';

const k = createKernel(); // codec, script, interpreter, headers, blocks, spv

const header = k.codec.decode('BlockHeader', headerHex);
k.codec.blockHash(header);   // the block hash
k.headers.work(header);      // its chain work
```

Or import the individual pieces:

```js
import { ScriptInterpreter, HeaderEngine, SpvEngine, verifyEcdsa } from 'bitcoin-kernel';
```

`createKernel()` returns the wired engines and the schemas:

| Field | What it does |
|---|---|
| `codec` | encode and decode headers, blocks and transactions; hashes and merkle roots |
| `script` | parse, classify and disassemble scripts |
| `interpreter` | execute a script and verify an input |
| `headers` | header rules, proof of work, difficulty retargeting |
| `blocks` | block structure, subsidy, transaction validity, block context |
| `spv` | verify merkle inclusion proofs |
| `schemas` | the machine-readable rule and type definitions |

## Notes

- About 2,400 lines of JavaScript, zero runtime dependencies.
- Real ECDSA and Schnorr verification (`verifyEcdsa`, `verifySchnorr`), not stubs.
- Developed in the open; the consensus rules are generated from a
  machine-readable ruleset, so the spec and the code cannot drift apart.
- Independent community project, not affiliated with Bitcoin Core.

Licensed under the GNU AGPL v3 (AGPL-3.0-or-later).
