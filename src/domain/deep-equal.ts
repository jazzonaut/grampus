// Owns structural equality for JSON-shaped records (plans, specs, policies) that the controller
// compares against what it journaled.

/**
 * Structural equality with the semantics of the stored journal: property order is ignored and an
 * `undefined` property counts as absent, because `Store.save` serialises records to JSON. This is
 * why it is used instead of `isDeepStrictEqual`, which would tell a freshly normalised plan with an
 * explicit `undefined` apart from its stored copy. Only plain objects, arrays and primitives are
 * expected; digests that intentionally serialise a value keep using `JSON.stringify`.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>,
    rightRecord = right as Record<string, unknown>;
  const keys = definedKeys(leftRecord);
  return (
    keys.length === definedKeys(rightRecord).length &&
    keys.every(key => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]))
  );
}

function definedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter(key => record[key] !== undefined);
}
