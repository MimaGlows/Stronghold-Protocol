// Opt-in process test: SP_INSTANCE_E2E=1 node --test test/experimental-instance.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { callControl, readInstance } from '../tools/experimental-control.mjs';

test('experimental launcher falls back, authenticates its controls, prevents duplicate starts, stops only its instance', { skip: process.env.SP_INSTANCE_E2E !== '1', timeout: 60000 }, async () => {
  const root = path.resolve('.');
  const existing = readInstance(root);
  assert.equal(existing && await callControl(existing, 'status').catch(() => null), null, 'run this check before starting the experimental instance');
  const occupant = net.createServer();
  await new Promise((resolve, reject) => { occupant.once('error', reject); occupant.listen(3002, '127.0.0.1', resolve); });
  let child, record;
  try {
    child = spawn(process.execPath, ['tools/experimental-server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (x) => { output += x; }); child.stderr.on('data', (x) => { output += x; });
    for (let i = 0; i < 100; i++) {
      record = readInstance(root);
      if (record && record.pid === child.pid && await callControl(record, 'status').catch(() => null)) break;
      if (child.exitCode !== null) throw new Error(output);
      await delay(100);
    }
    assert.ok(record?.pid === child.pid, output); assert.ok(record.port >= 3003);
    assert.equal((await fetch(record.url + 'healthz')).status, 200);
    await assert.rejects(callControl({ ...record, secret: '0'.repeat(64) }, 'stop'));
    assert.equal((await callControl(record, 'status')).pid, child.pid);
    const duplicate = spawn(process.execPath, ['tools/experimental-server.mjs'], { cwd: root, windowsHide: true, stdio: 'ignore' });
    assert.equal((await once(duplicate, 'exit'))[0], 0); assert.equal(readInstance(root).pid, child.pid);
    const exited = once(child, 'exit'); await callControl(record, 'stop'); assert.equal((await exited)[0], 0);
    assert.equal(readInstance(root), null); assert.equal(occupant.listening, true);
  } finally {
    if (child && child.exitCode === null && record?.pid === child.pid) await callControl(record, 'stop').catch(() => {});
    await new Promise((resolve) => occupant.close(resolve));
  }
});
