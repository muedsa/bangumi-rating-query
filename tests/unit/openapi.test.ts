import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createApp } from '../../src/http/app.ts';
import { readConfig } from '../../src/config.ts';
import type { ApplicationRepository } from '../../src/core/ports.ts';
import { getOpenApi } from '../../src/http/openapi.ts';
import { apiErrors } from '../../src/http/openapi-errors.ts';
import { batchSchema, importSchema } from '../../src/core/models.ts';
import { backupSchema } from '../../src/core/backup.ts';
import { backupExample, subjectExample, ratingExample } from '../../src/http/openapi-examples.ts';
import { assertSchema, document, resolveRef, validator } from '../helpers/openapi.ts';

test('OpenAPI 覆盖所有实际路由，路径参数、operationId、鉴权与接口文档保持一致', () => {
  const app = createApp({} as ApplicationRepository, readConfig({}));
  const actual = app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path.replace(/:([^/]+)/gu, '{$1}')}`)
    .sort();
  const documented: string[] = [];
  const ids = new Set<string>();
  const markdown = readFileSync('docs/api.md', 'utf8');
  for (const [path, pathItem] of Object.entries(document.paths)) {
    expect(markdown).toContain(path);
    for (const [method, operation] of Object.entries(pathItem as any) as [string, any][]) {
      documented.push(`${method.toUpperCase()} ${path}`);
      expect(operation.summary.length).toBeGreaterThan(0);
      expect(operation.description.length).toBeGreaterThan(0);
      expect(ids.has(operation.operationId)).toBe(false);
      ids.add(operation.operationId);
      expect(document.tags.some((tag: any) => operation.tags.includes(tag.name))).toBe(true);
      expect(operation.security).toEqual(
        path.startsWith('/api/v1/admin/') ? [{ bearerAuth: [] }] : [],
      );
      const names = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
      expect(
        (operation.parameters ?? [])
          .filter((p: any) => p.in === 'path')
          .map((p: any) => p.name)
          .sort(),
      ).toEqual(names.sort());
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === 'path') expect(parameter.required).toBe(true);
        expect(parameter.description.length).toBeGreaterThan(0);
        assertSchema(document, parameter.schema, parameter.example, `${path} ${parameter.name}`);
      }
    }
  }
  expect(documented.sort()).toEqual(actual);
  for (const code of Object.keys(apiErrors)) expect(markdown).toContain(`\`${code}\``);
});

test('OpenAPI 所有引用可解析，所有请求、成功及错误示例满足公开 JSON Schema', () => {
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) resolveRef(document, node.$ref);
    for (const value of Object.values(node)) visit(value);
  };
  visit(document);
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem as any) as [string, any][]) {
      const checkExamples = (media: any, context: string) => {
        expect(Object.keys(media.examples).length).toBeGreaterThan(0);
        for (const [name, example] of Object.entries(media.examples) as [string, any][])
          assertSchema(document, media.schema, example.value, `${context} ${name}`);
      };
      if (operation.requestBody)
        checkExamples(operation.requestBody.content['application/json'], `${method} ${path} 请求`);
      for (const [status, response] of Object.entries(operation.responses) as [string, any][]) {
        expect(response.headers['X-Request-ID'].schema.format).toBe('uuid');
        checkExamples(response.content['application/json'], `${method} ${path} ${status}`);
        if (Number(status) >= 400) {
          for (const code of Object.keys(response.content['application/json'].examples))
            expect(Number(status)).toBe(apiErrors[code as keyof typeof apiErrors].status);
        }
      }
    }
  }
});

test('OpenAPI 请求默认值不强制必填，输出字段完整，动态批量上限和查找方式确实生效', () => {
  const schemas = document.components.schemas;
  expect(schemas.SearchRequest.required).toEqual(['keyword']);
  expect(schemas.PruneRequest.required ?? []).toEqual([]);
  expect(schemas.ImportRequest.properties.subject.required.sort()).toEqual(
    ['id', 'name', 'metadataAt', 'cachedAt'].sort(),
  );
  expect(schemas.Subject.required.sort()).toEqual(Object.keys(schemas.Subject.properties).sort());
  expect(validator(document, schemas.PruneRequest).safeParse({}).success).toBe(true);
  expect(validator(document, schemas.SearchRequest).safeParse({ keyword: '动画' }).success).toBe(
    true,
  );
  const minimal = {
    subject: { id: 100, name: '动画', metadataAt: 0, cachedAt: 0 },
    aliases: [],
    rating: null,
  };
  expect(validator(document, schemas.ImportRequest).safeParse(minimal).success).toBe(true);
  expect(importSchema.safeParse(minimal).success).toBe(true);
  expect(validator(document, schemas.Subject).safeParse(minimal.subject).success).toBe(false);
  for (const limit of [1, 20]) {
    const doc = JSON.parse(JSON.stringify(getOpenApi(limit)));
    const request = validator(doc, doc.components.schemas.BatchRequest);
    const items = Array.from({ length: limit }, (_, i) => ({
      inputId: String(i),
      subjectId: i + 1,
    }));
    expect(request.safeParse({ items }).success).toBe(true);
    expect(
      request.safeParse({ items: [...items, { inputId: 'extra', subjectId: 123 }] }).success,
    ).toBe(false);
    for (const item of [
      { inputId: 'a' },
      { subjectId: 1 },
      { inputId: 'a', names: [] },
      { inputId: 'a', subjectId: 0 },
    ])
      expect(request.safeParse({ items: [item] }).success).toBe(false);
    expect(request.safeParse({ items: [{ inputId: 'a', names: ['动画'] }] }).success).toBe(true);
    expect(doc.components.schemas.BatchResponse.properties.results.maxItems).toBe(limit);
  }
});

test('文档无法完整表达的跨字段规则仍由业务模型拒绝', () => {
  expect(
    batchSchema.safeParse({
      items: [
        { inputId: 'a', subjectId: 1 },
        { inputId: 'a', subjectId: 2 },
      ],
    }).success,
  ).toBe(false);
  expect(
    importSchema.safeParse({
      subject: subjectExample,
      aliases: [],
      rating: { ...ratingExample, subjectId: 101 },
    }).success,
  ).toBe(false);
  expect(
    backupSchema.safeParse({
      ...backupExample,
      aliases: [{ ...backupExample.aliases[0], normalizedName: '错误检索键' }],
    }).success,
  ).toBe(false);
  expect(
    backupSchema.safeParse({
      ...backupExample,
      daily: [...backupExample.daily, ...backupExample.daily],
    }).success,
  ).toBe(false);
});
