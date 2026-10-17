import { readFileSync } from 'node:fs';
import type { DeliveryRequest } from './delivery-git.js';
import { deliverRepository } from './delivery-operation.js';

async function main(): Promise<void> {
  const requestFile = process.argv[2]; if (!requestFile) throw new Error('Delivery request file is required');
  const request = JSON.parse(readFileSync(requestFile, 'utf8')) as DeliveryRequest;
  console.log(JSON.stringify({ commit: await deliverRepository(request, `${requestFile}.message`) }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
