// Owns self-contained JSON exports of retained controller evidence. Attachments are read explicitly,
// never from dashboard previews, and missing or oversized files retain a coverage explanation.
import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { journalSchemaVersion, type Store } from '../persistence/store.js';
import { applicationVersion } from '../config/runtime.js';
import { profileLimits } from '../config/limits.js';
import { taskTurnUsage, planningUsage } from './task-usage.js';
import { runPatch } from './run-patch.js';
import { runMetrics } from './run-metrics.js';

/** A retained file with an explicit completeness statement, encoded without losing binary bytes. */
export function exportAttachment(directory: string, name: string) {
  const path = join(directory, name);
  try {
    const bytes = statSync(path).size;
    if (bytes > profileLimits.exportAttachmentBytes)
      return { name, status: 'too_large' as const, bytes, sha256: null, encoding: 'base64' as const, content: null };
    const content = readFileSync(path);
    return {
      name,
      status: 'included' as const,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      encoding: 'base64' as const,
      content: content.toString('base64'),
    };
  } catch {
    return {
      name,
      status: 'unavailable' as const,
      bytes: null,
      sha256: null,
      encoding: 'base64' as const,
      content: null,
    };
  }
}

/** Captures journal records consistently, without holding the SQLite writer lock during file or Git reads. */
function captureRun(store: Store, taskId: string) {
  return store.transaction(() => {
    const task = store.get(taskId);
    const events = store.events(taskId);
    const executions = store
      .executions()
      .filter(item => item.taskId === taskId)
      .map(execution => ({
        record: execution,
        events: store.executionEvents(execution.id),
        checks: store.checks(execution.id),
        implementations: store.implementations(execution.id),
        deliveries: store.deliveries(execution.id),
      }));
    const ids = new Set(executions.map(item => item.record.sessionId));
    for (const turn of taskTurnUsage(store, taskId)) ids.add(turn.sessionId);
    for (const event of events.filter(item => item.type === 'guided.kickoff_linked')) {
      const linked = z.object({ sessionId: z.string() }).parse(event.data);
      ids.add(linked.sessionId);
    }
    const sessions = [...ids].map(id => ({ record: store.session(id), events: store.sessionEvents(id) }));
    const workspace = store.workspaces().find(item => item.taskId === taskId) ?? null;
    const records = {
      task,
      events,
      executions,
      sessions,
      workspace,
      workspaceEvents: workspace ? store.workspaceEvents(workspace.id) : [],
    };
    const artifacts = new Set(JSON.stringify(records).match(/sha256:[a-f0-9]{64}/g) ?? []);
    const snapshots = [...artifacts].map(artifact => ({ artifact, snapshot: store.snapshot(artifact) }));
    const directories = new Set(
      executions.flatMap(item =>
        [...item.checks, ...item.implementations, ...item.deliveries].flatMap(record =>
          record.receipt ? [record.receipt.directory] : [],
        ),
      ),
    );
    return {
      format: 'grampus.run',
      journalSchemaVersion,
      controller: {
        version: applicationVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      metrics: runMetrics(store, taskId),
      turns: taskTurnUsage(store, taskId),
      ...records,
      snapshots,
      directories: [...directories],
      coverage: {
        snapshot: 'Journal records captured in one transaction; active file logs may still grow.',
        attachmentByteLimit: profileLimits.exportAttachmentBytes,
        providerInternals: 'Only activity and usage retained by Grampus are available.',
        pricing: 'Provider estimates only; actual subscription charges and quota consumption are unknown.',
      },
    };
  });
}

/** Complete retained evidence, with attachment reads outside the journal transaction. */
export function exportRun(store: Store, taskId: string) {
  return finishExport(captureRun(store, taskId));
}

function finishExport(capture: ReturnType<typeof captureRun>) {
  const { directories, ...data } = capture;
  return {
    ...data,
    patch: runPatch(
      data.task,
      data.executions.flatMap(item => item.deliveries),
    ),
    attachments: directories.map(directory => ({
      directory,
      files: ['stdout', 'stderr', 'completion.json', 'result.json'].map(name => exportAttachment(directory, name)),
    })),
  };
}

export type RunExport = ReturnType<typeof exportRun>;

/** Complete comparison export includes the shared planning record once, including its full journal. */
export function exportComparison(store: Store, id: string) {
  const capture = store.transaction(() => {
    const comparison = store.comparison(id),
      planningId = comparison.planningSessionId;
    return {
      format: 'grampus.comparison',
      journalSchemaVersion,
      controller: {
        version: applicationVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      comparison,
      events: store.comparisonEvents(id),
      sharedPlanning: planningId
        ? {
            record: store.session(planningId),
            events: store.sessionEvents(planningId),
            usage: planningUsage(store, planningId),
          }
        : null,
      runs: comparison.runs.map(run => captureRun(store, run.taskId)),
    };
  });
  return { ...capture, runs: capture.runs.map(finishExport) };
}

/** Machine-readable scorecard table. JSON preserves all coverage and per-turn details. */
export function metricsCsv(rows: ReturnType<typeof runMetrics>[]): string {
  const fields = [
    'taskId',
    'title',
    'status',
    'verifiedDelivery',
    'elapsedMs',
    'workflowActiveMs',
    'waitingMs',
    'recoveryMs',
    'reusedChecks',
    'savedCheckMs',
    'agentMs',
    'repairAttempts',
    'turns',
    'interventions',
    'tokens',
    'tokenCompleteness',
  ] as const;
  const quote = (value: string | number | boolean | null) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const values = rows.map(row => [
    row.taskId,
    row.title,
    row.status,
    row.verifiedDelivery,
    row.elapsedMs,
    row.workflowActiveMs,
    row.waitingMs,
    row.recoveryMs,
    row.reusedChecks,
    row.savedCheckMs,
    row.agentMs,
    row.repairAttempts,
    row.usage.turns,
    row.interventions.total,
    row.usage.headline.tokens,
    row.usage.headline.completeness,
  ]);
  return [fields, ...values].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
