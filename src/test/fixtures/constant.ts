// Expected: getFirst → O(1), R² > 0.99
export function getFirst(arr: number[]): number {
  return arr[0] ?? -1;
}

// Expected: identityAdd → O(1), R² > 0.99
export function identityAdd(a: number, b: number): number {
  return a + b;
}
