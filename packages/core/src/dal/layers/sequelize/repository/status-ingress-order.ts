/** Status values never break ties: only the original persisted CALL order may do so. */
export function statusIngressWins(
  candidate: { observedAt: number; messageId: number },
  current: { observedAt: number; messageId: number | null },
): boolean {
  if (!Number.isFinite(candidate.observedAt) || !Number.isFinite(current.observedAt) ||
      !Number.isSafeInteger(candidate.messageId) || candidate.messageId <= 0) {
    throw new Error('STATUS_INGRESS_INVALID_ORDER');
  }
  return candidate.observedAt > current.observedAt ||
    (candidate.observedAt === current.observedAt &&
      (current.messageId === null || candidate.messageId > current.messageId));
}
