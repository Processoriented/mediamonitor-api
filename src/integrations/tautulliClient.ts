import { jsonRequest } from "./http.js";

function tautulliUrl(baseUrl: string, cmd: string, extraParams: Record<string, string>) {
  const u = new URL(baseUrl);
  const basePath = u.pathname.replace(/\/+$/, "");
  u.pathname = `${basePath}/api/v2`.replace(/\/{2,}/g, "/");
  u.searchParams.set("apikey", extraParams.apikey);
  u.searchParams.set("cmd", cmd);
  for (const [k, v] of Object.entries(extraParams)) {
    if (k === "apikey") continue;
    u.searchParams.set(k, v);
  }
  return u.toString();
}

export async function tautulliServerInfo(args: { baseUrl: string; apiKey: string }) {
  const url = tautulliUrl(args.baseUrl, "server_info", { apikey: args.apiKey });
  return jsonRequest<any>(url, {});
}
