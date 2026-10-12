// Local test server controller. Windows deployments use the existing start-windows.bat/service scripts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'server/index.js');
const LOG = path.join(ROOT, 'logs/test-server.log');
const STATE = path.join(ROOT, 'logs/test-server.json');
const HOST = process.env.HOST || '127.0.0.1';
const action = process.argv[2] || 'status';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function state() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } }
function owned(s) {
  if (!s || !Number.isInteger(s.pid)) return false;
  try {
    process.kill(s.pid, 0);
    // Refuse a stale PID file that points at an unrelated process.
    return execFileSync('ps', ['-p', String(s.pid), '-o', 'command='], { encoding: 'utf8' }).includes(ENTRY);
  } catch { return false; }
}
function addresses(port, host) {
  const urls = new Set([`http://localhost:${port}`]);
  if (host !== '0.0.0.0' && host !== '::') return [...urls];
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) {
    if (item.family === 'IPv4' && !item.internal && !/^(198\.18\.|169\.254\.)/.test(item.address)) urls.add(`http://${item.address}:${port}`);
  }
  return [...urls];
}
async function free(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}
async function status() {
  const s = state();
  if (!owned(s)) { console.log('测试服务器未运行'); return; }
  let health;
  try { health = await (await fetch(`http://127.0.0.1:${s.port}/healthz`, { signal: AbortSignal.timeout(2000) })).json(); }
  catch { health = { ok: false }; }
  console.log(JSON.stringify({ pid: s.pid, host: s.host || '0.0.0.0', health, urls: addresses(s.port, s.host || '0.0.0.0'), log: LOG }, null, 2));
}
async function stop() {
  const s = state();
  if (owned(s)) {
    process.kill(s.pid, 'SIGTERM');
    for (let i = 0; i < 50 && owned(s); i++) await wait(100);
    if (owned(s)) throw new Error('服务器未停止，请检查日志');
  }
  fs.rmSync(STATE, { force: true }); console.log('测试服务器已停止');
}
async function start() {
  if (owned(state())) { await status(); return; }
  let port = 3000;
  if (!await free(port)) port = 3001;
  if (!await free(port)) throw new Error('3000 和 3001 端口均已占用');
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const fd = fs.openSync(LOG, 'a');
  fs.writeSync(fd, `\n[test-server] ${new Date().toISOString()} start\n`);
  const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, detached: true, env: { ...process.env, HOST, PORT: String(port) }, stdio: ['ignore', fd, fd] });
  let error = null; child.on('error', (e) => { error = e; }); child.unref(); fs.closeSync(fd);
  const s = { pid: child.pid, host: HOST, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  for (let i = 0; i < 50; i++) {
    if (error) throw error;
    if (!owned(s)) throw new Error(`服务器启动失败，查看 ${LOG}`);
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).json();
      if (health.ok) { await status(); return; }
    } catch { /* booting */ }
    await wait(100);
  }
  throw new Error(`服务器启动超时，查看 ${LOG}`);
}
if (process.platform === 'win32') throw new Error('Windows 请使用 scripts/start-windows.bat');
try {
  if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else if (action === 'restart') { await stop(); await start(); }
  else if (action === 'status') await status();
  else throw new Error('使用 start / stop / restart / status');
} catch (e) { console.error(e.message); process.exitCode = 1; }
