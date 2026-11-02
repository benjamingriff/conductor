import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/desktop', { recursive: true });
await cp('desktop/preload.cjs', 'dist/desktop/preload.cjs');
