/** Never log arbitrary error messages, SQL, parameters, credentials or untrusted names. */
export function connectionErrorCategory(error: unknown): { category: string; sqlState?: string } {
  const allowedNames = new Set(['Error', 'TypeError', 'SequelizeDatabaseError', 'SequelizeForeignKeyConstraintError', 'SequelizeUniqueConstraintError', 'SequelizeConnectionError', 'SequelizeConnectionRefusedError', 'SequelizeValidationError']);
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const read = (value: Record<string, unknown>, key: string): unknown => {
    try { return value[key]; } catch { return undefined; }
  };
  const name = read(row, 'name');
  const category = typeof name === 'string' && allowedNames.has(name) ? name : 'UnknownConnectionRegistrationError';
  const nested = [row, read(row, 'parent'), read(row, 'original')].filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object');
  const sqlState = nested.map(v => read(v, 'code')).find((v): v is string => typeof v === 'string' && /^(?:[0-9]{2}|[0-9][A-Z]|P0|F0|HV|XX)[0-9A-Z]{3}$/.test(v));
  return { category, ...(sqlState ? { sqlState } : {}) };
}
