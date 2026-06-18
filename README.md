# bitcoin-kernel

An independent, zero-dependency implementation of Bitcoin's consensus rules.
Pure ESM, so the same code runs in Node and in the browser.

It comes in three parts, all from one source of truth:

- **Library** — import it and validate headers, difficulty, blocks, transactions, scripts and inclusion proofs.
- **Test suite** — run live at **https://bitcoin-kernel.github.io/**, across all of Bitcoin's rules, from real test vectors (including Bitcoin Core's own script vectors). Every result is computed in your browser, not claimed.
- **Specification** — **https://bitcoin-kernel.github.io/spec.html**, generated from the same machine-readable ruleset, so the spec cannot drift from the code.

## Use it as a library

```js
import { createKernel } from 'bitcoin-kernel';

const k = createKernel(); // codec, script, interpreter, headers, blocks, spv

const header = k.codec.decode('BlockHeader', headerHex);
k.codec.blockHash(header);        // the block hash
k.headers.work(header);           // its chain work
```

Or import individual pieces:

```js
import { ScriptInterpreter, HeaderEngine, verifyEcdsa } from 'bitcoin-kernel';
```

The package lives in [`engine/`](engine/). From a clone you can import it directly
(`./engine/index.js`) today; an `npm install bitcoin-kernel` is a later step.

## What it checks

Six suites, in the order a node validates a block:

| Suite | Covers |
|---|---|
| Headers | prev-link, proof of work, timestamps, version, difficulty |
| Difficulty | the 2016-block retarget, against real retargets from the chain |
| Blocks | one coinbase first, merkle commitment, no duplicates, size and sigop limits |
| Transactions & money | the halving schedule, the 21M cap, well-formed transactions |
| Spending (scripts) | Bitcoin Core's script test vectors |
| Light clients (SPV) | merkle inclusion proofs |

## Build the site

`build.js` vendors the engine and the test vectors into `engine/`, emits the
importable library, and generates `index.html` and `spec.html`.

```sh
npm install   # pulls the upstream engine to vendor from
npm run build
```

## Notes

- About 2,400 lines of JavaScript, zero runtime dependencies.
- The scripts suite runs about 1,191 of Bitcoin Core's roughly 1,222 script
  vectors. The rest (CLTV/CSV timelocks and some witness-malleability
  structural checks) are skipped, visibly, in the code.
- The engine is developed upstream at
  [@bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema).
- Independent community project, not affiliated with Bitcoin Core.
