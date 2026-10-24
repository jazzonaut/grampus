// The command supplied to workers must reject the exact report mistakes observed in live comparisons.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { reportContract, reportCorrection } from '../src/pipeline/report-contract.js';
import { commitAll, createRepository, reviewJson, specText, write } from './helpers/task-fixture.js';

test('worker validation rejects extra fields, invalid lines and missing coverage without changing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grampus report '));
  const report = join(dir, 'report.json');
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, specText());
  const validator = fileURLToPath(new URL('../src/validate-report.js', import.meta.url));
  const validate = (json: string) => {
    writeFileSync(report, json);
    return spawnSync(process.execPath, [validator, report, 'code', spec], { encoding: 'utf8' });
  };
  assert.equal(validate(reviewJson('unknown')).status, 0, 'valid unknown is not a schema error');
  const extra = { ...(JSON.parse(reviewJson('approve')) as object), assumptions: [] };
  assert.match(validate(JSON.stringify(extra)).stderr, /Unrecognized key/);
  assert.match(
    validate(reviewJson('changes', [{ severity: 'blocking', title: 'Failure', line: 0 }])).stderr,
    /Too small/,
  );
  assert.match(validate('{"verdict":"approve","summary":"ok","findings":[]}').stderr, /coverage.*missing/i);
  const contract = reportContract(report, 'code', spec);
  assert.ok(contract.includes(`node "${validator}" "${report}" code "${spec}"`));
  assert.match(contract, /additionalProperties/);
  assert.match(contract, /regressionTest/);
  assert.match(
    reportCorrection({
      previousPath: report,
      reportPath: join(dir, 'next.json'),
      specPath: spec,
      kind: 'code',
      error: 'extra field',
    }),
    /Do not upgrade a verdict/,
  );
});

test('worker validation catches suite-prefixed and uncommitted regression references before submission', async () => {
  const repo = await createRepository();
  write(repo, 'test/named.test.js', 'const title = "preserves held state"; console.log(title);');
  await commitAll(repo, 'Add named regression fixture');
  const spec = join(repo, 'spec.md');
  const path = join(repo, 'report.json');
  writeFileSync(spec, specText());
  const validator = fileURLToPath(new URL('../src/validate-report.js', import.meta.url));
  const validate = (title: string) => {
    const report = JSON.parse(reviewJson('unknown')) as Record<string, unknown>;
    report['probes'] = [
      {
        scenario: 'Hold',
        suggestedPath: 'test/named.test.js',
        command: 'node test/named.test.js',
        source: 'fixture',
        regressionTest: { file: 'test/named.test.js', test: title },
      },
    ];
    writeFileSync(path, JSON.stringify(report));
    return spawnSync(process.execPath, [validator, path, 'code', spec], { cwd: repo, encoding: 'utf8' });
  };
  const qualified = validate('Snake > preserves held state');
  assert.equal(qualified.status, 1);
  assert.match(qualified.stderr, /exact leaf test title/);
  assert.equal(validate('preserves held state').status, 0);
  write(repo, 'test/named.test.js', 'const title = "uncommitted replacement";');
  assert.equal(validate('uncommitted replacement').status, 1, 'only the committed candidate supplies evidence');
});
