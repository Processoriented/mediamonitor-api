import { jsonRequest } from "./http.js";

function seerrUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function seerrStatus(args: { baseUrl: string; apiKey: string }) {
  return jsonRequest<any>(seerrUrl(args.baseUrl, "/api/v1/status"), {
    method: "GET",
    headers: { "X-Api-Key": args.apiKey }
  });
}
