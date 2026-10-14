import {parentPort,workerData} from 'node:worker_threads';
globalThis.self={postMessage:value=>parentPort.postMessage(value)};
await import(workerData.moduleUrl);
parentPort.on('message',data=>self.onmessage({data}));
