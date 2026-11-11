/** 搜索结果仅保留热门同步实际使用的字段，顺序表示上游 heat 排序。 */
export function trendsSearchResult(ids: number[] = [100, 201, 200, 202]) {
  return { total: ids.length, data: ids.map((id) => ({ id, type: 2 })) };
}

export function trendsResponse(ids?: number[]) {
  return Response.json(trendsSearchResult(ids));
}
