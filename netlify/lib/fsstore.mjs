import fs from "node:fs/promises";
import path from "node:path";

// Same methods as a Netlify Blobs store, kept in files under STORE_DIR (used on our own server).
export function fsStore(name) {
  const dir = path.join(process.env.STORE_DIR, name.replace(/[^\w-]/g, "_"));
  const file = (key) => path.join(dir, encodeURIComponent(key));
  const meta = (key) => file(key) + ".meta.json";
  const write = async (target, data) => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = target + ".tmp" + process.pid;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  };
  const read = async (key, type) => {
    let buf;
    try { buf = await fs.readFile(file(key)); } catch { return null; }
    if (type === "json") return JSON.parse(buf.toString("utf8"));
    if (type === "arrayBuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return buf.toString("utf8");
  };
  return {
    get: (key, o = {}) => read(key, o.type),
    async getWithMetadata(key, o = {}) {
      const data = await read(key, o.type);
      if (data === null) return null;
      let metadata = {};
      try { metadata = JSON.parse(await fs.readFile(meta(key), "utf8")); } catch {}
      return { data, etag: "", metadata };
    },
    async set(key, value, o = {}) {
      const data = typeof value === "string" ? value : Buffer.from(value instanceof ArrayBuffer ? value : await value.arrayBuffer?.() ?? value);
      await write(file(key), data);
      if (o.metadata) await write(meta(key), JSON.stringify(o.metadata));
    },
    setJSON(key, value, o = {}) { return this.set(key, JSON.stringify(value), o); },
    async list() {
      let names = [];
      try { names = await fs.readdir(dir); } catch {}
      return { blobs: names.filter((n) => !n.endsWith(".meta.json") && !n.includes(".tmp")).map((n) => ({ key: decodeURIComponent(n), etag: "" })), directories: [] };
    },
    async delete(key) { await fs.rm(file(key), { force: true }); await fs.rm(meta(key), { force: true }); },
  };
}
