# API v1

基础路径 `/api/v1`。JSON 请求和响应；文件上传使用 multipart。业务错误 `{ "message": "中文原因", "requestId": "…" }`。常用状态：400 输入无效，401 未登录，403 无权限，404 不存在或未公开，409 状态冲突／额度用尽，413 文件超限，429 限流，503 并发容量不足。

用户名密码认证使用 `lark_session` Cookie，HttpOnly、SameSite=Lax、Path=/，HTTPS 配置时启用 Secure，作用域限定主站主机。数据库保存会话凭证摘要；默认最长 7 天、闲置 24 小时过期。所有 POST/PUT/PATCH/DELETE 请求须携带与 `APP_ORIGIN` 完全一致的 Origin。前端同源访问 `/api`。个人接口和认证响应使用 no-store。

## 公开与身份

| 方法 | 路径             | 说明                                                                                 |
| ---- | ---------------- | ------------------------------------------------------------------------------------ |
| GET  | `/health`        | 数据库与缓存可用性                                                                   |
| GET  | `/competition`   | 赛事内容、统一提示词、赛程、当前生效额度和服务器时间                                 |
| GET  | `/stats`         | 公开作品数、有效票数、参赛作者数                                                     |
| GET  | `/auth/me`       | `{user}`，未登录为 null                                                              |
| POST | `/auth/register` | `{username,name,password}`；创建参赛账号，返回 `{user}` 并建立会话                   |
| POST | `/auth/login`    | `{username,password}`；返回 `{user}` 并建立独立会话                                  |
| POST | `/auth/logout`   | 撤销当前会话，清除 Cookie，返回 `{ok:true}`                                          |
| POST | `/auth/password` | `{currentPassword,newPassword}`；修改密码，撤销全部会话，返回 `{ok:true}` 后重新登录 |
| GET  | `/works`         | `page=1&size=12&sort=recommended&q=关键词`；sort 支持 recommended/latest/votes       |
| GET  | `/works/:id`     | 详情；含可用时的 previewUrl；非公开作品仅本人和管理员可读                            |
| GET  | `/leaderboard`   | `page,size`；返回同票同名次、更新时间                                                |

列表统一返回 `{items,total,pages}`，页大小最大 48。作品字段包含 `id,number,title,description,model,prompt,status,version,coverId,htmlId,coverUrl,coverMode,coverStatus,votes,recommended`。评选结束前公开接口不返回作者 ID。

## 认证约定

- 用户名 3～32 位英文字母、数字、下划线或短横线，去除两端空白并转为小写后判重；显示姓名 1～40 个字符，允许重复。
- 密码 8～128 个 Unicode 字符，按原始输入校验。注册和登录请求采用严格字段校验；用户 ID 和角色由服务器提供。
- 重复用户名返回 409；错误用户名或密码统一返回 401。已停用账号凭正确密码登录返回 403。
- 每分钟登录 IP 上限 60、账号上限 10；注册 IP 上限 10；密码计算最多同时执行 2 次。429/503 携带 Retry-After，可通过环境变量调整限流参数。
- 前端个人请求、退出和修改密码携带 `X-Lark-User: 当前用户ID`。服务器校验其与会话身份一致，身份变化时返回 409 和 `code: "AUTH_CHANGED"`，客户端重新读取 `/auth/me` 后再操作。需登录的请求在会话过期时返回 401 和 `code: "AUTH_EXPIRED"`；修改密码时输入错误的当前密码返回普通 401，页面保留当前登录状态。
- 同账号多设备会话独立；重新登录会轮换当前浏览器会话。退出后，重放旧 Cookie 也需重新登录。
- 企业身份映射使用 `(provider,subject)` 唯一键关联稳定用户 ID。SSO 接入时先验证提供方身份凭证，再查询映射并通过 `createSessionStore.establish` 建立会话；身份绑定由经过认证的服务端流程完成。

## 参赛与投票

| 方法 | 路径                  | 说明                                                                        |
| ---- | --------------------- | --------------------------------------------------------------------------- |
| POST | `/uploads`            | multipart 单个 file，HTML 或封面，返回 `{id,kind,bytes,autoCover?}`         |
| POST | `/works`              | 创建草稿                                                                    |
| PUT  | `/works/:id`          | 编辑；必须携带最新 version，公开作品编辑后保持 approved，草稿编辑后为 draft |
| POST | `/works/:id/submit`   | 需 HTML，补齐自动封面，draft/withdrawn → approved；重复发布幂等             |
| POST | `/works/:id/withdraw` | 本人撤回，已有票数保留                                                      |
| GET  | `/me/works`           | 本人作品和管理反馈                                                          |
| GET  | `/me/quota`           | 当日额度 limit、已使用票数 classic（历史内部字段名）、已投作品 votedIds     |
| POST | `/works/:id/votes`    | 必填请求头 `Idempotency-Key: UUID`，无请求体                                |

创建和编辑请求：

```json
{
  "title": "林间来信",
  "description": "一只飞行中唱歌的百灵鸟",
  "model": "使用的模型名称",
  "prompt": "页面提供的固定提示词",
  "coverId": null,
  "htmlId": null,
  "version": 1
}
```

`version` 仅编辑必填。服务端始终使用赛事固定提示词，客户端不能覆盖。`track` 可省略；仅接受内部历史键 `classic`。介绍、模型可省略或为空字符串，服务端统一保存为空字符串。`coverId` 可省略或为 null，提供 HTML 时补齐自动封面；`coverMode` 可选 auto/manual，自动封面随 HTML 更新、手动封面保留。草稿可暂缺文件，正式发布需 HTML。作品发布后直接公开，公开作品编辑后继续展示。现有待审核作品迁移为公开，历史退回作品迁移为草稿。

投票返回 `{id,repeated}`。同一用户同一幂等键重试返回原记录；同一键用于其他作品返回 409。记录唯一约束还禁止同一用户同一天对同一作品重复投票。作废票不释放额度，也不允许重新投同一作品。

HTML 上传返回 `autoCover: {id,url,status}`，status 为 pending/ready/fallback，初始占位封面可直接用于投稿。

pending 包括排队、截图及暂时不可用时的退避重试；ready 表示截图完成；同一内容连续 3 次渲染失败后进入 fallback，作者可重新生成或上传图片。

- `GET /uploads/:htmlId/cover`：查询本人上传 HTML 的自动封面，其他用户返回 404；前端 pending 状态每 2 秒查询。
- `POST /uploads/:htmlId/cover/retry`：本人重新生成，按用户每分钟最多 10 次。旧 HTML 首次切换自动封面时创建生成任务。
- 作品响应包含 `coverMode`（auto/manual）、`coverStatus` 和带修订号的 `coverUrl`；自动补图保留封面 ID，URL 随图片修订更新。

## 管理员

| 方法  | 路径                    | 请求／行为                                          |
| ----- | ----------------------- | --------------------------------------------------- |
| GET   | `/admin/overview`       | 数量统计、动态请求和上传占用、进程内存和 CPU 累计值 |
| GET   | `/admin/works`          | `status=all/approved/draft/withdrawn` 与分页        |
| PATCH | `/admin/works/:id`      | `{recommended}` 或 `{withdraw:true,reason}`         |
| PUT   | `/admin/competition`    | 完整赛事设置；dailyLimit 次日生效                   |
| GET   | `/admin/users`          | 用户列表与分页                                      |
| PATCH | `/admin/users/:id`      | `{status:active/disabled}`                          |
| GET   | `/admin/votes`          | 投票明细与分页                                      |
| POST  | `/admin/votes/:id/void` | `{reason}`，不可重复作废                            |
| GET   | `/admin/audit`          | 管理员操作审计与分页                                |
| GET   | `/admin/export/works`   | 流式 CSV 导出报名数据                               |
| GET   | `/admin/export/votes`   | 流式 CSV 导出票据                                   |

所有管理接口经数据库角色检查。管理员通过服务器交互命令创建。用户列表同时返回 `username` 和稳定的用户 `id`；停用用户会撤销其全部会话，重新启用后需重新登录。

## 文件与隔离预览

主站 `/media/:uuid` 仅输出经过处理的封面图片。HTML 只从独立预览服务 `/preview/:uuid` 输出。公开作品无需登录，未公开作品使用从详情接口获取的 5 分钟签名链接。生产多实例时设置一致的 `PREVIEW_SECRET`。

上传按身份 10 次／分钟，投票 20 次／分钟，API 按 IP 240 次／分钟。动态接口和预览共享 32 个在途请求上限，上传最多 2 个。429／503 应等待后重试；不要无限立即重试。
