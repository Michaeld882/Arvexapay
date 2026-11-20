/** Exponential backoff with jitter, capped at 8s. attempt starts at 0. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(8_000, 500 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.75 + random() * 0.5))
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
