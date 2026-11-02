import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { resolve } from 'node:path';
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const env = { ...process.env, CONDUCTOR_CHANNEL: 'development', CONDUCTOR_RENDERER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
// Renderer changes use Vite HMR. Restart this command after changing the main process.
const child = spawn(electron, [resolve('.'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
let closing = false;
async function stop(code = 0) { if (closing) return; closing = true; child.kill('SIGTERM'); await server.close(); process.exitCode = code; }
child.on('error', error => { console.error(error.message); void stop(1); });
child.on('exit', code => void stop(code ?? 0));
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
console.log(`Conductor Dev · ${url} · separate development data`);
