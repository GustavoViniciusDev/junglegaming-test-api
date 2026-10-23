export interface OutboxRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export function nextOutboxAttemptAt(
  now: Date,
  attempts: number,
  policy: OutboxRetryPolicy,
): Date {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    !Number.isSafeInteger(policy.baseDelayMs) ||
    policy.baseDelayMs < 1 ||
    !Number.isSafeInteger(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs
  ) {
    throw new Error("Outbox retry policy values must be valid");
  }

  let delay = policy.baseDelayMs;
  for (
    let exponent = 0;
    exponent < attempts && delay < policy.maxDelayMs;
    exponent += 1
  ) {
    delay = Math.min(delay * 2, policy.maxDelayMs);
  }
  return new Date(now.getTime() + delay);
}
