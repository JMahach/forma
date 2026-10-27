import { parentPort, workerData } from 'node:worker_threads';
import { openMailBuffer } from './mail-buffer.ts';
import type { MailBufferRequest } from './mail-buffer-client.ts';

if (!parentPort) throw new Error('Mail buffer worker requires a parent');
let time = Number(workerData.now);
const buffer = openMailBuffer({filename: workerData.filename, now: () => time});
parentPort.on('message', (request: MailBufferRequest) => {
  time = request.now;
  try {
    let value: unknown;
    switch (request.method) {
      case 'stage': value = buffer.stage(JSON.parse(request.payload!)); break;
      case 'acknowledge': value = buffer.acknowledge(JSON.parse(request.payload!)); break;
      case 'batch': value = buffer.batch(); break;
      case 'maintain': value = buffer.maintain(); break;
      case 'usage': value = buffer.usage(); break;
    }
    parentPort!.postMessage({id: request.id, value});
  } catch { parentPort!.postMessage({id: request.id, failed: true}); }
});
parentPort.postMessage({ready: true});
