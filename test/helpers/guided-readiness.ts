// Explicit mechanical commands for readiness scenario tests.
/** A read-only check that rejects a marker in the fixture implementation. */
export function readiness(kind: 'format' | 'types', marker: string) {
  return {
    kind,
    name: `${kind} readiness`,
    file: 'node',
    args: ['-e', `if(require('node:fs').readFileSync('greeting.js','utf8').includes('${marker}'))process.exit(1)`],
    timeoutMs: 15000,
  };
}
