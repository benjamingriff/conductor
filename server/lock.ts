import { createServer, type Server } from 'node:net';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Both desktop and legacy server take the same Linux kernel lock per data directory.
// It survives no process, so a crash cannot leave a stale lock behind.
export async function acquireStateLock(directory: string): Promise<Server | null> {
  if (process.platform !== 'linux') return null; // Electron's userData single-instance lock covers macOS.
  const name = '\0conductor-' + createHash('sha256').update(await realpath(directory)).digest('hex').slice(0, 32);
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(name, resolve); });
  return server;
}
