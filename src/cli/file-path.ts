import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** 仅用于匹配；返回给调用者的文件名保留原有大小写。 */
export function pathSearchKey(value: string, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resolved = paths.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function fileSuggestions(input: string): string[] {
  if (!input) return [];
  const normalized = path.normalize(input);
  let directory = path.dirname(normalized);
  try {
    if (statSync(normalized).isDirectory()) directory = normalized;
  } catch {
    // 输入尚未完整时，仍从父目录查找前缀匹配的候选。
  }
  try {
    const prefix = pathSearchKey(normalized);
    return readdirSync(directory)
      .map((name) => path.join(directory, name))
      .filter((candidate) => pathSearchKey(candidate).startsWith(prefix));
  } catch {
    return [];
  }
}
