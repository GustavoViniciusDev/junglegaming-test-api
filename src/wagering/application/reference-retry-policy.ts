export interface ReferenceRetryPolicyOptions {
  baseDelayMs: number;
  maxAttempts: number;
  batchSize: number;
}

export const defaultReferenceRetryPolicy: ReferenceRetryPolicyOptions = {
  baseDelayMs: 1_000,
  maxAttempts: 8,
  batchSize: 50,
};

export function nextReferenceAttemptAt(
  now: Date,
  completedAttempts: number,
  baseDelayMs: number,
): Date {
  if (
    !Number.isSafeInteger(completedAttempts) ||
    completedAttempts < 0 ||
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < 1 ||
    !Number.isFinite(now.getTime())
  ) {
    throw new RangeError("Reference retry scheduling values are invalid");
  }
  const delay = baseDelayMs * 2 ** completedAttempts;
  if (
    !Number.isSafeInteger(delay) ||
    !Number.isSafeInteger(now.getTime() + delay)
  ) {
    throw new RangeError("Reference retry delay exceeds the supported range");
  }
  return new Date(now.getTime() + delay);
}
