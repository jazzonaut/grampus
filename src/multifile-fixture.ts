// A deliberately incomplete repository and an independent behavioral oracle.
// Only the two implementation files are writable by the live provider.
export const fixtureFiles: Record<string, string> = {
  'summary.cjs': 'exports.summarize = values => ({ count: values.length });\n',
  'cli.cjs': "console.log(JSON.stringify(process.argv[2]));\n",
  'AGENTS.md': 'Use CommonJS and Node built-ins only. Keep calculation in summary.cjs and argument parsing/output in cli.cjs. Avoid unnecessary abstractions. Only the two named implementation files may change.\n',
};

export const brief = {
  title: 'Multi-file summary command pilot',
  outcome: 'Implement summarize(values) in summary.cjs and a JSON command in cli.cjs. Export summarize using CommonJS. Use no dependencies.',
  criteria: [
    'summarize accepts an array of finite numbers and returns exactly { count, total, min, max }; empty arrays return { count: 0, total: 0, min: null, max: null }. Preserve the input array.',
    'summarize throws TypeError for non-arrays or any non-number or non-finite element. Negative numbers and decimals are supported.',
    'node cli.cjs takes exactly one JSON argument, calls summarize from summary.cjs, and prints its JSON result followed by one newline, with exit zero and empty stderr.',
    'Missing or extra arguments, malformed JSON, and invalid values produce exit code 2, empty stdout, and exactly invalid input followed by one newline on stderr.',
  ],
  plan: 'Edit only summary.cjs and cli.cjs through supervised native tools. Run independent behavioral checks covering the library and command. Pause for an explicit simplification assessment of the actual code, then obtain a fresh other-provider review, run acceptance checks and deliver a verified local commit.',
};

// Supplied as a command argument, outside the provider's writable scope. Success
// output identifies the assertions exercised; errors cannot masquerade as a pass.
export const oracle = String.raw`
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { summarize } = require('./summary.cjs');
const cases = [
  [[], { count: 0, total: 0, min: null, max: null }],
  [[7], { count: 1, total: 7, min: 7, max: 7 }],
  [[3, -2, 3, 0.5], { count: 4, total: 4.5, min: -2, max: 3 }],
  [[-8, -3], { count: 2, total: -11, min: -8, max: -3 }],
];
for (const [input, expected] of cases) {
  const original = [...input];
  assert.deepEqual(summarize(input), expected);
  assert.deepEqual(input, original, 'Library must preserve its input');
}
for (const input of [null, {}, '3', 3, [null], [true], ['2'], [{}], [[]], [NaN], [Infinity], [-Infinity]]) {
  assert.throws(() => summarize(input), TypeError);
}
console.log('library: empty, single, mixed, negative, immutable, invalid');
function run(args) {
  const result = spawnSync(process.execPath, ['cli.cjs', ...args], { encoding: 'utf8', timeout: 2000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
for (const [input, expected] of cases) {
  const result = run([JSON.stringify(input)]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, JSON.stringify(JSON.parse(result.stdout)) + '\n');
}
console.log('command: empty, single, mixed, negative');
for (const args of [[], ['[]', 'extra'], ['{'], ['null'], ['{}'], ['3'], ['"3"'], ['[null]'], ['[true]'], ['["2"]'], ['[1e999]']]) {
  const result = run(args);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'invalid input\n');
}
console.log('command: argument count, JSON syntax, invalid values');
`;

export const expectedStdout = 'library: empty, single, mixed, negative, immutable, invalid\n'
  + 'command: empty, single, mixed, negative\n'
  + 'command: argument count, JSON syntax, invalid values\n';

export const obsoleteFile = 'obsolete.cjs';
export const obsoleteContent = 'exports.legacySummary = values => values.length;\n';
export const deletionCriterion = 'Remove obsolete.cjs from the workspace; do not replace it with an empty file or directory.';
export const deletionOracle = oracle + `\nassert.equal(require('node:fs').existsSync('${obsoleteFile}'), false, 'Obsolete file must be removed');\nconsole.log('workspace: obsolete file removed');\n`;
export const deletionStdout = expectedStdout + 'workspace: obsolete file removed\n';
