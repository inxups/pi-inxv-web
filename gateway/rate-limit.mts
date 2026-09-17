export const AUTH_RATE_LIMIT_BASE_DELAY_MS = 1_000;
export const AUTH_RATE_LIMIT_MAX_DELAY_MS = 15 * 60_000;
export const AUTH_RATE_LIMIT_RESET_AFTER_MS = 30 * 60_000;

interface Entry {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
  requestCount: number;
  requestWindowStartedAt: number;
}

function freshEntry(): Entry {
  return {
    failures: 0,
    lastFailureAt: 0,
    blockedUntil: 0,
    requestCount: 0,
    requestWindowStartedAt: 0,
  };
}

function delayForFailures(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(
    AUTH_RATE_LIMIT_BASE_DELAY_MS * 2 ** Math.min(failures - 1, 20),
    AUTH_RATE_LIMIT_MAX_DELAY_MS,
  );
}

export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maximumEntries: number;

  constructor(maximumEntries = 10_000) {
    this.maximumEntries = maximumEntries;
  }

  private prune(now: number): void {
    if (this.entries.size <= this.maximumEntries) return;
    for (const [key, entry] of this.entries) {
      if (
        Math.max(entry.lastFailureAt, entry.requestWindowStartedAt)
          + AUTH_RATE_LIMIT_RESET_AFTER_MS <= now
        && entry.blockedUntil <= now
      ) {
        this.entries.delete(key);
      }
      if (this.entries.size <= this.maximumEntries) break;
    }
    if (this.entries.size > this.maximumEntries) {
      for (const [key, entry] of this.entries) {
        if (entry.blockedUntil > now) continue;
        this.entries.delete(key);
        if (this.entries.size <= this.maximumEntries) break;
      }
    }
  }

  private getEntry(key: string, now: number): Entry {
    const existing = this.entries.get(key);
    if (!existing) {
      const created = freshEntry();
      this.entries.set(key, created);
      this.prune(now);
      return created;
    }
    if (
      Math.max(existing.lastFailureAt, existing.requestWindowStartedAt)
        + AUTH_RATE_LIMIT_RESET_AFTER_MS <= now
      && existing.blockedUntil <= now
    ) {
      Object.assign(existing, freshEntry());
    }
    return existing;
  }

  retryAfterMs(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (
      entry.failures > 0
      && now - entry.lastFailureAt >= AUTH_RATE_LIMIT_RESET_AFTER_MS
      && entry.blockedUntil <= now
    ) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, entry.blockedUntil - now);
  }

  consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): number {
    const entry = this.getEntry(key, now);
    if (now - entry.requestWindowStartedAt >= windowMs) {
      entry.requestCount = 0;
      entry.requestWindowStartedAt = now;
    }
    entry.requestCount += 1;
    if (entry.requestCount <= limit) return 0;
    return Math.max(1, entry.requestWindowStartedAt + windowMs - now);
  }

  recordFailure(key: string, now = Date.now()): number {
    const entry = this.getEntry(key, now);
    entry.failures += 1;
    entry.lastFailureAt = now;
    entry.blockedUntil = now + delayForFailures(entry.failures);
    return entry.blockedUntil - now;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}

export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
