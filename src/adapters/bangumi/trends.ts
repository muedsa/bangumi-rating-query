import { DomUtils, parseDocument } from 'htmlparser2';
import { trendsSnapshotSchema, type TrendsSnapshot } from '../../core/trends.ts';

export const TRENDS_URL = 'https://bgm.tv/anime/browser/?sort=trends&page=1';
export const TRENDS_LIST_ID = 'browserItemList';
export const MAX_TRENDS_HTML_BYTES = 2 * 1024 * 1024;

/** 浏览器已把完整 DOM 放在内存中，仍需限制实际 UTF-8 字节数。 */
export function assertTrendsHtmlSize(html: string): void {
  if (new TextEncoder().encode(html).byteLength > MAX_TRENDS_HTML_BYTES)
    throw new Error('Bangumi 热度页面超过 2 MiB');
}

/** 仅识别浏览列表中的条目，不采集侧栏、推荐、脚本或评论里的链接。 */
export function fromTrendsHtml(html: string, now = Date.now()): TrendsSnapshot {
  const document = parseDocument(html);
  const list = DomUtils.getElementById(TRENDS_LIST_ID, document.children);
  if (!list || list.name !== 'ul')
    throw new Error('Bangumi 热度页面缺少 browserItemList，可能返回验证页或页面结构已变化');
  const ids: number[] = [];
  for (const item of DomUtils.getElementsByTagName('li', list.children, false)) {
    const match = /^item_([1-9]\d*)$/u.exec(item.attribs.id ?? '');
    if (!match) throw new Error('Bangumi 热度列表条目 ID 无效');
    const id = Number(match[1]);
    const heading = DomUtils.getElementsByTagName('h3', item.children)[0];
    const links = heading ? DomUtils.getElementsByTagName('a', heading.children) : [];
    const valid = links.some((link) => {
      try {
        const url = new URL(link.attribs.href ?? '', TRENDS_URL);
        return url.origin === 'https://bgm.tv' && url.pathname === `/subject/${id}`;
      } catch {
        return false;
      }
    });
    if (!Number.isSafeInteger(id) || !valid)
      throw new Error('Bangumi 热度列表标题链接与条目 ID 不一致');
    ids.push(id);
  }
  // 空列表不能视为同步成功，以免验证页、登录页或结构变化被悄悄忽略。
  return trendsSnapshotSchema.parse({ subjectIds: [...new Set(ids)], fetchedAt: now });
}

export async function readTrendsHtml(response: Response): Promise<string> {
  if (!/^text\/html(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Bangumi 热度页面未返回 HTML');
  }
  if (Number(response.headers.get('Content-Length')) > MAX_TRENDS_HTML_BYTES) {
    await response.body?.cancel();
    throw new Error('Bangumi 热度页面超过 2 MiB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Bangumi 热度页面为空');
  const decoder = new TextDecoder();
  let size = 0;
  let html = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TRENDS_HTML_BYTES) {
        await reader.cancel();
        throw new Error('Bangumi 热度页面超过 2 MiB');
      }
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
