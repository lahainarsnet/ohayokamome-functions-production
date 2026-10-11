"use strict";
// Test helper (not a test): in-memory Firestore with REAL transaction semantics.
// Writes made inside runTransaction are buffered and applied only if the callback succeeds and the commit works.
const clone = (v) => JSON.parse(JSON.stringify(v));
function makeDb(initial = {}, { failSetPath = null, failCommit = false } = {}) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, clone(v)]));
  const versions = new Map();
  const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && !v.__type && !v.__ms;
  const mergeInto = (target, data) => {
    const out = { ...(target || {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__type === "delete") delete out[k];
      else if (v && v.__type === "arrayUnion") out[k] = [...new Set([...(Array.isArray(out[k]) ? out[k] : []), ...v.values])];
      else if (isPlain(v) && isPlain(out[k])) out[k] = mergeInto(out[k], v);
      else out[k] = v;
    }
    return out;
  };
  const ref = (path) => ({
    path,
    collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }),
    get: async () => snap(path),
    delete: async () => { docs.delete(path); versions.set(path, (versions.get(path) || 0) + 1); },
  });
  const snap = (path) => {
    const data = docs.has(path) ? docs.get(path) : null;
    return { id: path.split("/").pop(), exists: data != null, data: () => data, get: (f) => (data ? data[f] : undefined) };
  };
  return {
    docs,
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    // Firestore semantics: reads are validated at commit; if any document read by the transaction changed
    // meanwhile, the callback is run again against the new data (optimistic concurrency).
    async runTransaction(cb) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const buffered = [];
        const reads = new Map();
        const tx = {
          get: async (r) => { reads.set(r.path, versions.get(r.path) || 0); return snap(r.path); },
          set(r, data, options) {
            if (failSetPath && r.path === failSetPath) throw new Error(`injected failure at ${r.path}`);
            buffered.push({ path: r.path, data, merge: Boolean(options && options.merge) });
          },
        };
        const result = await cb(tx);
        if (failCommit) throw new Error("injected commit failure");
        if ([...reads].some(([path, version]) => (versions.get(path) || 0) !== version)) continue; // conflict: retry
        for (const w of buffered) {
          docs.set(w.path, w.merge ? mergeInto(docs.get(w.path), w.data) : { ...w.data });
          versions.set(w.path, (versions.get(w.path) || 0) + 1);
        }
        return result;
      }
      throw new Error("transaction retry limit exceeded");
    },
  };
}
const adminFor = (db) => ({
  getDb: () => db,
  FieldValue: {
    serverTimestamp: () => ({ __type: "serverTimestamp" }),
    delete: () => ({ __type: "delete" }),
    arrayUnion: (...values) => ({ __type: "arrayUnion", values }),
  },
  Timestamp: {
    fromMillis: (ms) => ({ __ms: ms, toMillis: () => ms, toDate: () => new Date(ms) }),
    fromDate: (d) => ({ __ms: d.getTime(), toMillis: () => d.getTime(), toDate: () => d }),
  },
});


// The per-UID failure counter is bookkeeping about refusals, not contract state: excluded unless asked for.
const snapshotOf = (db, { withLimiter = false } = {}) => JSON.stringify([...db.docs.entries()]
  .filter(([path]) => withLimiter || !path.startsWith("ownership_transfer_failures/"))
  .sort(([a], [b]) => a.localeCompare(b)));

module.exports = { makeDb, adminFor, snapshotOf };
