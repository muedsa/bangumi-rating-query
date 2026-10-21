const digits = '零一二三四五六七八九';
const units = [
  ['兆', 1e12],
  ['亿', 1e8],
  ['万', 1e4],
  ['千', 1000],
  ['百', 100],
  ['十', 10],
] as const;

function chineseNumber(value: number, omitOneTen = true): string {
  if (value < 10) return digits[value]!;
  for (const [unit, size] of units) {
    if (value < size) continue;
    const high = Math.floor(value / size);
    const low = value % size;
    const prefix = size === 10 && high === 1 && omitOneTen ? '' : chineseNumber(high);
    return prefix + unit + (low ? (low < size / 10 ? '零' : '') + chineseNumber(low, false) : '');
  }
  return '';
}

function parseChinese(value: string): number {
  for (const [unit, size] of units) {
    const index = value.indexOf(unit);
    if (index === -1) continue;
    const high = value.slice(0, index);
    const low = value.slice(index + 1).replace(/^零/u, '');
    return (high ? parseChinese(high) : 1) * size + (low ? parseChinese(low) : 0);
  }
  return value.length === 1 ? digits.indexOf(value) : NaN;
}

/** 只识别名称末尾的“第 N 季”；保留标题和季数前的空格。 */
export function seasonAlias(name: string) {
  const match = /^(.*)第([0-9０-９]+|[零〇一二两三四五六七八九十百千万亿兆]+)季$/u.exec(
    name.trim(),
  );
  if (!match || !match[1]!.trim()) return null;
  const prefix = match[1]!;
  const raw = match[2]!.normalize('NFKC').replaceAll('两', '二').replaceAll('〇', '零');
  const arabic = /^\d+$/u.test(raw);
  const number = arabic ? Number(raw) : parseChinese(raw);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const chinese = chineseNumber(number);
  // 拒绝“十十”“一二”等非规范数字，避免猜测季数。
  if (!arabic && raw !== chinese) return null;
  return {
    prefix,
    base: prefix.trim(),
    number,
    counterpart: `${prefix}第${arabic ? chinese : number}季`,
    firstNames: [`${prefix}第一季`, `${prefix}第1季`],
  };
}

export function seasonAliasNames(name: string): string[] {
  const season = seasonAlias(name);
  return season ? [...new Set([name, season.counterpart])] : [name];
}
