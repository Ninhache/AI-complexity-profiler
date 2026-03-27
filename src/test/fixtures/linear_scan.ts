// Expected: linearScan → O(n), R² > 0.97
export function linearScan(arr: number[], target: number): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === target) return i;
  }
  return -1;
}
