import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDailySchedule } from '../src/scheduling/daily.ts';

test('Node 每日调度等待下个 UTC 整点、运行中不重叠、失败后次日继续、停止后不再运行', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-01-01T20:59:59Z') });
  let calls = 0;
  let finish: (() => void) | undefined;
  const stop = startDailySchedule(async () => {
    calls++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (calls === 1) throw new Error('temporary');
  }, 21);
  t.after(stop);
  t.mock.timers.tick(999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  t.mock.timers.tick(86400000);
  assert.equal(calls, 1);
  finish!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(86400000);
  assert.equal(calls, 2);
  stop();
  finish!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(86400000);
  assert.equal(calls, 2);
});
