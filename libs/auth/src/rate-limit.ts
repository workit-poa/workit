const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;

type RateEntry = {
  count: number;
  resetAt: number;
};

const memoryStore = new Map<string, RateEntry>();

export function getClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip") || "unknown";
}

export function assertWithinRateLimit(key: string): void {
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || now >= entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    throw new Error("Too many requests. Please try again shortly.");
  }

  entry.count += 1;
  memoryStore.set(key, entry);
}

