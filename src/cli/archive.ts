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
