// Owns CLI dispatch for profiles, scorecards, exports and comparisons. Controllers still own every
// approval, sequential dispatch, preference and Git integration decision.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Store } from './persistence/store.js';
import { comparisonDecisionKey } from './domain/comparison.js';
import { Comparisons } from './orchestration/comparisons.js';
import { integrateComparison, integrationPreview, recoverIntegration } from './orchestration/comparison-integration.js';
import { currentSettings } from './config/settings.js';
import { readJsonFile } from './cli-input.js';
import { runMetrics } from './reporting/run-metrics.js';
import { exportComparison, exportRun, metricsCsv } from './reporting/run-export.js';
import { comparisonView } from './server/view-model/comparisons.js';

/** The model commands need only positional arguments and an owned journal. */
export interface ModelInvocation {
  action: string;
  positionals: string[];
}

function argument(input: ModelInvocation, index: number): string {
  const value = input.positionals[index];
  if (!value) throw new Error(`${input.action} is missing an argument; see --help`);
  return value;
}

/** Runs one explicit model or comparison command and returns its printable result. */
export async function modelCommand(store: Store, input: ModelInvocation, signal: AbortSignal): Promise<unknown> {
  const comparisons = new Comparisons(store),
    id = input.positionals[1] ?? '';
  switch (input.action) {
    case 'model-profiles':
      return currentSettings().modelProfiles;
    case 'metrics':
      return runMetrics(store, argument(input, 1));
    case 'export':
      return exportRun(store, argument(input, 1));
    case 'comparison-list':
      return store.comparisons();
    case 'comparison-new': {
      const task = store.get(argument(input, 1));
      const profiles = z.array(z.unknown()).parse(readJsonFile(argument(input, 2)));
      return comparisons.create(task.id, task.guided?.digest ?? '', profiles);
    }
    case 'comparison-show':
      return comparisonView(store, id);
    case 'comparison-approve':
      return comparisons.approve(id, argument(input, 2));
    case 'comparison-run':
      return comparisons.run(id, argument(input, 2), signal);
    case 'comparison-pause':
      return comparisons.pause(id, argument(input, 2));
    case 'comparison-recover':
      return comparisons.recover(id, argument(input, 2));
    case 'comparison-select':
      return comparisons.select(id, argument(input, 2), argument(input, 3));
    case 'comparison-integration-preview':
      return {
        expected: comparisonDecisionKey(store.comparison(id)),
        target: integrationPreview(store, id, comparisonDecisionKey(store.comparison(id))),
      };
    case 'comparison-integrate': {
      const spec = z
        .object({ repository: z.string(), branch: z.string(), base: z.string(), commit: z.string() })
        .parse(readJsonFile(argument(input, 3)));
      return integrateComparison(store, id, argument(input, 2), spec);
    }
    case 'comparison-recover-integration':
      return recoverIntegration(store, id, argument(input, 2));
    case 'comparison-export':
      return writeComparisonExport(store, input, id);
    default:
      throw new Error('Unknown model command');
  }
}

/** Explicit file export keeps format and filesystem handling out of command dispatch. */
function writeComparisonExport(store: Store, input: ModelInvocation, id: string) {
  const value = store.comparison(id);
  const data = exportComparison(store, id);
  const format = input.positionals[3] ?? 'json',
    file = argument(input, 2);
  const content =
    format === 'csv' ? metricsCsv(value.runs.map(run => runMetrics(store, run.taskId))) : JSON.stringify(data, null, 2);
  if (!['json', 'csv', 'gzip'].includes(format)) throw new Error('Export format must be json, csv or gzip');
  writeFileSync(file, format === 'gzip' ? gzipSync(content) : content);
  return { file, format };
}
