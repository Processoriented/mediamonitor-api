import { jsonRequest } from "./http.js";

function tautulliUrl(baseUrl: string, cmd: string, extraParams: Record<string, string>) {
  const u = new URL(baseUrl);
  // Tautulli expects requests like: http://host:8181/api/v2?apikey=...&cmd=...
  // Users may configure either:
  // - http://host:8181
  // - http://host:8181/  (trailing slash)
  // - http://host:8181/tautulli/ (reverse proxy subpath)
  const base = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  const apiRoot = base.endsWith("/api/v2") ? base : `${base}/api/v2`;
  u.href = `${apiRoot}?${new URLSearchParams({ apikey: extraParams.apikey, cmd, ...Object.fromEntries(Object.entries(extraParams).filter(([k]) => k !== "apikey")) }).toString()}`;
  return u.toString();
}

export async function tautulliServerInfo(args: { baseUrl: string; apiKey: string }) {
  const url = tautulliUrl(args.baseUrl, "get_server_info", { apikey: args.apiKey });
  return jsonRequest<any>(url, {});
}
