// Hosted multiplayer entry. The local hub remains `npm start`; this starts the separate /v1 service.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HostedService } from './src/service/service.js';

const env = resolve('..', '.env');
if (existsSync(env)) process.loadEnvFile(env);
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '127.0.0.1';
const service = new HostedService({ root: process.env.DATA_DIR, port, host });
const address = await service.listen();
console.log(`Hosted service: http://localhost:${address.port}/`);
console.log(`Host page: http://localhost:${address.port}/host#token=${service.hostToken}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  service.close().finally(() => process.exit(0));
});
