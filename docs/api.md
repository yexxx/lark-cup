# API v1

基础路径 `/api/v1`。JSON 请求和响应；文件上传使用 multipart。业务错误 `{ "message": "中文原因", "requestId": "…" }`。常用状态：400 输入无效，401 未登录，403 无权限，404 不存在或未公开，409 状态冲突／额度用尽，413 文件超限，429 限流，503 并发容量不足。

开发环境登录为演示身份，Cookie 名称 `lark_demo`，HttpOnly、SameSite=Lax，HTTPS 配置时启用 Secure。前端同源访问 `/api`，不使用跨域宽泛放行。

## 公开与身份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 数据库与缓存可用性 |
| GET | `/competition` | 赛事内容、统一提示词、赛程、当前生效额度和服务器时间 |
| GET | `/stats` | 公开作品数、有效票数、参赛作者数 |
| GET | `/auth/me` | `{user}`，未登录为 null |
| POST | `/auth/login` | `{id,name}`；当前为演示身份适配器 |
| POST | `/auth/logout` | 清除身份 Cookie |
| GET | `/works` | `page=1&size=12&sort=recommended&q=关键词`；sort 支持 recommended/latest/votes |
| GET | `/works/:id` | 详情；含可用时的 previewUrl；非公开作品仅本人和管理员可读 |
| GET | `/leaderboard` | `page,size`；返回同票同名次、更新时间 |

列表统一返回 `{items,total,pages}`，页大小最大 48。作品字段包含 `id,number,title,description,model,prompt,status,version,coverId,htmlId,coverUrl,votes,recommended`。评选结束前公开接口不返回作者 ID。

## 参赛与投票

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/uploads` | multipart 单个 file，HTML 或封面，返回 `{id,kind,bytes}` |
| POST | `/works` | 创建草稿 |
| PUT | `/works/:id` | 编辑；必须携带最新 version，成功后变为 draft |
| POST | `/works/:id/submit` | 需封面和 HTML，draft/rejected/withdrawn → pending |
| POST | `/works/:id/withdraw` | 本人撤回，已有票数保留 |
| GET | `/me/works` | 本人作品和审核反馈 |
| GET | `/me/quota` | 当日额度 limit、已使用票数 classic（历史内部字段名）、已投作品 votedIds |
| POST | `/works/:id/votes` | 必填请求头 `Idempotency-Key: UUID`，无请求体 |

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

`version` 仅编辑必填。服务端始终使用赛事固定提示词，客户端不能覆盖。`track` 可省略；仅接受内部历史键 `classic`。草稿可暂缺文件，正式提交必须补齐。

投票返回 `{id,repeated}`。同一用户同一幂等键重试返回原记录；同一键用于其他作品返回 409。记录唯一约束还禁止同一用户同一天对同一作品重复投票。作废票不释放额度，也不允许重新投同一作品。

## 管理员

| 方法 | 路径 | 请求／行为 |
|---|---|---|
| GET | `/admin/overview` | 数量统计、动态请求和上传占用、进程内存和 CPU 累计值 |
| GET | `/admin/works` | `status=all/pending/approved/rejected/draft/withdrawn` 与分页 |
| POST | `/admin/works/:id/review` | `{decision:approved/rejected,reason,version}`；仅审核待审最新版本 |
| PATCH | `/admin/works/:id` | `{recommended}` 或 `{withdraw:true,reason}` |
| PUT | `/admin/competition` | 完整赛事设置；dailyLimit 次日生效 |
| GET | `/admin/users` | 用户列表与分页 |
| PATCH | `/admin/users/:id` | `{status:active/disabled}` |
| GET | `/admin/votes` | 投票明细与分页 |
| POST | `/admin/votes/:id/void` | `{reason}`，不可重复作废 |
| GET | `/admin/audit` | 管理员操作审计与分页 |
| GET | `/admin/export/works` | 流式 CSV 导出报名数据 |
| GET | `/admin/export/votes` | 流式 CSV 导出票据 |

所有管理接口经角色检查；当前角色由演示认证适配器提供。

## 文件与隔离预览

主站 `/media/:uuid` 仅输出经过处理的封面图片。HTML 只从独立预览服务 `/preview/:uuid` 输出。公开作品无需登录，未公开作品使用从详情接口获取的 5 分钟签名链接。生产多实例时设置一致的 `PREVIEW_SECRET`。

上传按身份 10 次／分钟，投票 20 次／分钟，API 按 IP 240 次／分钟。动态接口和预览共享 32 个在途请求上限，上传最多 2 个。429／503 应等待后重试；不要无限立即重试。
