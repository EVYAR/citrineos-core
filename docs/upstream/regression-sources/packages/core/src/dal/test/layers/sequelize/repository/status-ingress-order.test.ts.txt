import { describe, expect, it } from 'vitest';
import { statusIngressWins } from '../../../../layers/sequelize/repository/status-ingress-order.js';

describe('immutable status ingress ordering', () => {
  const at = Date.parse('2026-10-20T19:59:59.116Z');
  it('retains the newer original CALL regardless of consumer completion order', () => {
    const finishing = { observedAt: at, messageId: 100 };
    const available = { observedAt: at, messageId: 101 };
    expect(statusIngressWins(available, finishing)).toBe(true);
    expect(statusIngressWins(finishing, available)).toBe(false);
    expect(statusIngressWins(available, available)).toBe(false);
    // The relation has no status argument: reversing values cannot change it.
    expect(statusIngressWins({ observedAt: at, messageId: 102 }, available)).toBe(true);
  });
  it('does not let later arrival overwrite a genuinely newer charger observation', () => {
    expect(statusIngressWins({ observedAt: at - 1, messageId: 999 }, { observedAt: at, messageId: 1 })).toBe(false);
    expect(statusIngressWins({ observedAt: at + 1, messageId: 2 }, { observedAt: at, messageId: 1 })).toBe(true);
    expect(statusIngressWins({ observedAt: at, messageId: 2 }, { observedAt: at, messageId: null })).toBe(true);
  });
  it('rejects malformed order instead of inventing zero time', () => {
    expect(() => statusIngressWins({ observedAt: NaN, messageId: 1 }, { observedAt: at, messageId: null })).toThrow('STATUS_INGRESS_INVALID_ORDER');
    expect(() => statusIngressWins({ observedAt: at, messageId: 0 }, { observedAt: at, messageId: 1 })).toThrow('STATUS_INGRESS_INVALID_ORDER');
  });
});
