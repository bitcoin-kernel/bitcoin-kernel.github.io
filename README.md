# bitcoin-kernel

An independent, auditable Bitcoin consensus engine — every rule a spec, every claim a test.

The landing page at **https://bitcoin-kernel.github.io/** is **generated from the source of truth**:
the consensus rules come straight from [`@bitcoin-desktop/schema`](https://github.com/bitcoin-desktop/schema)'s
`validate.jsonld`, and the headline facts from its passing test suite.

```
npm install   # pulls the schema (gh-pages)
npm run build # regenerates index.html
```

Independent community project; not affiliated with Bitcoin Core.
