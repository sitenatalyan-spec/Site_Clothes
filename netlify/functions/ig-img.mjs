import { store } from "../lib/shop.mjs";

export default async (req) => {
  const key = new URL(req.url).searchParams.get("k") || "";
  if (!/^[\w-]{1,80}$/.test(key)) return new Response("Bad key", { status: 400 });
  const res = await store("shop-img").getWithMetadata(key, { type: "arrayBuffer" });
  if (!res) return new Response("Not found", { status: 404 });
  const type = /^image\/[\w.+-]+$/.test(res.metadata?.type || "") ? res.metadata.type : "image/jpeg";
  return new Response(res.data, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" } });
};
