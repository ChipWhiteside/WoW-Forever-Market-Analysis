/**
 * Poisson helpers for the overnight queue. Sale events are rare, independent arrivals, so a count of them over a
 * window is Poisson. Computed in log space so a mean of thousands never underflows.
 */

/** P(X >= j) for j = 0..maxJ, X ~ Poisson(mu). tail[0] is 1. */
export function poissonTail(mu: number, maxJ: number): number[] {
  const tail = new Array<number>(maxJ + 1).fill(0);
  if (!(mu > 0)) { tail[0] = 1; return tail; }
  // cdf(j - 1) summed from the pmf; tail(j) = 1 - cdf(j - 1)
  let logp = -mu, cdf = 0;
  tail[0] = 1;
  for (let j = 1; j <= maxJ; j++) {
    cdf += Math.exp(logp);
    tail[j] = Math.max(0, 1 - cdf);
    logp += Math.log(mu) - Math.log(j);
  }
  return tail;
}

/** P(X <= k), X ~ Poisson(mu). */
export function poissonCdf(k: number, mu: number): number {
  if (k < 0) return 0;
  if (!(mu > 0)) return 1;
  let logp = -mu, cdf = 0;
  for (let j = 0; j <= k; j++) { cdf += Math.exp(logp); logp += Math.log(mu) - Math.log(j + 1); }
  return Math.min(1, cdf);
}

/**
 * One sided lower confidence bound on a Poisson mean after seeing n events: the mean whose chance of showing n or more
 * is 1 - confidence. For n = 0 it is 0. Exact (bisection on the cdf), the same as half the chi square quantile.
 */
export function poissonLowerBound(n: number, confidence = 0.95): number {
  if (!(n > 0)) return 0;
  const k = Math.ceil(n) - 1; // P(X >= n) = 1 - cdf(n - 1)
  let lo = 0, hi = Math.max(1, n);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    // cdf(k; mid) falls as mid grows; we want 1 - cdf = 1 - confidence
    if (1 - poissonCdf(k, mid) < 1 - confidence) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Smallest j with P(X >= j) under `p`: past it, arrivals are negligible. */
export function poissonUpper(mu: number, p: number): number {
  if (!(mu > 0)) return 0;
  let logp = -mu, cdf = 0, j = 0;
  while (j < 1e6) { cdf += Math.exp(logp); j++; if (1 - cdf < p) return j; logp += Math.log(mu) - Math.log(j); }
  return j;
}
