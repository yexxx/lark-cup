import { activityWindow } from "./activity";
import type { User } from "./auth";
import type { Competition, Quota, Work } from "./types";

export type GuideStep = {
  id: string;
  anchor: string;
  title: string;
  body: string;
};
export type PageGuide = {
  id: string;
  title: string;
  ready: boolean;
  steps: GuideStep[];
  priority?: number;
};
const step = (anchor: string, title: string, body: string): GuideStep => ({
  id: anchor,
  anchor,
  title,
  body,
});
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export function scheduleGuidance(
  competition: Competition,
  kind: "submission" | "vote",
  now = Date.now(),
) {
  const start = competition[`${kind}Start`];
  const end = competition[`${kind}End`];
  return `${kind === "submission" ? "投稿" : "投票"}时间：${date(start)} — ${date(end)}（北京时间），当前${activityWindow(start, end, now)}。`;
}
export function voteGuidance(
  competition: Competition,
  user: User | null,
  quota: Quota | null,
  work?: Work,
  now = Date.now(),
) {
  const limit = quota?.limit ?? competition.effectiveDailyLimit;
  const remaining = quota ? Math.max(0, quota.limit - quota.classic) : null;
  const state = !user
    ? "登录后可为喜欢的公开作品投票。"
    : work && work.status !== "approved"
      ? "此作品当前为草稿或已撤回，公开后可参与投票。"
      : work && quota?.votedIds.includes(work.id)
        ? "你今天已为这份作品投票，可在次日继续支持。"
        : remaining === 0
          ? "今日选票已用完，可在次日继续支持。"
          : remaining === null
            ? "登录额度正在同步，可通过剩余票数查看最新状态。"
            : `你今天还剩 ${remaining} 票。`;
  return `${state}每日 ${limit} 票，同一作品每天最多 1 票，北京时间零点重置；作废票占用当日额度。${scheduleGuidance(competition, "vote", now)}`;
}
export function homeGuide(competition: Competition): PageGuide {
  return {
    id: "home",
    title: "参与活动",
    ready: true,
    steps: [
      step(
        "home-schedule",
        "先了解活动赛程",
        `${scheduleGuidance(competition, "submission")}${scheduleGuidance(competition, "vote")}`,
      ),
      step(
        "home-prompt",
        "领取统一提示词",
        "复制这里的统一提示词，交给你选择的 AI 模型创作。所有作品使用同一道题目，以 HTML 与内嵌 SVG 完成。",
      ),
      step(
        "home-create",
        "准备并提交作品",
        "通过“开始创作”进入投稿页，登录或注册后填写名称、提供 HTML。封面会自动生成，作品介绍和使用的模型可选填。",
      ),
      step(
        "home-browse",
        "欣赏大家的创意",
        "通过“浏览作品”进入展区，搜索和筛选作品，打开交互预览并为喜欢的作品投票。各页面的“操作引导”可随时重看。",
      ),
    ],
  };
}
export function galleryGuide(
  ranking: boolean,
  competition: Competition,
  user: User | null,
  quota: Quota | null,
  ready: boolean,
  first?: Work,
): PageGuide {
  return {
    id: ranking ? "ranking" : "gallery",
    title: ranking ? "人气榜单" : "发现作品",
    ready,
    steps: [
      ...(ranking
        ? [
            step(
              "gallery-heading",
              "查看人气排名",
              "榜单按有效票数排序，同票作品拥有相同名次。点击作品可进入详情并体验创意。",
            ),
          ]
        : [
            step(
              "gallery-search",
              "找到想看的作品",
              "输入作品名称或编号进行搜索，清空搜索可恢复作品列表。暂时没有结果时，可以换个关键词。",
            ),
            step(
              "gallery-sort",
              "选择浏览方式",
              "编辑精选展示推荐作品，最新作品按发布时间浏览，人气作品按票数浏览。切换排序会回到列表首页。",
            ),
          ]),
      ...(first
        ? [
            step(
              "gallery-open",
              "打开作品体验",
              "点击封面或作品名称进入详情，再打开交互预览。评选期间作者保持匿名，作品卡片展示名称、模型和票数。",
            ),
            step(
              "gallery-vote",
              "为创意加一票",
              voteGuidance(competition, user, quota, first),
            ),
          ]
        : [
            step(
              "gallery-empty",
              "发现下一份创意",
              "当前列表暂无作品或匹配结果。可以调整搜索条件，或通过这里的创作入口提交自己的作品。",
            ),
          ]),
      step(
        "gallery-quota",
        "查看每日选票",
        voteGuidance(competition, user, quota),
      ),
      ...(ranking
        ? [
            step(
              "ranking-updated",
              "了解榜单更新",
              "榜单在页面可见时每分钟自动刷新，也可以点击刷新按钮查看最新结果。投票后其他列表会随缓存更新展示新票数。",
            ),
          ]
        : [
            step(
              "gallery-nav",
              "切换到人气榜单",
              "在这里切换发现作品与人气榜单，继续浏览大家支持的创意。",
            ),
          ]),
    ],
  };
}
export function loginGuide(register: boolean, busy: boolean): PageGuide {
  return {
    id: register ? "register" : "login",
    title: register ? "注册账号" : "登录账号",
    ready: !busy,
    priority: 10,
    steps: [
      step(
        "auth-mode",
        "选择登录或注册",
        "已有账号请选择登录；创建账号请选择注册。注册成功后会自动登录，并进入当前活动页面。",
      ),
      step(
        "auth-account",
        "填写账号信息",
        `用户名为 3～32 位英文字母、数字、下划线或短横线，大小写统一处理。${register ? "显示姓名用于界面展示，允许与其他人重名。" : "请输入注册时使用的用户名。"}`,
      ),
      step(
        "auth-password",
        "填写密码",
        `密码为 8～128 个字符，支持空格和中文。${register ? "确认密码需要与密码一致。" : "请输入当前账号的密码。"}`,
      ),
      step(
        "auth-submit",
        register ? "完成注册" : "进入比赛",
        register
          ? "检查填写的信息后，点击“注册并进入比赛”。注册后的账号可以投稿、管理自己的作品和投票。"
          : "点击“登录并进入比赛”。忘记密码时，请联系赛事管理员重置。",
      ),
    ],
  };
}
export function submitGuide(
  competition: Competition,
  user: User | null,
  ready: boolean,
  published: boolean,
): PageGuide {
  return {
    id: "submit",
    title: "提交与编辑作品",
    ready,
    steps: !user
      ? [
          step(
            "submit-login",
            "登录后开启创作",
            "点击“登录并参赛”，使用已有账号登录或自助注册。登录弹窗也提供账号操作引导。",
          ),
        ]
      : [
          step(
            "submit-prompt",
            "使用统一创作题目",
            `将统一提示词交给 AI 模型，以 HTML 与内嵌 SVG 完成创作。${scheduleGuidance(competition, "submission")}`,
          ),
          step(
            "submit-info",
            "填写作品信息",
            "作品名称必填，最多 80 个字符。作品介绍和使用的模型可选填，分别最多 3000 和 100 个字符。",
          ),
          step(
            "submit-html",
            "提供 HTML 作品",
            "选择单个 .html／.htm 文件，或粘贴完整 HTML 源码与 HTML 文件，最大 5MB。百灵鸟使用内嵌 SVG 绘制，内容包含在同一文件内，预览仅使用文件中的资源。上传失败后可通过重试继续。",
          ),
          step(
            "submit-cover",
            "选择作品封面",
            "提供 HTML 后自动生成封面；生成中或使用占位封面时也可发布。你也可以上传或粘贴 JPEG、PNG、WebP 图片，最大 2MB，再按需切回自动封面或重新生成。",
          ),
          step(
            "submit-save",
            published ? "保存公开作品的更改" : "先保存草稿",
            `${published ? "“保存更改”更新当前公开作品，保存后继续在展区展示。" : "填写名称后可保存草稿，稍后从“我的作品”继续编辑。草稿可在提供 HTML 前保存。"}保存和编辑在投稿时间内开放。`,
          ),
          step(
            "submit-publish",
            "确认并发布作品",
            "提供 HTML 并完成上传后，点击“发布作品”。确认你拥有发布权且文件内容自包含，再点击“确认发布”，作品会直接进入展区。发布在投稿时间内开放。",
          ),
        ],
  };
}
export function mineGuide(
  user: User | null,
  ready: boolean,
  items: Work[] | null,
): PageGuide {
  const actions: GuideStep[] = [];
  if (items?.some((w) => w.status === "approved"))
    actions.push(
      step(
        "mine-withdraw",
        "撤回公开作品",
        "撤回时需要确认，确认后作品从公开展区移除，已有票数保留。投稿时间内可重新发布。",
      ),
    );
  if (items?.some((w) => ["draft", "withdrawn"].includes(w.status)))
    actions.push(
      step(
        "mine-publish",
        "发布草稿或撤回的作品",
        "提供 HTML 后，可在投稿时间内点击“发布”进入展区。需要补充文件或调整内容时，先进入编辑页面。",
      ),
    );
  return {
    id: "mine",
    title: "管理我的作品",
    ready,
    steps: !user
      ? [
          step(
            "mine-login",
            "登录查看自己的作品",
            "登录后可以查看账号下的草稿、公开作品和已撤回作品，并继续编辑或发布。",
          ),
        ]
      : [
          step(
            "mine-create",
            "新建一份创意",
            items?.length
              ? "点击“新建作品”进入投稿页，准备下一份创作。"
              : "这里会记录你提交的作品。点击“新建作品”或“开始创作”，填写名称并提供 HTML 即可开始。",
          ),
          ...(items?.length
            ? [
                step(
                  "mine-status",
                  "了解作品状态",
                  "草稿由你继续完善；已公开作品在展区展示；已撤回作品保留创作记录与已有票数。管理反馈会显示在对应作品下方。",
                ),
                step(
                  "mine-edit",
                  "预览或继续编辑",
                  "通过“预览”检查作品，通过“编辑”修改内容。公开作品保存更改后继续展示，草稿和撤回作品可在编辑后发布。",
                ),
                ...actions,
              ]
            : []),
        ],
  };
}
export function detailGuide(
  work: Work | null,
  competition: Competition,
  user: User | null,
  quota: Quota | null,
  ready: boolean,
): PageGuide {
  return {
    id: "detail",
    title: "体验作品",
    ready,
    steps: [
      step(
        "detail-preview",
        "打开交互预览",
        work?.previewUrl
          ? "点击“打开交互预览”或“开始体验作品”运行 HTML 动画。可以关闭预览，或在打开后重新加载。预览仅使用作品文件中的资源。"
          : "这份作品尚未提供 HTML，补充文件后即可打开交互预览。",
      ),
      step(
        "detail-share",
        "分享作品链接",
        "点击“复制链接”分享当前作品页面。复制失败时可从浏览器地址栏复制；草稿及撤回作品的查看权限由作者账号决定。",
      ),
      step(
        "detail-vote",
        "支持喜欢的创意",
        voteGuidance(competition, user, quota, work ?? undefined),
      ),
      step(
        "detail-back",
        "继续发现创意",
        "通过这里返回作品展区，继续搜索、浏览与体验其他作品。",
      ),
    ],
  };
}
