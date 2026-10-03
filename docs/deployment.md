# 自建服务器部署（4 核 8GB）

## 首次启动

服务器安装 Docker Engine 和 Docker Compose v2。下面以 Linux 为例；不需要在宿主机安装 Node.js、PostgreSQL 或 Redis。

```sh
cp .env.example .env
# 编辑 .env，设置 POSTGRES_PASSWORD。推荐用 openssl rand -hex 24 生成 URL 安全密码。
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 api
```

默认主站 `http://服务器地址`，预览 `http://服务器地址:8081`。将 `.env` 的 `APP_ORIGIN` 和 `PREVIEW_ORIGIN` 改成用户浏览器实际访问的地址，不能保留 localhost，也不能包含结尾斜杠。两者必须是不同 origin。数据库、Redis、API 不公开映射端口，只有 Nginx 对外。

初始化迁移在 API 启动时执行，使用事务与 PostgreSQL advisory lock，重复启动不会重复执行。默认数据库为空，不会自动初始化比赛演示作品。

若确实需要演示数据，显式运行：

```sh
docker compose exec api npm run seed
```

这会创建／更新演示作者的 8 份作品及演示观众投票，不适合已有正式比赛的数据库。已有演示作品重复执行会更新源码与封面，保留票数。

## 账号管理与新比赛

服务启动时自动执行账号、身份映射和会话表迁移。参赛者从页面自助注册；管理员在 API 容器的交互终端中创建：

```sh
docker compose exec api npm run auth:create-admin
docker compose exec api npm run auth:reset-password
```

命令依次询问用户名、显示姓名（创建管理员时）和两次密码。密码输入隐藏，长度为 15～128 个字符。密码重置会立即撤销该账号全部会话。请通过核实身份的管理员流程处理密码重置请求。

本地 PGlite 管理命令为 `npm run auth:create-admin` / `npm run auth:reset-password`；先停止开发服务，以便命令独占本地数据库目录。新建本地比赛可设置 `LOCAL_DATABASE_DIR=.local/新比赛/postgres` 与 `UPLOAD_DIR=.local/新比赛/uploads`，运行服务和管理命令时保持相同配置。生产 PostgreSQL 支持在运行中的 API 容器执行管理命令。TLS 部署命令同时带上两个 `-f` 参数。

新比赛使用独立空数据库与上传目录。可按下面的方式创建独立 Compose 项目及全新的 named volumes：

```sh
docker compose -p super-code-event config --quiet
docker compose -p super-code-event up -d --build
docker compose -p super-code-event exec api npm run auth:create-admin
```

后续操作保持相同项目名称。切换服务前对旧项目数据库与上传文件做成对备份，停止旧网站占用的 HTTP 端口，再启动新项目。认证迁移保留旧用户、作品及票数；旧数据留存于原项目 volumes。

`.env` 可设置下列认证参数：

| 参数                          | 默认值 | 行为                 |
| ----------------------------- | -----: | -------------------- |
| AUTH_SESSION_SECONDS          | 604800 | 会话最长存活秒数     |
| AUTH_IDLE_SECONDS             |  86400 | 连续闲置过期秒数     |
| AUTH_LOGIN_IP_PER_MINUTE      |     60 | 单 IP 每分钟登录次数 |
| AUTH_LOGIN_ACCOUNT_PER_MINUTE |     10 | 单账号每分钟登录次数 |
| AUTH_REGISTER_IP_PER_MINUTE   |     10 | 单 IP 每分钟注册次数 |

密码使用 Node.js 异步 scrypt（N=131072，r=8，p=1），最多两项同时执行，超额返回 503。会话存储在 PostgreSQL，每小时清理过期记录；Redis承担业务缓存和认证限流。修改 `.env` 后重建 API 服务。

部署验收时使用两个独立浏览器登录不同账号，核对 `/api/v1/auth/me`、作品归属及每日额度，退出其中一个后验证另一个仍可访问。再检查同账号多设备登录、修改密码后的全部会话失效、管理员停用与重新启用。`APP_ORIGIN` 必须与浏览器发送的 Origin 完全一致，HTTPS Cookie 的 Secure 属性取决于该配置；反向代理应保留请求 Cookie、Origin、Set-Cookie，个人接口保持 no-store。

## HTTPS 与预览域名

提供 `deploy/nginx.tls.conf` 和 `deploy/compose.tls.yaml`。建议主站和作品预览使用不同注册域，例如 `cup.example.com` 与 `preview.example.net`，不要给共享父域设置认证 Cookie。主站永远不输出选手上传的 HTML。

1. 将两个域名的 DNS 指向服务器。
2. 申请证书后，放置 `certs/main/fullchain.pem`、`certs/main/privkey.pem`、`certs/preview/fullchain.pem`、`certs/preview/privkey.pem`。
3. 把 `deploy/nginx.tls.conf` 中两个示例域名替换为真实域名。
4. 设置 `.env`：`APP_ORIGIN=https://你的主站域名`，`PREVIEW_ORIGIN=https://你的预览域名`。多实例时再设置相同 `PREVIEW_SECRET`。
5. 用 TLS 覆盖启动（需要支持 `!override` 的 Compose 2.24.4+）：

```sh
docker compose -f compose.yaml -f deploy/compose.tls.yaml config --quiet
docker compose -f compose.yaml -f deploy/compose.tls.yaml up -d --build
docker compose -f compose.yaml -f deploy/compose.tls.yaml exec web nginx -t
```

TLS 模式只发布 80/443，80 重定向到 HTTPS，主站与预览由域名分流。更新证书后执行 `docker compose exec web nginx -s reload`。后续 Compose 命令也应带相同的两个 `-f` 参数。

## 资源上限

| 项目                  | 默认                          |
| --------------------- | ----------------------------- |
| 前端 API 请求并发     | 4                             |
| 前端上传              | 顺序执行                      |
| API + 预览在途请求    | 32；超额 503，不无限排队      |
| 上传在途请求          | 2；超额 503                   |
| PostgreSQL 应用连接池 | 10                            |
| PostgreSQL 最大连接   | 40                            |
| Redis 最大数据内存    | 192MB                         |
| API 容器              | 1.5 CPU / 1536MB              |
| PostgreSQL 容器       | 1.25 CPU / 1536MB             |
| Redis 容器            | 0.5 CPU / 384MB               |
| Nginx 容器            | 0.5 CPU / 192MB               |
| IP API 限流           | 240 次／分钟，Nginx 另有限流  |
| 用户投票／上传限流    | 20／10 次／分钟               |
| 列表／榜单缓存        | 10／15 秒，单实例合并同键重建 |
| 日志                  | 每容器 3 × 10MB               |

修改 `.env` 的 `MAX_INFLIGHT`、`MAX_UPLOADS`、`DB_POOL_MAX`、`IP_RATE_PER_MINUTE` 等参数后重建服务。默认只部署 **一个 API 实例**；不要直接把副本数量加倍而不调整数据库总连接预算、共享文件存储及全局并发预算。

页面隐藏时榜单不刷新；首页飞行动画不可见时暂停。列表只加载静态封面，不会启动所有作品的脚本。仅打开详情中的预览才运行作品。

缓存故障会让依赖缓存的接口失败，不会突然绕过保护把流量全部打向数据库。监控健康检查、429/503 比例、接口延迟、磁盘使用率和容器内存。

## 备份与恢复

数据库与上传文件需要成对备份。为了得到一致的备份，在短暂维护窗口停止 API（网站静态内容仍可访问）：

```sh
mkdir -p backups
docker compose stop api
docker compose exec -T db pg_dump -U lark -d lark -Fc > backups/lark.dump
docker compose run --rm --no-deps --user root --entrypoint tar -v "$PWD/backups:/backup" api -czf /backup/files-backup.tgz -C /app/data/uploads .
docker compose start api
```

也可由宿主机对 named volumes 做一致性快照。将备份存至服务器以外的位置。不要把 `.env`、数据库备份、私钥或上传目录提交到 Git。

恢复应在新的部署或确认可覆盖的恢复环境中进行。先启动 db/redis，再把 SQL dump 恢复到空数据库，把归档还原到 uploads volume，最后启动 API。数据库命令示例：

```sh
docker compose up -d db redis
docker compose exec -T db pg_restore -U lark -d lark --no-owner < backups/lark.dump
docker compose run --rm --no-deps --user root --entrypoint sh -v "$PWD/backups:/backup:ro" api -c 'tar -xzf /backup/files-backup.tgz -C /app/data/uploads && chown -R node:node /app/data/uploads'
docker compose up -d api web
```

先在独立环境演练恢复，再把流量切到恢复好的实例。不要对仍在写入的正式库直接执行恢复。

## 升级与回滚

升级前记录当前源代码版本并完成成对备份；以新代码构建后启动，检查 `/api/v1/health`、前台列表、报名与管理员审核。迁移表记录已应用版本。

本项目不自动执行破坏性的向下迁移。无 schema 变更时可使用之前的镜像／源代码版本回滚；涉及不兼容 schema 时使用备份恢复到独立实例，并把旧版本服务指向该实例后切换流量。

## 验证边界

本次开发环境没有 Docker Engine；业务通过真实 PostgreSQL 语义的 PGlite 测试，开发服务也已实际运行。Compose 文件和 Nginx 配置已交付，但 **Docker 构建、容器启动、生产 PostgreSQL/Redis 与 HTTPS 证书链仍需在部署服务器执行上述验收命令**。本地短测不代表正式服务器容量承诺。
