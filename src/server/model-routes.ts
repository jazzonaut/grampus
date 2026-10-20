// Owns authenticated profile, metrics, comparison and export HTTP routes. State changes delegate to
// controllers; large exports are explicit downloads and never part of dashboard polling.
import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import { currentSettings, readSettingsFile, saveSettingsFile } from '../config/settings.js';
import { availableQualityPasses } from '../domain/quality-passes.js';
import { modelProfilesSchema } from '../domain/model-profiles.js';
import { Comparisons } from '../orchestration/comparisons.js';
import { comparisonDecisionKey } from '../domain/comparison.js';
import {
  integrateComparison,
  integrationPreview,
  recoverIntegration,
} from '../orchestration/comparison-integration.js';
import { runMetrics } from '../reporting/run-metrics.js';
import { exportComparison, exportRun, metricsCsv } from '../reporting/run-export.js';
import { comparisonView } from './view-model/comparisons.js';
import { action } from './view-model/actions.js';
import { HttpError } from './errors.js';
import type { WorkerAction } from './api-schemas.js';

/** Dependencies already protected by the dashboard's bearer, origin and shutdown guards. */
export interface ModelRoutesContext {
  store: Store;
  settingsDirectory: string | null;
  launch: (id: string, work: WorkerAction) => void;
}

const decision = z.object({ expected: z.string() });
const create = z.object({
  sourceTaskId: z.string().uuid(),
  expectedDigest: z.string(),
  profiles: z.array(z.unknown()),
});
const selection = decision.extend({ taskId: z.string().uuid() });
const target = z.strictObject({ repository: z.string(), branch: z.string(), base: z.string(), commit: z.string() });

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.message);
  return result.data;
}

/** Profile catalogue and editor metadata, including saved definitions usable for future approvals. */
export function profilesView(context: Pick<ModelRoutesContext, 'settingsDirectory'>) {
  const file = context.settingsDirectory ? readSettingsFile(context.settingsDirectory) : null;
  return {
    profiles: file?.settings?.modelProfiles ?? currentSettings().modelProfiles,
    expected: file?.revision ?? null,
    editable: file !== null,
    problem: file?.problem ?? null,
    qualityPasses: availableQualityPasses(currentSettings().qualityPasses)
      .filter(pass => pass.kind === 'edit')
      .map(pass => ({ id: pass.id, title: pass.title })),
    efforts: {
      codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  };
}

function saveProfiles(context: ModelRoutesContext, payload: unknown) {
  if (!context.settingsDirectory) throw new Error('This dashboard has no settings file for saving profiles');
  const body = parse(z.object({ expected: z.string(), profiles: modelProfilesSchema }), payload);
  const file = readSettingsFile(context.settingsDirectory);
  const stored = z.record(z.string(), z.unknown()).safeParse(file.stored).data ?? {};
  saveSettingsFile(context.settingsDirectory, { ...stored, modelProfiles: body.profiles }, body.expected);
  return profilesView(context);
}

/** Small read projections; returns undefined for routes owned by another module. */
export function getModelRoute(context: ModelRoutesContext, path: string) {
  const { store } = context;
  if (path === '/api/v1/model-profiles') return profilesView(context);
  if (path === '/api/v1/comparisons')
    return store.comparisons().map(value => ({ id: value.id, name: value.name, status: value.status }));
  const metrics = /^\/api\/v1\/tasks\/([a-f0-9-]+)\/metrics$/.exec(path);
  if (metrics?.[1]) return runMetrics(store, metrics[1]);
  const comparison = /^\/api\/v1\/comparisons\/([a-f0-9-]+)$/.exec(path);
  if (comparison?.[1]) return comparisonView(store, comparison[1]);
  const preview = /^\/api\/comparisons\/([a-f0-9-]+)\/integration-preview$/.exec(path);
  if (!preview?.[1]) return undefined;
  const value = store.comparison(preview[1]),
    expected = comparisonDecisionKey(value);
  const spec = integrationPreview(store, value.id, expected);
  return {
    target: spec,
    action: action({
      id: 'comparison-integrate',
      label: 'Integrate selected result',
      kind: 'primary',
      description: `Fast-forward ${spec.branch} in ${spec.repository} from ${spec.base} to ${spec.commit}.`,
      path: `/api/comparisons/${value.id}/integrate`,
      expected,
      body: { expected, target: spec },
      confirm: 'Integrate this selected result into the displayed clean working branch?',
    }),
  };
}

/** Delegates one state-changing profile or comparison request; unrecognised routes return undefined. */
export async function postModelRoute(context: ModelRoutesContext, path: string, payload: unknown) {
  const comparisons = new Comparisons(context.store);
  if (path === '/api/model-profiles') return saveProfiles(context, payload);
  if (path === '/api/comparisons') {
    const body = parse(create, payload);
    return comparisons.create(body.sourceTaskId, body.expectedDigest, body.profiles);
  }
  const match =
    /^\/api\/comparisons\/([a-f0-9-]+)\/(approve|run|pause|recover|select|integrate|recover-integration)$/.exec(path);
  const id = match?.[1],
    command = match?.[2];
  if (!id || !command) return undefined;
  const { expected } = parse(decision, payload);
  switch (command) {
    case 'pause':
      return comparisons.pause(id, expected);
    case 'approve':
      return comparisons.approve(id, expected);
    case 'run':
      context.launch(id, { action: 'comparison-run', payload: { expected } });
      return { ok: true };
    case 'recover':
      return comparisons.recover(id, expected);
    case 'select':
      return comparisons.select(id, expected, parse(selection, payload).taskId);
    case 'integrate':
      return integrateComparison(context.store, id, expected, parse(decision.extend({ target }), payload).target);
    case 'recover-integration':
      return recoverIntegration(context.store, id, expected);
  }
  return undefined;
}

/** Explicit full export response, with structured JSON, spreadsheet metrics or compressed JSON. */
export function downloadModelRoute(store: Store, path: string, url: URL, response: ServerResponse): boolean {
  const match = /^\/api\/(tasks|comparisons)\/([a-f0-9-]+)\/export$/.exec(path);
  const kind = match?.[1],
    id = match?.[2];
  if (!kind || !id) return false;
  const format = parse(z.enum(['json', 'csv', 'gzip']), url.searchParams.get('format') ?? 'json');
  const rows =
    kind === 'tasks' ? [runMetrics(store, id)] : store.comparison(id).runs.map(run => runMetrics(store, run.taskId));
  let body: string | Buffer;
  if (format === 'csv') body = metricsCsv(rows);
  else {
    const data = kind === 'tasks' ? exportRun(store, id) : exportComparison(store, id);
    body = JSON.stringify(data, null, 2);
    if (format === 'gzip') body = gzipSync(body);
  }
  const extension = format === 'gzip' ? 'json.gz' : format;
  response.writeHead(200, {
    'Content-Type':
      format === 'csv'
        ? 'text/csv; charset=utf-8'
        : format === 'gzip'
          ? 'application/gzip'
          : 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="grampus-${id}.${extension}"`,
  });
  response.end(body);
  return true;
}
