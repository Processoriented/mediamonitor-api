import { jsonRequest } from "./http.js";

export async function arrPing(args: { baseUrl: string; apiKey: string }): Promise<void> {
  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/v3/system/status`;
  await jsonRequest(url, { headers: { "x-api-key": args.apiKey } });
}

