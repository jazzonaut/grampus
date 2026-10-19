// Owns structural equality for JSON-shaped records (plans, specs, policies) that the controller
// compares against what it journaled. Not for digests or fences, which compare serialised bytes.

/**
 * Structural equality with the semantics of the stored journal: property order is ignored and an
 * `undefined` property counts as absent, because `Store.save` serialises records to JSON. This is
 * why it is used instead of `isDeepStrictEqual`, which would tell a freshly normalised plan with an
 * explicit `undefined` apart from its stored copy. Array order matters. Only plain objects, arrays and
 * primitives are expected; digests and fences that intentionally compare a serialised value keep
 * using `JSON.stringify`.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const rightItems: unknown[] = right;
    return left.every((item, index) => deepEqual(item, rightItems[index]));
  }
  const leftEntries = definedEntries(left);
  const rightValues = new Map(definedEntries(right));
  return (
    leftEntries.length === rightValues.size &&
    leftEntries.every(([key, value]) => rightValues.has(key) && deepEqual(value, rightValues.get(key)))
  );
}

/** Own enumerable properties whose value is not `undefined`, as JSON would keep them. */
function definedEntries(record: object): [string, unknown][] {
  return Object.entries(record).filter(([, value]) => value !== undefined);
}
