import catalog from "./catalog.js";
import { loadState, saveState, syncInstagram, addLog } from "../lib/shop.mjs";

export default async () => {
  const state = await loadState();
  try {
    const res = await syncInstagram(state, new Set(Object.keys(catalog)));
    console.log("ig-sync", res);
  } catch (err) {
    addLog(state, "Ошибка синхронизации: " + err.message);
    console.error("ig-sync", err.message);
  }
  await saveState(state);
};

export const config = { schedule: "*/15 * * * *" };
