'use strict';
// A dedicated process group belongs to this app session. Never use global pkill/killall.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const expectedParent = Number(process.env.LIBRETV_DESKTOP_PARENT_PID || process.ppid);
const stateFile = process.env.LIBRETV_DESKTOP_STATE_PATH;
const server = process.argv[2];
if (!server) { console.error('Missing LibreTV server entry'); process.exit(64); }
let ending = false;
const child = spawn(process.execPath, [server], {
  cwd: require('node:path').dirname(server),
  env: process.env,
  detached: true,
  stdio: 'inherit',
});
function signalGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error('Service group cleanup:', error.message); }
}
function finish(code) {
  if (stateFile) { try { fs.unlinkSync(stateFile); } catch {} }
  process.exit(code);
}
function shutdown(code = 0) {
  if (ending) return;
  ending = true;
  clearInterval(parentWatch);
  signalGroup('SIGTERM');
  // Children can ignore TERM or outlive the server. Keep the supervisor until the entire group is gone.
  const start = Date.now();
  const sweep = setInterval(() => {
    try { process.kill(-child.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { clearInterval(sweep); finish(code); return; } }
    if (Date.now() - start >= 900) {
      signalGroup('SIGKILL'); clearInterval(sweep);
      setTimeout(() => finish(code), 100);
    }
  }, 40);
}
const parentWatch = setInterval(() => {
  // Reparenting is more reliable than merely testing whether an old PID has been reused.
  if (process.ppid !== expectedParent) shutdown(0);
}, 200);
child.once('spawn', () => {
  if (stateFile) {
    fs.writeFileSync(stateFile, JSON.stringify({ instance: process.env.LIBRETV_DESKTOP_INSTANCE, supervisor: process.pid, service: child.pid, group: child.pid }), { mode: 0o600 });
  }
});
child.once('error', error => { console.error('LibreTV service spawn failed:', error.message); shutdown(1); });
child.once('exit', code => shutdown(code ?? 1));
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('SIGHUP', () => shutdown());
