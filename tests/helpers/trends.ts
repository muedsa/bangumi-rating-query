/** 只保留 Bangumi browser 页的相关结构；包含封面、标题、侧栏和重复链接。 */
export function trendsHtml(ids: number[] = [100, 201, 200, 202]) {
  return `<!doctype html><html><head><title>浏览全部动画 | Bangumi 番组计划</title></head><body>
    <aside><a href="/subject/999">侧栏条目</a></aside>
    <ul id="browserItemList" class="browserFull">${ids
      .map(
        (id, index) => `
      <li id="item_${id}" class="item ${index % 2 ? 'even' : 'odd'} clearit">
        <a href="/subject/${id}" class="subjectCover cover ll"><img src="/cover.jpg"></a>
        <div class="inner"><h3><a href="/subject/${id}" class="l">动画 ${id}</a>
          <small class="grey">中文名称</small></h3>
          <p class="info tip">12话 / 2026年10月</p>
          <p class="rateInfo"><small class="fade">9.9</small></p>
        </div>
      </li>`,
      )
      .join('')}</ul>
    <div class="page_inner"><a href="?sort=trends&amp;page=2">2</a></div>
    <script>const unrelated = '<a href="/subject/888">忽略</a>';</script>
  </body></html>`;
}

export function trendsResponse(ids?: number[]) {
  return new Response(trendsHtml(ids), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
