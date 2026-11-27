export function debugLog(...values: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log(...values);
  }
}
