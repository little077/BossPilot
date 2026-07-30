/**
 * pi-ai only touches node:fs for a Bun-specific environment fallback.
 * Browser extensions never execute that branch, but an explicit shim keeps
 * the MV3 bundle free of unresolved Node built-ins and store-review warnings.
 */
export function readFileSync(): never {
  throw new Error('node:fs is unavailable in the browser extension runtime.');
}
