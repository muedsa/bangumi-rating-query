import { expect, test } from 'bun:test';
import { backupSchema } from '../../src/core/backup.ts';
import { backupFixture } from '../helpers/backup.ts';

test('备份拒绝同条目中重复别名 ID、名称与来源、统计日期', () => {
  const id = backupFixture(1);
  id.aliases[1]!.id = id.aliases[0]!.id;
  expect(() => backupSchema.parse(id)).toThrow('重复别名 ID');
  const name = backupFixture(1);
  name.aliases.push({ ...name.aliases[0]!, id: 'another' });
  expect(() => backupSchema.parse(name)).toThrow('重复名称与来源');
  const day = backupFixture(1);
  day.daily.push({ ...day.daily[0]! });
  expect(() => backupSchema.parse(day)).toThrow('重复日期');
  const valid = backupFixture(1);
  valid.aliases[1]!.name = valid.aliases[0]!.name;
  valid.aliases[1]!.normalizedName = valid.aliases[0]!.normalizedName;
  expect(backupSchema.safeParse(valid).success).toBe(true);
});
