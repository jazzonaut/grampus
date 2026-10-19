// Pins the shape of a repository snapshot (`artifacts.ts`) wherever one is read back from outside the
// capturing process: journal records (checks, implementations, deliveries) and the delivery worker's
// request file. Snapshot content is the evidence an artifact digest covers, so a snapshot that fails this
// schema is refused with a categorised `BoundaryError` rather than trusted as evidence.
import { z } from 'zod';

const encodingSchema = z.enum(['utf8', 'base64']);

/** One hashed file of the inventory; `sha256` is null for a tracked path that is absent from the worktree. */
export const snapshotFileSchema = z.object({
  path: z.string(),
  sha256: z.string().nullable(),
  executable: z.boolean(),
});

/** One changed path against the pinned base, with retained old and new bytes. */
export const snapshotChangeSchema = z.object({
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  encoding: encodingSchema,
  content: z.string().nullable(),
  previousEncoding: encodingSchema,
  previousContent: z.string().nullable(),
});

/** A whole snapshot as `snapshotRepository` returns it; only the shape is checked, not the digest. */
export const repositorySnapshotSchema = z.object({
  artifact: z.string(),
  head: z.string(),
  index: z.string(),
  files: z.array(snapshotFileSchema),
  diff: z.array(snapshotChangeSchema),
  instructions: z.array(z.object({ path: z.string(), content: z.string() })),
  instructionsDigest: z.string(),
});

/** Content evidence for one repository state; its `artifact` digest covers head, index, files, diff and instructions. */
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
