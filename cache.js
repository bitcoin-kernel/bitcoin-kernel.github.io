// Shared OPFS block cache — a small Store seam used by every page on this origin.
// Keeps the most recent CAP blocks on the device so revisits don't go back to an
// explorer. Backing is naive (one file per block, named by hash) but the
// interface mirrors the node's BlockStore so it can evolve toward the sharded
// mesh, where a node serves the blocks it holds. OPFS is origin-scoped, so the
// verify page and the cache page read the exact same store.
const CAP = 50; // most-recent blocks to retain (LRU); recent blocks are ~2-3 MB each

let dir = null, idx = { byHeight: {}, byHash: {} }, ready = null;

async function load() {
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('no OPFS');
  const root = await navigator.storage.getDirectory();
  dir = await root.getDirectoryHandle('blocks', { create: true });
  try { idx = JSON.parse(await (await (await root.getFileHandle('blocks-index.json')).getFile()).text()); } catch {}
  idx.byHeight = idx.byHeight || {}; idx.byHash = idx.byHash || {};
  if (navigator.storage.persist) navigator.storage.persist();
}

async function saveIndex() {
  const root = await navigator.storage.getDirectory();
  const w = await (await root.getFileHandle('blocks-index.json', { create: true })).createWritable();
  await w.write(JSON.stringify(idx)); await w.close();
}

export const cache = {
  CAP,
  init() { if (!ready) ready = load().then(() => true).catch(() => { dir = null; return false; }); return ready; },
  available: () => !!dir,
  hashForHeight: (h) => idx.byHeight[h] || null,

  async get(hash) {
    if (!dir || !hash || !idx.byHash[hash]) return null;
    try {
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(hash + '.bin')).getFile()).arrayBuffer());
      idx.byHash[hash].last = Date.now();
      return bytes;
    } catch { delete idx.byHash[hash]; return null; }
  },

  async put(hash, height, bytes) {
    if (!dir) return;
    try {
      const w = await (await dir.getFileHandle(hash + '.bin', { create: true })).createWritable();
      await w.write(bytes); await w.close();
      const prev = idx.byHash[hash] || {};
      idx.byHash[hash] = { height, size: bytes.length, last: Date.now(), verified: prev.verified || false };
      idx.byHeight[height] = hash;
      const all = Object.keys(idx.byHash);
      if (all.length > CAP) {
        all.sort((a, b) => idx.byHash[a].last - idx.byHash[b].last);
        for (const old of all.slice(0, all.length - CAP)) {
          try { await dir.removeEntry(old + '.bin'); } catch {}
          const oh = idx.byHash[old].height; delete idx.byHash[old];
          if (idx.byHeight[oh] === old) delete idx.byHeight[oh];
        }
      }
      await saveIndex();
    } catch {}
  },

  // mark a cached block as having passed full structural verification
  async markVerified(hash) {
    if (!dir || !idx.byHash[hash]) return;
    if (idx.byHash[hash].verified) return;
    idx.byHash[hash].verified = true;
    try { await saveIndex(); } catch {}
  },

  stats() {
    const e = Object.values(idx.byHash);
    return { n: e.length, bytes: e.reduce((s, x) => s + (x.size || 0), 0), verified: e.filter((x) => x.verified).length };
  },

  // full listing for the cache page, newest height first
  entries() {
    return Object.entries(idx.byHash)
      .map(([hash, v]) => ({ hash, height: v.height, size: v.size || 0, verified: !!v.verified, last: v.last || 0 }))
      .sort((a, b) => b.height - a.height);
  },

  async clear() {
    if (!dir) return;
    for (const hash of Object.keys(idx.byHash)) { try { await dir.removeEntry(hash + '.bin'); } catch {} }
    idx = { byHeight: {}, byHash: {} };
    try { await saveIndex(); } catch {}
  },

  async quota() {
    try { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; }
    catch { return { usage: 0, quota: 0 }; }
  },
};
