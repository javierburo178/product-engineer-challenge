/**
 * Runs `fn`, retrying on rejection up to `attempts` times with a fixed delay
 * between tries. Rethrows the last error once every attempt is exhausted.
 *
 * Deliberately minimal — no exponential backoff, jitter, timeout or circuit
 * breaker. See REMEDIATION.md #9 for the follow-up on a real resilience policy.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs = 100,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
