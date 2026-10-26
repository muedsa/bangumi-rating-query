/** 面向调用方的错误目录；示例消息不是固定匹配契约。 */
export const apiErrors = {
  INVALID_INPUT: {
    status: 400,
    message: '参数无效',
    description: '字段类型、取值范围、必填项或跨字段约束不满足；issues 给出路径与说明。',
  },
  INVALID_JSON: {
    status: 400,
    message: '请求体不是有效 JSON',
    description: 'JSON 缺失或语法无效；需要 JSON 的接口即使全部字段有默认值也应发送 {}。',
  },
  BATCH_TOO_LARGE: {
    status: 400,
    message: '每批最多 20 条',
    description: 'items 超过部署的 MAX_BATCH_SIZE；基础校验超过 50 条时可能先返回 INVALID_INPUT。',
  },
  TOO_MANY_CANDIDATES: {
    status: 400,
    message: '候选过多，请缩小批次或使用条目 ID',
    description: '名称查找涉及超过 1000 个别名记录，拒绝自动判定；请缩小范围或使用 subjectId。',
  },
  ALIAS_LIMIT: {
    status: 400,
    message: '补充季数别名后超过单条目 250 条上限，请先整理别名',
    description: '新增和季数推断会超过单条目的别名容量；本次别名写入不提交。',
  },
  ALIAS_TOO_LONG: {
    status: 400,
    message: '季数转换后的别名超过 300 字符',
    description: '季数补全产生的名称过长；请缩短输入名称。',
  },
  BACKUP_TOO_LARGE: {
    status: 400,
    message: '单条备份超出事务预算，请先归档历史统计',
    description: '备份恢复超过单条事务预算；不写入该条目。',
  },
  UNAUTHORIZED: {
    status: 401,
    message: '管理凭证无效',
    description: '缺少或错误的 ADMIN_TOKEN；客户端使用 Authorization: Bearer <ADMIN_TOKEN>。',
  },
  NOT_FOUND: {
    status: 404,
    message: '接口不存在',
    description: '路径或 HTTP 方法未匹配；此服务未单独返回 405。',
  },
  SUBJECT_NOT_FOUND: {
    status: 404,
    message: '条目未收录',
    description: '本地库没有该条目；可先同步或导入。添加别名时消息为“请先导入该条目”。',
  },
  ALIAS_NOT_FOUND: {
    status: 404,
    message: '手动别名不存在',
    description: '别名 ID 不存在，或该记录为 bangumi 来源，不能通过手动接口修改或删除。',
  },
  ALIAS_MISS_NOT_FOUND: {
    status: 404,
    message: '未命中别名记录不存在',
    description: '未命中记录不存在或已因补充别名被清理。',
  },
  ALIAS_EXISTS: {
    status: 409,
    message: '该条目已有相同别名',
    description: '修改手动别名与该条目任意来源的另一个名称冲突；原记录保留。',
  },
  SUBJECT_EXISTS: {
    status: 409,
    message: '恢复目标已存在该条目；请使用空库',
    description: '恢复不能覆盖已存在条目；更新应使用 import 或 sync。',
  },
  BODY_TOO_LARGE: {
    status: 413,
    message: '请求体不能超过 256 KiB',
    description: '请求体超过 262144 字节；校验作用于全部路由，并先于管理鉴权。',
  },
  ADMIN_DISABLED: {
    status: 503,
    message: '管理接口未启用',
    description: '服务端未配置 ADMIN_TOKEN。',
  },
  NOT_READY: {
    status: 503,
    message: '数据库迁移未完成',
    description: '数据库 schema 版本与服务不匹配；缺表或连接故障也可能返回 SERVICE_UNAVAILABLE。',
  },
  BANGUMI_SEARCH_DISABLED: {
    status: 503,
    message: '请在服务端配置 BANGUMI_USER_AGENT 以启用搜索',
    description: '未配置上游搜索服务。',
  },
  BANGUMI_SYNC_DISABLED: {
    status: 503,
    message: '请在服务端配置 BANGUMI_USER_AGENT 以启用同步',
    description: '未配置上游条目或日历同步服务。',
  },
  BANGUMI_API_ERROR: {
    status: 503,
    message: 'Bangumi 数据获取失败，请检查服务端认证配置或稍后重试',
    description:
      '上游鉴权、限流、网络、非动画或响应校验失败；本服务统一返回 503，不透传上游状态或响应正文。',
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: '服务暂不可用，请稍后重试',
    description:
      '存储或未预期的内部故障；使用 X-Request-ID 查服务端日志。失败响应不保证之前的独立写入均未发生。',
  },
  CONFIGURATION_ERROR: {
    status: 503,
    message: '服务配置无效',
    description: 'Worker 初始化或配置失败；Node 初始化失败通常直接退出，不提供 HTTP 响应。',
  },
} as const;
export type ApiErrorCode = keyof typeof apiErrors;
