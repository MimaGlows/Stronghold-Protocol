import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function readInstance(root) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'experimental-instance.json'), 'utf8'));
    if (record.root !== root || record.port < 3002 || !/^[a-f0-9]{64}$/.test(record.secret)) return null;
    return record;
  } catch { return null; }
}
export function callControl(record, action) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(record.pipe);
    socket.setTimeout(2000, () => socket.destroy(new Error('Control timeout')));
    socket.once('connect', () => socket.write(JSON.stringify({ action, secret: record.secret }) + '\n'));
    let body = '';
    socket.on('data', (bytes) => { body += bytes; if (body.length > 2048) socket.destroy(new Error('Invalid control response')); });
    socket.on('end', () => {
      try { const reply = JSON.parse(body); if (reply.root !== record.root || reply.pid !== record.pid) throw new Error('Instance identity mismatch'); resolve(reply); }
      catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'status';
  if (!['status', 'stop', 'probe'].includes(action)) throw new Error('Use status or stop');
  const record = readInstance(root);
  if (!record) { if (action === 'probe') process.exitCode = 1; else console.log('Experimental instance is not running'); }
  else {
    try {
      const result = await callControl(record, action === 'probe' ? 'status' : action);
      if (action !== 'probe') console.log(`${action === 'stop' ? 'Graceful stop requested' : 'Running'}: ${result.url} (PID ${result.pid})`);
    } catch { if (action === 'probe') process.exitCode = 1; else console.log('Experimental instance is not running (stale process record)'); }
  }
}
