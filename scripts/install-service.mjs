import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('The persistent user-service installer requires Linux/systemd.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await access(join(root, 'dist/server/main.js')); await access(join(root, 'dist/web/index.html'));
const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
const unitPath = join(unitDir, 'conductor.service');
const quote = text => '"' + text.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
try { const existing = await readFile(unitPath, 'utf8'); if (!existing.startsWith('# Managed by Conductor')) throw new Error(`An unrelated service already exists at ${unitPath}; refusing to replace it.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const environment = { PATH: [dirname(process.execPath), join(homedir(), '.local/share/mise/installs/codex/latest/bin'), join(homedir(), '.local/share/mise/installs/claude/latest'), join(homedir(), '.local/share/mise/shims'), join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), CONDUCTOR_PORT: process.env.CONDUCTOR_PORT ?? '4317', CONDUCTOR_STATE_DIR: process.env.CONDUCTOR_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'conductor') };
for (const key of ['CONDUCTOR_CODEX_BIN', 'CONDUCTOR_CLAUDE_BIN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) if (process.env[key]) environment[key] = process.env[key];
const directoryValue = root.replaceAll('\\', '\\x5c').replaceAll('%', '%%').replaceAll(' ', '\\x20').replaceAll('\n', '\\n');
const unit = `# Managed by Conductor — regenerate with npm run service:install\n[Unit]\nDescription=Conductor local webhook scheduler\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${directoryValue}\nExecStart=${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(join(root, 'dist/server/main.js'))}\n${Object.entries(environment).map(([key,value]) => 'Environment=' + quote(key + '=' + value)).join('\n')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=40\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
await mkdir(unitDir, { recursive: true }); await writeFile(unitPath, unit, { mode: 0o600 });
execFileSync('systemd-analyze', ['--user', 'verify', unitPath], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', 'conductor.service'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', 'conductor.service'], { stdio: 'inherit' });
if (process.argv.includes('--linger')) {
  try { execFileSync('loginctl', ['--no-ask-password', 'enable-linger', process.env.USER ?? ''], { stdio: 'inherit' }); console.log('User lingering enabled: the service can start before login.'); }
  catch { console.log('User lingering could not be enabled automatically. Run loginctl enable-linger for your user to allow startup before login.'); }
}
console.log(`Installed ${unitPath}\nDashboard: http://localhost:${environment.CONDUCTOR_PORT}\nStatus: systemctl --user status conductor.service`);
