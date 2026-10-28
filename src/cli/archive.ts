import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { finished, pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { Unzip, UnzipInflate } from 'fflate';
import { z } from 'zod';
import { createInterface } from 'node:readline';
import { checkCancelled } from './cancellation.ts';

export async function* archiveLines(path: string) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) {
      if (line.length > 2 * 1024 * 1024) throw new Error('单行数据超过 2 MiB');
      yield line;
    }
  } finally {
    // readline.close() 只暂停输入；提前结束时也必须关闭底层文件描述符。
    // 读取异常由迭代器传播，清理时不覆盖原始异常。
    const closed = finished(input, { cleanup: true }).catch(() => {});
    reader.close();
    input.destroy();
    await closed;
  }
}

export async function sha256File(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    checkCancelled(signal);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// 正向扫描只统计物理行和字节数；实际导入从文件尾部按块读取，不缓存整个文件。
export async function inspectArchiveFile(
  path: string,
  options: { hash?: boolean; signal?: AbortSignal } = {},
) {
  const hash = options.hash ? createHash('sha256') : null;
  let size = 0;
  let totalLines = 0;
  let previous: number | undefined;
  for await (const chunk of createReadStream(path)) {
    checkCancelled(options.signal);
    hash?.update(chunk);
    size += chunk.length;
    for (const byte of chunk as Buffer) {
      if (byte === 13 || (byte === 10 && previous !== 13)) totalLines++;
      previous = byte;
    }
  }
  if (size > 0 && previous !== 10 && previous !== 13) totalLines++;
  return { size, totalLines, sha256: hash?.digest('hex') ?? null };
}

export async function* reverseArchiveLines(
  path: string,
  options: { endOffset?: number; chunkSize?: number } = {},
) {
  const chunkSize = options.chunkSize ?? 64 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('读取块大小必须为正整数');
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const endOffset = options.endOffset ?? size;
    if (!Number.isSafeInteger(endOffset) || endOffset < 0 || endOffset > size)
      throw new Error('Archive 检查点字节位置超出文件范围');
    let position = endOffset;
    let skipCR = false;
    let parts: Buffer[] = [];
    let length = 0;
    const append = (part: Buffer) => {
      if (!part.length) return;
      length += part.length;
      // UTF-8 每个 UTF-16 码元最多 3 字节，兼容正向读取器的字符长度限制。
      if (length > 3 * 2 * 1024 * 1024) throw new Error('单行数据超过 2 MiB');
      parts.push(part);
    };
    const takeLine = () => {
      const line = Buffer.concat(parts.reverse(), length).toString('utf8');
      parts = [];
      length = 0;
      if (line.length > 2 * 1024 * 1024) throw new Error('单行数据超过 2 MiB');
      return line;
    };
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const buffer = Buffer.allocUnsafe(position - start);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
        if (!bytesRead) throw new Error('Archive 文件在读取期间发生变化');
        read += bytesRead;
      }
      position = start;
      let segmentEnd = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const byte = buffer[i];
        if (skipCR) {
          skipCR = false;
          if (byte === 13) {
            segmentEnd = i;
            continue;
          }
        }
        if (byte !== 10 && byte !== 13) continue;
        append(buffer.subarray(i + 1, segmentEnd));
        // 与 readline 一致：末尾的换行符结束上一行，不额外产生一个空行。
        if (start + i !== endOffset - 1) yield { line: takeLine(), offset: start + i + 1 };
        segmentEnd = i;
        skipCR = byte === 10;
      }
      append(buffer.subarray(0, segmentEnd));
    }
    if (endOffset > 0) yield { line: takeLine(), offset: 0 };
  } finally {
    // 到达批次上限、取消或解析失败时也关闭句柄。
    await file.close();
  }
}

export async function extractSubjects(zipPath: string, output: string, signal?: AbortSignal) {
  await mkdir(dirname(output), { recursive: true });
  const file = await open(`${output}.partial`, 'w');
  let found = false;
  let complete = false;
  let failure: Error | null = null;
  let buffers: Uint8Array[] = [];
  const unzip = new Unzip((entry) => {
    if (entry.name !== 'subject.jsonlines') return;
    if (found) {
      failure = new Error('Archive 包含重复 subject.jsonlines');
      return;
    }
    found = true;
    entry.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      if (data.length) buffers.push(data);
      if (final) complete = true;
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(zipPath, { highWaterMark: 64 * 1024 })) {
      checkCancelled(signal);
      unzip.push(new Uint8Array(chunk), false);
      if (failure) throw failure;
      for (const buffer of buffers) await file.writeFile(buffer);
      buffers = [];
    }
    unzip.push(new Uint8Array(), true);
    if (failure) throw failure;
    for (const buffer of buffers) await file.writeFile(buffer);
    if (!found || !complete) throw new Error('Archive 缺少完整的 subject.jsonlines');
  } finally {
    await file.close();
  }
  await rename(`${output}.partial`, output);
}

export async function downloadArchive(
  output: string,
  onProgress?: (progress: Record<string, unknown>) => void,
  signal?: AbortSignal,
) {
  onProgress?.({ phase: 'archive_manifest', output });
  const response = await fetch(
    'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json',
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw new Error(`Archive 清单读取失败：${response.status}`);
  const manifest = z
    .object({
      browser_download_url: z.url(),
      created_at: z.iso.datetime(),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .parse(await response.json());
  onProgress?.({ phase: 'archive_download', output, downloadedBytes: 0 });
  const archive = await fetch(manifest.browser_download_url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)])
      : AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!archive.ok || !archive.body) throw new Error(`Archive 下载失败：${archive.status}`);
  await mkdir(dirname(output), { recursive: true });
  const hash = createHash('sha256');
  let downloadedBytes = 0;
  const totalBytes = Number(archive.headers.get('content-length')) || null;
  await pipeline(
    Readable.fromWeb(
      archive.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
    ),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        downloadedBytes += chunk.length;
        onProgress?.({ phase: 'archive_download', output, downloadedBytes, totalBytes });
        callback(null, chunk);
      },
    }),
    createWriteStream(`${output}.zip.partial`),
    { signal },
  );
  if (`sha256:${hash.digest('hex')}` !== manifest.digest)
    throw new Error('Archive SHA-256 校验失败');
  await rename(`${output}.zip.partial`, `${output}.zip`);
  onProgress?.({ phase: 'archive_extract', output, downloadedBytes });
  await extractSubjects(`${output}.zip`, output, signal);
  onProgress?.({ phase: 'archive_hash', output });
  await writeFile(
    `${output}.meta.json`,
    JSON.stringify(
      {
        dataAsOf: manifest.created_at,
        source: manifest.browser_download_url,
        sha256: await sha256File(output),
      },
      null,
      2,
    ),
  );
  return { output, dataAsOf: manifest.created_at };
}
