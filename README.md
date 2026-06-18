# bitcoin-kernel

An independent, auditable Bitcoin consensus engine that **proves itself in your browser**.

**https://bitcoin-kernel.github.io/** loads its own vendored copy of the engine and Bitcoin
Core's own `script_tests.json`, and runs the differential live, same-origin — the numbers are
computed on the page, not claimed. It found and fixed 5 real consensus bugs along the way.

Fully standalone: the engine (`engine/codec/`), the consensus rules (`engine/schema/`), and
Core's vectors (`engine/vectors/`) are vendored in. No runtime dependency on anything else.

```
npm install   # dev-only: pulls the engine to vendor from
npm run build # re-vendors engine + regenerates index.html
```

Engine source: [@bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema).
Independent community project; not affiliated with Bitcoin Core.
