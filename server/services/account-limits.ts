import { createHmac } from 'node:crypto';
import type { Database } from '../storage/database.ts';
import { ACCOUNT_POLICY as policy } from './account-policy.ts';
import { createAccountCounters } from '../storage/account-counters.ts';

export interface AccountPause { retryAt: number }

/** Fixed windows retain counts, never a history of addresses or attempts. */
export function createAccountLimits(db: Database, key: Uint8Array) {
  if (key.byteLength < 32) throw new TypeError('An account key of at least 32 bytes is required');
  const counters = createAccountCounters(db);
  const { read, save } = counters;
  const counterKey = (kind: string, value: string) => createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex');
  return {
    reserveEmail(email: string, ip: string, now: number): AccountPause | null {
      return db.transaction(() => {
        const limits = [
          { id: counterKey('resend', email), max: 1, duration: policy.resendMs },
          { id: counterKey('ip-hour', ip), max: policy.sendsPerIp, duration: policy.sendWindowMs },
        ].map(rule => ({ ...rule, counter: read(rule.id, now) }));
        const blocked = limits.filter(rule => rule.counter && rule.counter.count >= rule.max);
        if (blocked.length) return { retryAt: Math.max(...blocked.map(rule => rule.counter!.expires_at)) };
        for (const rule of limits) {
          save(rule.counter ? { ...rule.counter, count: rule.counter.count + 1 }
            : { key: rule.id, count: 1, started_at: now, expires_at: now + rule.duration, blocked_until: 0 });
        }
        return null;
      });
    },
    verificationPause(email: string, now: number): AccountPause | null {
      const counter = read(counterKey('wrong-code', email), now);
      return counter && counter.blocked_until > now ? { retryAt: counter.blocked_until } : null;
    },
    recordWrongCode(email: string, now: number): AccountPause | null {
      return db.transaction(() => {
        const id = counterKey('wrong-code', email);
        const previous = read(id, now);
        if (previous && previous.blocked_until > now) return { retryAt: previous.blocked_until };
        const counter = previous && previous.blocked_until === 0
          ? { ...previous, count: previous.count + 1 }
          : { key: id, count: 1, started_at: now, expires_at: now + policy.wrongCodeWindowMs, blocked_until: 0 };
        if (counter.count >= policy.wrongCodes) {
          counter.blocked_until = now + policy.verificationPauseMs;
          counter.expires_at = counter.blocked_until;
        }
        save(counter);
        return counter.blocked_until > now ? { retryAt: counter.blocked_until } : null;
      });
    },
    cleanup: counters.cleanup,
  };
}
