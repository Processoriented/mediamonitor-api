export class HttpError extends Error {
  status: number;
  bodyText?: string;

  constructor(message: string, args: { status: number; bodyText?: string }) {
    super(message);
    this.status = args.status;
    this.bodyText = args.bodyText;
  }
}

export async function jsonRequest<T>(
  url: string,
  args: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: args.method ?? (args.body ? "POST" : "GET"),
      headers: {
        accept: "application/json",
        ...(args.body ? { "content-type": "application/json" } : {}),
        ...(args.headers ?? {})
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
      signal: controller.signal
    });

    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} for ${url}`, { status: res.status, bodyText: text });
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  } finally {
    clearTimeout(timeout);
  }
}

