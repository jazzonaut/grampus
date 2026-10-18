// Shared fixtures for the multi-file probe tests.

export const library = `exports.summarize = function(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError('invalid');
  return { count: values.length, total: values.reduce((sum, value) => sum + value, 0),
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
};\n`;

export const command = `const { summarize } = require('./summary.cjs');
try {
  if (process.argv.length !== 3) throw new Error('arguments');
  console.log(JSON.stringify(summarize(JSON.parse(process.argv[2]))));
} catch { process.stderr.write('invalid input\\n'); process.exitCode = 2; }
`;
