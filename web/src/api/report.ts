// The task report: Markdown built from the journal by `GET /api/tasks/:id/report`, shown or downloaded.
import type { ReportResponse } from '../../../src/server/api-types';
import { downloadUrlLifetimeMs } from '../settings';
import { get } from './client';

/** Fetches the report text. */
export async function fetchReport(path: string): Promise<string> {
  return (await get<ReportResponse>(path)).report;
}

/** Fetches the report and saves it as `grampus-<task id>.md`. */
export async function downloadReport(path: string, taskId: string): Promise<void> {
  const text = await fetchReport(path);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `grampus-${taskId}.md`;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, downloadUrlLifetimeMs);
}
