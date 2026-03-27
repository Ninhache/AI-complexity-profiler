// Expected: S1 returns diagnostics[], CompilerBridgeError NOT thrown (pipeline continues)
// S2 receives whatever partial JS was produced; S6 shows compiler diagnostic in Problems panel
export function badFunction(x: number): string {
  return x + 1; // type error: number is not assignable to string
  const unreachable = "this code has a type error above";
}
