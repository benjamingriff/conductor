import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = resolve('.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'conductor-package-'));
try {
  await cp('dist', join(staging, 'dist'), { recursive: true });
  await cp('public', join(staging, 'public'), { recursive: true });
  await cp('THIRD_PARTY_NOTICES.md', join(staging, 'THIRD_PARTY_NOTICES.md'));
  await mkdir(join(staging, 'node_modules'), { recursive: true });
  const dependencies = Object.fromEntries(['luxon', 'zod'].map(name => [name, pkg.dependencies[name]]));
  for (const name of Object.keys(dependencies)) await cp(join('node_modules', name), join(staging, 'node_modules', name), { recursive: true });
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'Conductor', version: pkg.version, type: 'module', main: pkg.main, description: pkg.description, dependencies }));
  const outputs = await packager({ dir: staging, name: 'Conductor', executableName: 'conductor', appBundleId: 'dev.conductor.desktop', appVersion: pkg.version, electronVersion: pkg.devDependencies.electron, platform: process.platform, arch: process.arch, out: join(root, 'release'), overwrite: true, asar: true, prune: false, ...(process.platform === 'linux' ? { icon: join(root, 'public/icon.png') } : {}) });
  console.log(outputs.join('\n'));
} finally { await rm(staging, { recursive: true, force: true }); }
