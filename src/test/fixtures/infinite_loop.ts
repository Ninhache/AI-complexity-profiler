// Expected: infiniteLoop → TIMEOUT (worker killed after 5s)
export function infiniteLoop(arr: number[]): number {
  let i = 0;
  while (true) {
    i++;
  }
  return i; // unreachable — suppresses TS error
}
