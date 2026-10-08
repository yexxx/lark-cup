# 压力测试与恢复验证

测试目标是固定到达速率下的业务完成率、容量拐点、过载恢复和数据一致性。使用生产 Dockerfile、PostgreSQL、Redis、Nginx，以及项目的容器资源预算。具体实测结论见 [压测报告](stress-report.md)。

## 隔离环境

在项目根目录运行。macOS Apple Silicon 使用独立的 Colima profile；[Colima 文档](https://github.com/abiosoft/colima)介绍了多实例及 CPU、内存、磁盘参数。

```sh
brew install docker docker-compose colima
colima start --profile lark-load --cpu 4 --memory 8 --disk 40 --vm-type vz --mount-type virtiofs
npm ci
npm run load:env -- --command up --tag fixed --profile default
npm run load:env -- --command seed --size small --seed 1024
```

环境工具显式使用 `~/.colima/lark-load/docker.sock`，也支持 `LOAD_DOCKER_HOST`。Compose 项目名固定为 `lark-cup-load`，数据库为 `lark_load`。本地端口仅绑定 loopback：主站 18080、预览 18081、直接 API 13001／13002、PostgreSQL 15432、Redis 16379。数据库、Redis、上传数据各使用独立 named volume。

测试密码、真实会话 Cookie、证书和指标存放于已忽略的 `.local/load/`；原始结果存放于已忽略的 `test-results/load/`。报告可以保留公开统计，分享原始目录前先检查内容。`seed` 会清空专用测试数据库、上传卷及专用 Redis，校验隔离标记、数据库名称和容器上传路径后才执行。

| 服务       |  CPU |    内存 | 保留的约束                                             |
| ---------- | ---: | ------: | ------------------------------------------------------ |
| API        |  1.5 | 1536MiB | 在途 32、上传 2、密码计算 2、连接池 10                 |
| PostgreSQL | 1.25 | 1536MiB | 最大连接 40、语句超时 10s                              |
| Redis      |  0.5 |  384MiB | 数据上限 192MiB、volatile-lru、AOF                     |
| Nginx      |  0.5 |  192MiB | 2 个 worker；默认每 worker 256 个连接，容量配置为 4096 |

默认配置使用代码中的真实保护设置。容量配置将测试 API 的 IP／预览 IP 每分钟频率提高到 10 亿、登录／注册 IP 频率提高到 100 万，Nginx 请求频率及突发预算提高到 100000、单 IP 连接上限提高到 10000、每 worker 连接上限提高到 4096；密码成本、每日额度、用户投票／上传频率、API 总在途预算和数据库连接池沿用项目配置。测试预览频率调整由内部启动器完成，公共 API 接口保持原有合同。

```sh
npm run load:env -- --command up --tag fixed --profile capacity
npm run load:env -- --command seed --size large --seed 1024
npm run load:collect -- --output test-results/load/fixed-resources.jsonl
```

采集器持续写入 Docker CPU／内存、数据库连接和锁等待、Redis 内存／淘汰、素材数和字节数。测试启动器每 5 秒采集 API CPU、RSS、堆、事件循环延迟、查询耗时及缓存命中。健康接口和业务接口保持可独立检查。

## 数据与动作模型

`small` 是 1000 账号／500 作品／5000 历史票；`large` 是 10000 账号／5000 作品／100000 历史票。历史票及对应额度使用独立历史日期；当天投票预算按 10 票／账号准备。账号拥有真实凭据哈希及数据库会话，登录场景仍执行完整 scrypt。测试数据与工作 UUID 随种子稳定生成，Cookie 使用随机安全令牌。

| 场景     | 一个业务动作产生的请求                                                   |
| -------- | ------------------------------------------------------------------------ |
| cached   | 列表、榜单或统计中的一次读取                                             |
| database | 不同大小写搜索词的一次读取，增加缓存键基数并保持真实 ILIKE 匹配          |
| browse   | 列表＋一张封面；30% 追加详情和预览；`--covers 12` 读取列表中的 12 张封面 |
| auth     | 真实登录、当前账号读取、退出，共 3 次请求                                |
| vote     | 投票＋额度读取，共 2 次请求；优先竞争热门作品                            |
| upload   | 封面上传、HTML 上传、创建作品、直接发布，共 4 次请求                     |
| mixed    | 浏览 70%、投票 15%、投稿 10%、认证 5%，按业务动作抽样                    |

默认容量对比中浏览动作使用一张封面。12 张封面的场景单独报告，以反映首次打开作品墙的资源流量。混合场景独立计算每个动作的随机选择，异步完成顺序不会改变后续动作比例。输出包含各类实际动作数、成功动作数和每类实际请求量。

```sh
npm run test:load -- --scenario mixed --profile capacity --rate 32 --duration 180 --warmup 30 --concurrency 256 --seed 1024 --output test-results/load/mixed-32.json
npm run test:load -- --scenario browse --covers 12 --rate 5 --duration 180 --output test-results/load/gallery.json
npm run load:env -- --command multi --tag fixed --scenario browse --shards 4 --rate 1 --duration 180 --prefix fixed-default-multi
node --import tsx scripts/load/ip-evidence.ts --prefix fixed-default-multi
```

多个来源客户端使用独立 Docker 网络地址，Nginx 将实际源地址传给 API；源地址证据从访问日志提取。容量场景的主发生器运行于宿主机，降低客户端和被测服务对测试虚拟机资源的竞争。

## 容量、突发与持续测试

`rate` 表示每秒计划业务动作数。工具按绝对时间调度；并发预算耗尽时记录未发出动作，采样结束时补记截至截止时未调度的计划动作。结果包含计划／实际发出／未发出／完成数、调度延迟、客户端 CPU／内存／事件循环延迟，容量判断应同时考虑客户端调度情况。

工具同时记录墙上时间、单调时间和最大调度间隔。检测到超过 5s 的执行暂停时会保留原始数据并以失败状态退出，该次采样应归入环境中断，重新执行同一档位。持续测试还要求 API 的实际运行时长覆盖采样时长；运行时可以使用 `caffeinate -is` 临时阻止空闲睡眠。

```sh
npm run load:suite -- --prefix fixed --size large
```

每档默认预热 30s、采样 180s；负载按倍数增长，连续两档失败后停止。默认执行一次区间中点细化，再对最高通过档进行 300s 复测。支持 `--scenarios`、`--start-rate`、`--max-rate`、`--known-stable`、`--refine`。每次混合场景重置对应规模的数据，保护每日额度容量结论。

基准固定为 `2fc698a38e82bb2a95224ff4a55c5473bb25ad15`。将该提交导出到专用忽略目录，沿用当前测试发生器和同一 Compose 资源预算：

```sh
mkdir -p .local/load/baseline
git archive 2fc698a38e82bb2a95224ff4a55c5473bb25ad15 | tar -x -C .local/load/baseline
npm run load:env -- --command up --source .local/load/baseline --tag baseline --profile capacity
npm run load:env -- --command seed --size large --seed 1024
node --import tsx scripts/load/manifest.ts --output test-results/load/environment-manifest-baseline.json
npm run load:suite -- --prefix baseline --size large --scenarios cached,database
npm run load:suite -- --prefix baseline-quality --size large --scenarios mixed --start-rate 8
```

小档将 `--size large` 改为 `--size small`，随后切回 `--tag fixed --profile capacity`，以独立的 `fixed` 前缀运行两种规模。每次比较核对种子、上传字节数、动作比例、镜像和源码散列。确认容量应从通过全部分项 SLO 的 300 秒结果读取。

默认混合场景上传 68B HTML 与 68B PNG，结果中记录实际字节数。用 `--html-bytes` 可以改变有效 HTML 文件大小；同一比较必须使用相同大小。接近上限的独立投稿容量可这样运行，每档会重置素材：

```sh
npm run load:suite -- --prefix fixed-maxfiles --size large --scenarios upload --start-rate 0.5 --max-rate 8 --html-bytes 5242780
```

通过条件：全局及各业务动作完成率均 ≥99%，非预期 5xx 和超时合计 ≤0.1%，普通读取／封面／预览／写入 p95 ≤300ms、投票 ≤800ms、认证 ≤2s、正常上传 ≤5s；调度延迟超过 100ms 的动作比例 ≤1%。503 保护拒绝计入动作失败，另外单独呈现。

```sh
npm run load:env -- --command seed --size large
npm run load:burst -- --prefix fixed --stable 32
npm run load:env -- --command seed --size large
npm run load:env -- --command restart --service api
npm run load:soak -- --stable-file test-results/load/fixed-large-mixed-confirm.json
```

突发测试中的 32 应替换为实际复测稳定容量。持续测试启动器读取确认档，按其速率的 70% 运行，准备大档数据、重启 API、独立采集资源及服务指标，并保留两个已过期会话供每小时清理验证。持续测试前确认账号池满足 `(预热＋持续时间)×速率×15% ≤ 可用账号数×10`，并独立记录历史额度与当日额度。观察第二个半小时的内存趋势，同时检查异常退出、OOM、数据库死锁、上传目录增长及资源名额归还。验收文件记录四个容器的启动时间与重启次数，停止业务后通过内部指标检查上传、预览、导出和密码队列全部归零；采集器继续保留每 5 秒的资源快照。

本次大档三个确认值分别为缓存 4800、数据库 240、混合 96 动作/秒。依次使用 `load:burst -- --scenario cached --stable 4800`、`--scenario database --stable 240`、`--scenario mixed --stable 96`，各场景先重置大档数据，默认突发持续 30 秒且为确认值的三倍。复现时以当次确认值替换这些数字，并给各组设置独立 `--prefix`。

## 一致性与故障验证

```sh
npm run load:checks -- --output test-results/load/fixed-checks.json
npm run load:reconcile -- --output test-results/load/fixed-reconciliation.json
npm run load:env -- --command seed --size large
npm run load:faults -- --phase fixed
npm run load:cache-pressure -- --output test-results/load/cache-pressure-fixed.json
```

真实 HTTP／PostgreSQL 检查覆盖并发注册、错误登录、身份绑定、作品归属、大文件／大图片／深层 HTML、慢上传、编辑版本冲突、热门投票、额度竞争、幂等键、撤回／作废、预览签名、跨来源写入、CSV 快照和审计。对账核查素材文件与数据库行的数量／字节、每日额度、重复票、作品素材归属和发布审计。

故障工具只操作有专用 Compose 标签的依赖和自行创建的测试容器：Redis 停止、PostgreSQL 停止、数据库暂停期间客户端断开并按相同键重试、API 重启、1MiB tmpfs 上传卷写满、上传中断。临时容器在 `finally` 中删除。`--phase baseline` 保留失败现象，`fixed` 对正常恢复和 503 合同执行断言。依赖恢复后以健康和业务读取检查 30s 恢复标准。

缓存淘汰工具使用独立 8MiB Redis 验证 100 组已耗尽预算，随后施加缓存压力并核查预算和并发计数。生产限流使用无 TTL 的有界注册表，业务缓存淘汰会保留频率额度；到期条目按 Redis 时钟回收。

## TLS 与浏览器

```sh
npm run load:tls -- --command up
npm run load:tls -- --command check
npm run load:tls -- --command down
```

工具在忽略目录生成有效期 7 天的本地 CA 和测试证书，启动主站 `https://localhost:18443` 与预览 `https://127.0.0.1:18443`。校验请求显式信任测试 CA，验证 TLS、Secure／HttpOnly／SameSite Cookie、代理后的账号会话、跨来源写入、预览 CSP 和退出。测试 CA 的信任仅用于测试请求。浏览器另行验证繁忙提示、恢复、账号切换、上传取消、预览及首页动画。

## 服务行为与保留边界

- 活跃会话每次读取最新用户／会话状态，写入活动时间最多每 60s 一次；闲置过期采用存储的活动时间，最多提前约一个记录间隔到期。
- 密码计算保留两个名额，认证请求最多等待 6 个、最长等待 1s；超过预算返回带重试提示的 503。评估混合业务时各动作成功率均要求达到 99%，避免低占比认证失败被总体指标掩盖。
- 大于 128KiB 的 HTML 在独立进程中校验，单个进程堆上限 256MiB、截止时间 3s；结构限制为 256 层、100000 元素。上传名额覆盖校验进程退出及写盘过程。
- 预览名额默认为 8，仍计入总在途 32；同时导出名额为 1，使用 PostgreSQL 只读可重复读游标保证同一快照并释放连接。
- 已成功上传的素材及作品历史持续保留。磁盘用量应按实测增长预算；失败写盘会清理部分文件，磁盘不足返回可恢复的 503。
- 数据库连接池空闲连接错误会记录日志并重新建立连接；依赖服务不可用时返回带重试提示的 503。
- 网关 API／预览的上游活动连接上限分别为 32／8，通过共享区在两个 worker 间计数；复用池分别为每 worker 32／8。封面与预览沿用 HTTP/1.1 连接复用，限制短连接和 TIME_WAIT 增长。该行为参照 [Nginx 上游连接说明](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)。

## 结束与材料保留

图表使用标准 Matplotlib 绘制，读取保留的 JSON／JSONL：

```sh
python3 -m venv .local/load/python
.local/load/python/bin/pip install matplotlib
.local/load/python/bin/python scripts/load/charts.py
node --import tsx scripts/load/manifest.ts
```

阶段状态保存在 `.local/load/phase.json`，控制器日志与每档 JSON 分别保留。接续前核对活动进程、数据规模、配置和源码散列；通过的确认档可以复用，发生执行暂停的档位应保留原始文件并重新采样。浏览器验收完成后才记录完成标记。

持续测试开始前先停止 API，再移动已有指标归档；结束时复制本轮指标快照，保留服务正在使用的原路径。若启动中断导致 API 已停止，先用 `load:env -- --command restart --service api` 恢复，再重跑持续测试。失败日志单独归档，完整 3600 秒验收结果保留独立前缀。

停止采集器，再停止专用环境。`down` 保留测试 named volumes；原始结果、fixture 和不可变基准源可用于复现。

```sh
npm run load:env -- --command down
colima stop --profile lark-load
npm test
npm run build
git diff --check
```

容量只适用于本机 ARM 虚拟化、上述资源预算与所记录动作模型。正式服务器的硬件、网络、公网来源分布及正式 TLS 证书链需要在部署环境执行同样的验收。
