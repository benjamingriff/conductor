import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStateLock } from './lock.js';
test('desktop and server cannot own the same Linux scheduler data concurrently', { skip: process.platform !== 'linux' }, async () => {
  const path = await mkdtemp(join(tmpdir(), 'conductor-lock-'));
  const first = await acquireStateLock(path);
  try { await assert.rejects(acquireStateLock(path), { code: 'EADDRINUSE' }); }
  finally { await new Promise<void>(r => first!.close(() => r())); }
  const recovered = await acquireStateLock(path);
  await new Promise<void>(r => recovered!.close(() => r()));
  await rm(path, { recursive: true });
});
