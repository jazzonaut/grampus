// Entry point of the supervised delivery worker: reads the validated request file and performs the
// one local commit (or no-change proof) inside the check supervisor's job.
import { deliverRepository } from './delivery-operation.js';
import { readDeliveryRequest } from './worker-files.js';

async function main(): Promise<void> {
  const requestFile = process.argv[2];
  if (!requestFile) throw new Error('Delivery request file is required');
  const request = readDeliveryRequest(requestFile);
  console.log(JSON.stringify({ commit: await deliverRepository(request, `${requestFile}.message`) }));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
