import { expect, test } from 'bun:test';
import { seasonAlias, seasonAliasNames } from '../../src/core/season-aliases.ts';

test('末尾季数的阿拉伯数字与中文数字互补，保留标题与分隔空格', () => {
  for (const [arabic, chinese] of [
    ['1', '一'],
    ['2', '二'],
    ['10', '十'],
    ['12', '十二'],
    ['20', '二十'],
    ['101', '一百零一'],
    ['110', '一百一十'],
    ['111', '一百一十一'],
    ['1001', '一千零一'],
    ['10010', '一万零一十'],
    ['100000', '十万'],
    ['100000001', '一亿零一'],
    ['1000000000000', '一兆'],
  ]) {
    expect(seasonAliasNames(`动画 第${arabic}季`)).toEqual([
      `动画 第${arabic}季`,
      `动画 第${chinese}季`,
    ]);
    expect(seasonAliasNames(`动画 第${chinese}季`)).toEqual([
      `动画 第${chinese}季`,
      `动画 第${arabic}季`,
    ]);
  }
  expect(seasonAlias('动画第２季')).toMatchObject({ number: 2, counterpart: '动画第二季' });
  expect(seasonAlias('动画第两季')).toMatchObject({ number: 2, counterpart: '动画第2季' });
  expect(seasonAlias(' 动画 第二季 ')).toMatchObject({
    base: '动画',
    firstNames: ['动画 第一季', '动画 第1季'],
  });
});

test('季数转换往返保持数值，不混淆不同季', () => {
  for (const number of [
    ...Array.from({ length: 2000 }, (_, i) => i + 1),
    101010,
    100100001,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const alias = seasonAlias(`动画第${number}季`)!;
    expect(seasonAlias(alias.counterpart)?.number).toBe(number);
  }
});

test('只处理明确的正整数季数后缀，不修改篇名、罗马数字或畸形数字', () => {
  for (const name of [
    '动画第二季 特别篇',
    '动画 Season 2',
    '动画第II季',
    '动画第0季',
    '动画第零季',
    '动画第-1季',
    '动画第1.5季',
    '动画第十十季',
    '动画第一二季',
    '动画第9007199254740992季',
    '第二季',
    '动画',
  ]) {
    expect(seasonAlias(name)).toBeNull();
    expect(seasonAliasNames(name)).toEqual([name]);
  }
});
