import assert from 'node:assert/strict';
import { z } from 'zod';
import { getOpenApi } from '../../src/http/openapi.ts';

// 以 HTTP 序列化后的 JSON 为准，不依赖生成器的内部类型或 Zod 元数据。
export const document = JSON.parse(JSON.stringify(getOpenApi(20)));

export function resolveRef(doc: any, ref: string): any {
  assert(ref.startsWith('#/'), `不支持外部引用：${ref}`);
  const value = ref
    .slice(2)
    .split('/')
    .reduce(
      (node: any, key: string) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
      doc,
    );
  assert.notEqual(value, undefined, `悬空引用：${ref}`);
  return value;
}

function validationSchema(doc: any, schema: any): any {
  if (Array.isArray(schema)) return schema.map((item) => validationSchema(doc, item));
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) return validationSchema(doc, resolveRef(doc, schema.$ref));
  // JSON Schema 的 default 只作注释；移除后再转换，避免校验器补默认值掩盖响应漏字段。
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'default')
      .map(([key, value]) => [key, validationSchema(doc, value)]),
  );
}

export function validator(doc: any, schema: any) {
  return z.fromJSONSchema(validationSchema(doc, schema));
}

export function assertSchema(doc: any, schema: any, value: unknown, context: string) {
  const result = validator(doc, schema).safeParse(value);
  assert(result.success, `${context}: ${result.success ? '' : result.error.message}`);
}

export function findOperation(doc: any, path: string, method: string) {
  const pathname = path.split('?')[0]!;
  const template = Object.keys(doc.paths).find((template) => {
    const parts = template.split('/');
    const actual = pathname.split('/');
    return (
      parts.length === actual.length &&
      parts.every((part, index) =>
        /^\{.+\}$/u.test(part) ? Boolean(actual[index]) : part === actual[index],
      )
    );
  });
  const operation = template ? doc.paths[template]?.[method.toLowerCase()] : undefined;
  assert(operation, `${method} ${path} 未文档化`);
  return { operation, key: `${method.toUpperCase()} ${template}` };
}

export function assertResponse(doc: any, path: string, method: string, status: number, value: any) {
  const { operation, key } = findOperation(doc, path, method);
  const response = operation.responses[String(status)];
  assert(response, `${key}: 未声明 HTTP ${status}`);
  const media = response.content['application/json'];
  assertSchema(doc, media.schema, value, `${key} HTTP ${status}`);
  if (status >= 400)
    assert(media.examples[value.error.code], `${key}: 未声明错误 ${value.error.code}`);
  return key;
}
