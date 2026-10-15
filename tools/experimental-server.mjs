// Only this copied installation is started/stopped. No production launcher or PID termination.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/index.js';
import { callControl, readInstance } from './experimental-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const previous = readInstance(root);
if (previous && await callControl(previous, 'status').catch(() => null)) {
  console.log(`Already running: ${previous.url}`); process.exit(0);
}
// An exclusive installation lock also covers two simultaneous double-clicks during startup.
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
const lockFile = path.join(root, 'logs', 'experimental-start.lock');
const lockToken = randomBytes(16).toString('hex');
for (;;) {
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: lockToken })); fs.closeSync(fd); break;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let lock;
    try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { console.log('Experimental instance is starting'); process.exit(0); }
    try { process.kill(lock.pid, 0); console.log('Experimental instance is starting or running'); process.exit(0); }
    catch (checkError) { if (checkError.code !== 'ESRCH') throw checkError; fs.unlinkSync(lockFile); }
  }
}
process.on('exit', () => {
  try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).token === lockToken) fs.unlinkSync(lockFile); } catch { /* already released */ }
});
process.env.SP_COMBAT = 'client'; process.env.SP_VERIFY = 'off'; process.env.TRUST_PROXY = 'auto';
let server;
for (let port = 3002; port <= 65535; port++) {
  try { server = await startServer({ port, host: '127.0.0.1', maintenance: process.env.SP_MAINTENANCE === '1' }); break; }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
}
if (!server) throw new Error('No free experimental port');
const secret = randomBytes(32).toString('hex');
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\sp-matching-${secret.slice(0, 20)}` : path.join(root, 'logs', 'matching-control.sock');
const instance = { root, pid: process.pid, port: server.port, url: server.url + '/', startedAt: Date.now(), pipe, secret };
let closing;
const close = () => {
  if (closing) return closing;
  closing = (async () => {
    control.close();
    await server.close();
    const saved = readInstance(root);
    if (saved?.secret === secret) fs.unlinkSync(path.join(root, 'logs', 'experimental-instance.json'));
    console.log('Experimental instance stopped gracefully');
  })();
  return closing;
};
const control = net.createServer((socket) => {
  socket.setTimeout(2000, () => socket.destroy());
  let text = '';
  socket.on('data', (bytes) => {
    text += bytes;
    if (text.length > 256) { socket.destroy(); return; }
    if (!text.includes('\n')) return;
    let request;
    try { request = JSON.parse(text); } catch { socket.destroy(); return; }
    if (request.secret !== secret || !['status', 'stop', 'stopIdle', 'drain', 'resume'].includes(request.action)) { socket.destroy(); return; }
    if(request.action==='drain'||request.action==='resume')server.lobby.setMaintenance(request.action==='drain');
    const stats=server.lobby.stats(),idle=stats.matches===0;
    socket.end(JSON.stringify({ ok: request.action!=='stopIdle'||idle, capabilities:['drain','resume'],pid: process.pid, root, url: instance.url,...stats }) + '\n');
    if (request.action === 'stop'||request.action==='stopIdle'&&idle) void close();
  });
  socket.on('error', () => {});
});
await new Promise((resolve, reject) => { control.once('error', reject); control.listen(pipe, () => resolve()); });
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
fs.writeFileSync(path.join(root, 'logs', 'experimental-instance.json'), JSON.stringify(instance, null, 2));
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
console.log(`EXPERIMENTAL MATCHMAKING: ${instance.url}`);
