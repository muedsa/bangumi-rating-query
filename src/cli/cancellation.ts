export class CliCancelled extends Error {
  constructor() {
    super('操作已取消；此前完成的写入已保留');
  }
}
export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new CliCancelled();
}
