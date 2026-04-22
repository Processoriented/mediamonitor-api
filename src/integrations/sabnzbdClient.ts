import { jsonRequest } from "./http.js";

function sabUrl(baseUrl: string, mode: string, extraParams: Record<string, string>) {
  const u = new URL(baseUrl);
  // SAB expects /api?mode=...&apikey=...&output=json
  const basePath = u.pathname.replace(/\/+$/, "");
  u.pathname = `${basePath}/api`.replace(/\/{2,}/g, "/");
  u.searchParams.set("mode", mode);
  u.searchParams.set("output", "json");
  for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
  return u.toString();
}

export async function sabnzbdQueue(args: { baseUrl: string; apiKey: string }) {
  const url = sabUrl(args.baseUrl, "queue", { apikey: args.apiKey, start: "0", limit: "0" });
  return jsonRequest<any>(url, {});
}

export async function sabnzbdHistory(args: { baseUrl: string; apiKey: string }) {
  const url = sabUrl(args.baseUrl, "history", { apikey: args.apiKey, start: "0", limit: "10" });
  return jsonRequest<any>(url, {});
}
