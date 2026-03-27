// Expected: mergeSort → O(n log n), R² > 0.94
// Uses iterative bottom-up merge sort to produce a clean n·log₂(n) counter signal
export function mergeSort(arr: number[]): number[] {
  const n = arr.length;
  const result = [...arr];
  for (let width = 1; width < n; width *= 2) {
    for (let i = 0; i < n; i += 2 * width) {
      const lo = i;
      const mid = Math.min(i + width, n);
      const hi = Math.min(i + 2 * width, n);
      merge(result, lo, mid, hi);
    }
  }
  return result;
}

function merge(arr: number[], lo: number, mid: number, hi: number): void {
  const left = arr.slice(lo, mid);
  const right = arr.slice(mid, hi);
  let i = 0, j = 0, k = lo;
  while (i < left.length && j < right.length) {
    if (left[i] <= right[j]) arr[k++] = left[i++];
    else arr[k++] = right[j++];
  }
  while (i < left.length) arr[k++] = left[i++];
  while (j < right.length) arr[k++] = right[j++];
}
