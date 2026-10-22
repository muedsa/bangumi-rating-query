import { stripVTControlCharacters } from 'node:util';
import { Writable } from 'node:stream';
import { clearLine, clearScreenDown, cursorTo, moveCursor } from 'node:readline';

/** 上游名称、摘要和异常信息不能作为终端控制序列执行。 */
export function display(value: unknown) {
  return stripVTControlCharacters(String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Clack 使用 Node 的颜色函数；统一去除 SGR，保留光标控制供菜单重绘。 */
export function terminalOutput(
  target: Writable,
  noColor = process.env.NO_COLOR !== undefined,
): Writable {
  if (!noColor) return target;
  const write = target.write.bind(target);
  const stream = new Writable({
    write(chunk, _encoding, done) {
      write(String(chunk).replace(/\u001b\[[\d;]*m/gu, ''), done);
    },
  });
  for (const key of ['isTTY', 'columns', 'rows'] as const)
    Object.defineProperty(stream, key, {
      get: () => (target as unknown as Record<string, unknown>)[key],
    });
  Object.assign(stream, {
    cursorTo: (x: number, y?: number) => cursorTo(stream, x, y),
    moveCursor: (x: number, y: number) => moveCursor(stream, x, y),
    clearLine: (direction: -1 | 0 | 1) => clearLine(stream, direction),
    clearScreenDown: () => clearScreenDown(stream),
  });
  return stream;
}
