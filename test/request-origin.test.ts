// Owns origin normalisation coverage for the default HTTP port, without reserving port 80 on the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { dashboardRequestUrl } from '../src/server/request-origin.js';

test('LAN origin checks accept browser headers which omit the default HTTP port', () => {
  const socket = new Socket();
  Object.defineProperties(socket, {
    localAddress: { value: '192.168.1.10' },
    localPort: { value: 80 },
  });
  const request = new IncomingMessage(socket);
  request.url = '/api/v1/overview';
  request.headers = { host: '192.168.1.10', origin: 'http://192.168.1.10' };
  assert.equal(dashboardRequestUrl(request, 'http://127.0.0.1:80', true).href, 'http://192.168.1.10/api/v1/overview');
});
