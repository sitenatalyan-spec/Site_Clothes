import { loadState, publicState } from "../lib/shop.mjs";

export default async () => {
  const state = await loadState();
  return Response.json(publicState(state), { headers: { "Cache-Control": "public, max-age=60" } });
};
