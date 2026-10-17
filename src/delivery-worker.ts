import { readFileSync, writeFileSync } from 'node:fs';
import { snapshotRepository } from './artifacts.js';
import { deliveryGit, gitText, verifyTree, verifyCommit, deliveryMessage, type DeliveryRequest } from './delivery-git.js';

async function main(): Promise<void> {
  const requestFile = process.argv[2]; if (!requestFile) throw new Error('Delivery request file is required');
  const request = JSON.parse(readFileSync(requestFile, 'utf8')) as DeliveryRequest;
  const snapshot = await snapshotRepository(request.cwd, request.base);
  if (snapshot.artifact !== request.snapshot.artifact || gitText(request.cwd, 'symbolic-ref', 'HEAD') !== request.branch) throw new Error('Repository changed before delivery dispatch');
  deliveryGit(request.cwd, 'add', '--all', '--', '.');
  verifyTree(request.cwd, request.snapshot);
  if (gitText(request.cwd, 'rev-parse', 'HEAD') !== request.snapshot.head) throw new Error('HEAD changed before commit');
  const messageFile = `${requestFile}.message`; writeFileSync(messageFile, deliveryMessage(request));
  deliveryGit(request.cwd, 'commit', '--cleanup=verbatim', '--file', messageFile);
  console.log(JSON.stringify({ commit: verifyCommit(request) }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
