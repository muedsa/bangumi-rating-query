export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function extractSubjectId(text: string): number | null {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !['bgm.tv', 'bangumi.tv', 'chii.in'].includes(url.hostname)
    )
      return null;
    const match = /^\/subject\/([1-9]\d*)\/?$/u.exec(url.pathname);
    const id = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}
