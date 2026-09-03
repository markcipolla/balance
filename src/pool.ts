import { ApiKeyAccount, SubscriptionAccount, type Account } from "./account";
import type { ClaudeAccountsConfig } from "./types";

export class AccountPool {
  private readonly subs: SubscriptionAccount[];
  private readonly keys: ApiKeyAccount[];
  private subCursor = 0;
  private keyCursor = 0;

  constructor(cfg: ClaudeAccountsConfig, configPath: string) {
    this.subs = cfg.subscriptions.map((c) => new SubscriptionAccount(c, configPath));
    this.keys = cfg.api_keys.map((c) => new ApiKeyAccount(c));
  }

  all(): Account[] { return [...this.subs, ...this.keys]; }
  size(): number { return this.subs.length + this.keys.length; }

  private tierOrder<T extends Account>(bucket: T[], cursor: number): T[] {
    if (bucket.length === 0) return [];
    const start = cursor % bucket.length;
    const out: T[] = [];
    for (let i = 0; i < bucket.length; i++) out.push(bucket[(start + i) % bucket.length]!);
    return out;
  }

  // Ordered list of accounts to try, split into four tiers:
  //   1. available subscriptions (round-robin, least-in-flight first)
  //   2. available api keys       (round-robin, least-in-flight first)
  //   3. limited subscriptions    (soonest cooldown first)
  //   4. limited api keys         (soonest cooldown first)
  // Callers that only want to try available accounts should filter by
  // `isAvailable()`; forward.ts does exactly that as a short-circuit.
  nextOrder(): Account[] {
    for (const a of this.all()) a.clearCooldownIfExpired();

    const subOrder = this.tierOrder(this.subs, this.subCursor);
    const keyOrder = this.tierOrder(this.keys, this.keyCursor);
    if (this.subs.length > 0) this.subCursor = (this.subCursor + 1) % this.subs.length;
    if (this.keys.length > 0) this.keyCursor = (this.keyCursor + 1) % this.keys.length;

    const now = Date.now();
    const split = <T extends Account>(bucket: T[]): [T[], T[]] => {
      const av: T[] = [], lim: T[] = [];
      for (const a of bucket) (a.isAvailable(now) ? av : lim).push(a);
      av.sort((a, b) => a.inFlightCount() - b.inFlightCount());
      lim.sort((a, b) => a.cooldownRemainingMs(now) - b.cooldownRemainingMs(now));
      return [av, lim];
    };
    const [subAv, subLim] = split(subOrder);
    const [keyAv, keyLim] = split(keyOrder);
    return [...subAv, ...keyAv, ...subLim, ...keyLim];
  }

  minCooldownMs(now: number = Date.now()): number {
    let min = Infinity;
    for (const a of this.all()) {
      const c = a.cooldownRemainingMs(now);
      if (c > 0 && c < min) min = c;
    }
    return Number.isFinite(min) ? min : 0;
  }
}
