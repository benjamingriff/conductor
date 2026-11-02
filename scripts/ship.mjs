import { spawnSync } from 'node:child_process';
const bump = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('Use: npm run ship -- patch|minor|major');
function run(args) { const result = spawnSync('npm', args, { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status ?? 1); }
run(['test']); run(['run', 'check']);
run(['version', bump, '--no-git-tag-version']);
run(['run', 'build']); run(['run', 'package']); run(['run', 'test:packaged']); run(['run', 'install:desktop']);
