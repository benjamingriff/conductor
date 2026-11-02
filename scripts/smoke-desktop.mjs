import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
const root = await mkdtemp(join(tmpdir(), 'conductor-smoke-'));
const output = join(root, 'capture'); await mkdir(output);
const packaged = process.argv[2] === '--packaged';
const binary = packaged ? resolve(`release/Conductor-${process.platform}-${process.arch}/${process.platform === 'darwin' ? 'Conductor.app/Contents/MacOS/conductor' : 'conductor'}`) : process.argv[2] ? resolve(process.argv[2]) : electron;
const args = process.argv[2] ? ['--smoke'] : [resolve('.'), '--smoke'];
const env = { ...process.env, CONDUCTOR_CHANNEL: 'development', CONDUCTOR_STATE_DIR: join(root, 'state'), CONDUCTOR_SMOKE_DIR: output };
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_RENDERER_URL;
const child = spawn(binary, args, { env, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill('SIGTERM'); process.exitCode = 1; }, 60_000);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`Electron smoke exited ${code}. Capture: ${output}`);
  try { const error = await readFile(join(output, 'error.txt'), 'utf8'); throw new Error(error + ` Capture: ${output}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ ...result, capture: output }, null, 2));
} finally { clearTimeout(timer); }
