/**
 * Split `total` (minor units) across `weights` proportionally using the largest-remainder method, so the parts
 * ALWAYS sum exactly to total. Ties go to the earlier index. Weights must be non-negative; all-zero weights split evenly.
 */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (!weights.length) throw new Error('no weights');
  if (weights.some((w) => w < 0n)) throw new Error('negative weight');
  const sign = total < 0n ? -1n : 1n;
  const t = total * sign;
  let w = weights;
  let sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) { w = weights.map(() => 1n); sum = BigInt(w.length); }
  const parts = w.map((x) => (t * x) / sum);
  let left = t - parts.reduce((a, b) => a + b, 0n);
  const order = w
    .map((x, i) => ({ i, rem: (t * x) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; left > 0n; k = (k + 1) % order.length, left--) parts[order[k].i] += 1n;
  return parts.map((p) => p * sign);
}
