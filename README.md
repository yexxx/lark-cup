# 百灵鸟杯

可自行部署的单赛道 AI 创作比赛：作品展示、报名、审核、每日投票、排行榜、管理后台。前端 React + TypeScript，后端 Fastify，生产环境 PostgreSQL + Redis + Nginx。

固定提示词：

> 创建一个 HTML，内容是用 SVG 绘制一只飞行中唱歌的百灵鸟的 2D 动画。

提交的是 **HTML 文件**，百灵鸟使用内嵌 SVG 绘制。首页自然风景允许使用图片；示例作品的主体是 SVG，封面从对应 SVG 生成，不用位图充当作品。

## 本地运行

需要 Node.js 24。无 Docker 时使用持久化 PGlite（嵌入式 PostgreSQL）和内存缓存，不会自动混入演示数据。

```sh
npm ci
npm run seed    # 可选：显式初始化 8 个 HTML + SVG 示例及示例票数
npm run dev
```

打开 http://localhost:5173。API 为 3001，隔离作品预览为 3002。本地数据在 `.local/`，不要让多个服务进程同时打开同一 PGlite 数据目录。需要重新执行迁移或 seed 时先停止开发服务。

```sh
npm run build      # TypeScript 检查及前端生产构建
npm test           # 独立临时数据库，串行运行
npm run test:load  # 只允许 localhost，依次 1 / 5 / 10 并发，每 worker 4 次请求
```

## 登录占位

按照需求，认证独立占位，**没有生产关闭报名或投票的开关**。页面可选择参赛者或管理员，并可输入不同演示身份。`admin` 为公开的演示管理员标识；目前不证明用户真实身份，也不具备真实账户的抗冒用能力。

- 后端替换 `server/auth.ts` 的 `AuthAdapter`，保留 `currentUser / login / logout` 合约。
- 前端替换 `src/auth.ts`；登录界面位于 `src/App.tsx`。
- 正式接入时，由认证服务决定不可伪造的用户 ID 与角色，使用服务端会话或经过校验的身份凭证。业务模块通过适配器读取身份，无须重写投票和审核流程。

## 已实现流程

- 固定提示词报名、HTML 与封面上传、草稿、提交审核、查看反馈、修改重审、撤回。
- 作品搜索、分页、精选／最新／高票排序，隔离域名交互预览，复制作品链接。
- 默认每日 10 票，同一作品每天 1 票，北京时间零点换日。服务端事务处理幂等、唯一性和额度并发扣减。
- 榜单同票同名次，缓存 15 秒；列表缓存 10 秒。投票后当前卡片立即显示成功，其他列表在缓存更新后展示新票数。
- 管理后台配置赛事、赛程和次日额度，审核作品、推荐和下架，启用停用用户，查看和作废投票，审计日志及 CSV 导出。
- HTML 最大 5MB；封面最大 2MB，JPEG/PNG/WebP。图片会校验真实格式并转为 WebP。HTML 检查实际 SVG 节点，拒绝 SVG 内嵌位图或 HTML；最终内容合规仍由审核判断，静态检查不是完整的反作弊系统。
- HTML 只存储，不在服务器执行。预览使用独立 origin、iframe sandbox 和 CSP；外部网络、父页面访问、弹窗及顶层导航受限。

部署、域名、HTTPS、资源上限、备份恢复和回滚见 [部署手册](docs/deployment.md)。接口见 [API 文档](docs/api.md)。

## 目录

```text
src/              前端页面、认证适配器、请求并发队列
server/           API、投票事务、认证占位、迁移、SVG 示例源码
tests/            业务、上传、隔离、限流测试
deploy/           Nginx HTTP / HTTPS 与 Compose 覆盖配置
docs/             部署、接口、设计与验证说明
```

`001_initial.sql` 保留最初数据模型，`002_single_track.sql` 迁移为单赛道并合并历史额度。内部 `classic` 只是历史数据库键，界面不显示赛道，也不能提交第二种赛道。
