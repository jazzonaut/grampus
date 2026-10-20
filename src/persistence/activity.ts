// Owns bounded reads across task and planning journals. Clock order is presentation order, not causation.
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseJson } from '../process/boundary.js';

/** The stable tie-breaker for an activity window. Sequences remain local to their original journal. */
export const activityCursorSchema = z.tuple([
  z.string().datetime(),
  z.enum(['task', 'session']),
  z.number().int().positive(),
]);
export type ActivityCursor = z.infer<typeof activityCursorSchema>;

/** The journal owner whose activity is displayed, without inventing a task for unconverted planning. */
export interface ActivityScope {
  kind: 'task' | 'planning';
  id: string;
}

// UNION retains each session once even when multiple task versions link the same planner.
function linkedSessions(scope: ActivityScope): { sql: string; parameters: string[] } {
  return scope.kind === 'planning'
    ? { sql: 'SELECT ? AS id', parameters: [scope.id] }
    : {
        sql: `SELECT session_id AS id FROM executions WHERE task_id = ?
          UNION SELECT json_extract(data, '$.sessionId') FROM events
          WHERE task_id = ? AND type = 'guided.kickoff_linked'`,
        parameters: [scope.id, scope.id],
      };
}

const rowSchema = z.object({
  sequence: z.number(),
  at: z.string(),
  type: z.string(),
  data: z.string(),
  origin: z.enum(['task', 'session']),
  owner: z.string(),
  version: z.number().nullable(),
  executionId: z.string().nullable(),
});

/** Original event fields, with immutable provenance for navigating back to the source journal. */
export type ActivityRecord = Omit<z.infer<typeof rowSchema>, 'data'> & { data: unknown };

/**
 * Reads one window without loading streamed output from the rest of the task. Both branches use the
 * existing owner/sequence indexes. Explicit links include planning before conversion and every version.
 */
export function readActivity(
  db: DatabaseSync,
  scope: ActivityScope,
  before: ActivityCursor | null,
  limit: number,
): ActivityRecord[] {
  const cutoff = before ? 'WHERE (at, origin, sequence) < (?, ?, ?)' : '';
  const linked = linkedSessions(scope);
  const rows = db
    .prepare(
      `
    WITH linked AS (${linked.sql}), activity AS (
      SELECT sequence, at, type, 'task' AS origin, task_id AS owner,
        version, NULL AS executionId FROM events WHERE task_id = ?
      UNION ALL
      SELECT e.sequence, e.at, e.type, 'session', e.session_id,
        json_extract(x.state, '$.version'), x.id
      FROM session_events e LEFT JOIN executions x ON x.session_id = e.session_id
      WHERE e.session_id IN (SELECT id FROM linked)
    ), page AS MATERIALIZED (
      SELECT * FROM activity ${cutoff} ORDER BY at DESC, origin DESC, sequence DESC LIMIT ?
    ) SELECT page.*, CASE origin
      WHEN 'task' THEN (SELECT data FROM events WHERE sequence = page.sequence)
      ELSE (SELECT data FROM session_events WHERE sequence = page.sequence)
    END AS data FROM page ORDER BY at DESC, origin DESC, sequence DESC
  `,
    )
    .all(...linked.parameters, scope.kind === 'task' ? scope.id : null, ...(before ?? []), limit);
  return rows.map(value => {
    const row = rowSchema.parse(value);
    return { ...row, data: parseJson(row.data, { kind: 'journal-record', source: 'activity' }) };
  });
}

/** The immutable session links used to retain participants even outside the current event window. */
export function activitySessionIds(db: DatabaseSync, scope: ActivityScope): string[] {
  const linked = linkedSessions(scope);
  return db
    .prepare(linked.sql)
    .all(...linked.parameters)
    .map(row => z.object({ id: z.string() }).parse(row).id);
}

/** Tool participants are introduced by actual observations, never merely by an agent's configured tools. */
export function activityToolSessionIds(db: DatabaseSync, scope: ActivityScope): string[] {
  const linked = linkedSessions(scope);
  return db
    .prepare(
      `WITH linked AS (${linked.sql})
    SELECT DISTINCT session_id AS id FROM session_events WHERE session_id IN (SELECT id FROM linked)
    AND (type IN ('tool.deleted',
    'repository.tool_requested', 'repository.tool_result') OR
    (type LIKE 'activity.%' AND json_extract(data, '$.data.kind') = 'tool'))`,
    )
    .all(...linked.parameters)
    .map(row => z.object({ id: z.string() }).parse(row).id);
}
