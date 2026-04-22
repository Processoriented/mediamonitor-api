import { jsonRequest } from "./http.js";

export type ArrQueueRecord = Record<string, any>;
export type ArrHistoryRecord = Record<string, any>;

function arrUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function arrSystemStatus(args: { baseUrl: string; apiKey: string }) {
  return jsonRequest<any>(arrUrl(args.baseUrl, "/api/v3/system/status"), {
    headers: { "x-api-key": args.apiKey }
  });
}

export async function arrQueue(args: { baseUrl: string; apiKey: string }) {
  return jsonRequest<ArrQueueRecord>(arrUrl(args.baseUrl, "/api/v3/queue?page=1&pageSize=200&includeUnknownMovieItems=true"), {
    headers: { "x-api-key": args.apiKey }
  });
}

export async function arrHistory(args: { baseUrl: string; apiKey: string }) {
  return jsonRequest<ArrHistoryRecord>(arrUrl(args.baseUrl, "/api/v3/history?page=1&pageSize=10&sortKey=date&sortDirection=descending"), {
    headers: { "x-api-key": args.apiKey }
  });
}
