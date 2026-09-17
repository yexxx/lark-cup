import { useEffect, useState } from "react";
import {
  Bird,
  ArrowUpRight,
  Heart,
  Sparkles,
  Search,
  Trophy,
  Plus,
  Code2,
  Medal,
  RefreshCw,
  X,
  Clock3,
  Compass,
} from "lucide-react";
import { api } from "./api";
import type { User } from "./auth";
import type { Work, Competition, Quota } from "./types";
import { ErrorBox, Loading, Pagination } from "./ui";
export function Gallery({
  ranking,
  quota,
  user,
  competition,
  vote,
  login,
  rules,
}: {
  ranking: boolean;
  quota: Quota | null;
  user: User | null;
  competition: Competition;
  vote: (w: Work) => Promise<boolean>;
  login: () => void;
  rules: () => void;
}) {
  const [sort, setSort] = useState("recommended");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    items: Work[];
    total: number;
    pages: number;
    updatedAt?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [stats, setStats] = useState<{
    works: number;
    votes: number;
    creators: number;
  } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    setPage(1);
    setData(null);
  }, [ranking]);
  useEffect(() => {
    let live = true;
    setError("");
    api(
      `/${ranking ? "leaderboard" : "works"}?sort=${sort}&q=${encodeURIComponent(search)}&page=${page}&size=12`,
    )
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [sort, search, page, ranking, refresh]);
  useEffect(() => {
    api("/stats")
      .then(setStats)
      .catch(() => {});
  }, [refresh]);
  useEffect(() => {
    if (!ranking) return;
    const t = setInterval(() => {
      if (!document.hidden) setRefresh((n) => n + 1);
    }, 60000);
    return () => clearInterval(t);
  }, [ranking]);
  return (
    <main className="container arcade-gallery" id="gallery">
      <div className="discovery-sidebar-boundary">
        <aside className="discovery-sidebar">
          <span className="sidebar-kicker">
            <Code2 size={16} /> 码力探索站
          </span>
          <nav className="discovery-nav" aria-label="作品浏览方式">
            <a className={!ranking ? "selected" : ""} href="#/gallery">
              <Compass size={18} />
              发现作品<span>{stats?.works ?? "…"}</span>
            </a>
            <a className={ranking ? "selected" : ""} href="#/ranking">
              <Trophy size={18} />
              人气榜单
            </a>
          </nav>
          {!ranking && (
            <div className="sort-options">
              <span>发现你的灵感</span>
              {[
                ["recommended", "编辑精选", Sparkles],
                ["latest", "最新作品", Clock3],
                ["votes", "人气作品", Heart],
              ].map(([id, label, Icon]) => {
                const I = Icon as typeof Heart;
                return (
                  <button
                    key={id as string}
                    className={sort === id ? "selected" : ""}
                    onClick={() => {
                      setSort(id as string);
                      setPage(1);
                    }}
                  >
                    <I size={15} />
                    {label as string}
                  </button>
                );
              })}
            </div>
          )}
          <div className="vote-pocket">
            <span>
              <Heart size={16} /> 今日剩余票数
            </span>
            <strong>
              {quota
                ? Math.max(0, quota.limit - quota.classic)
                : competition.effectiveDailyLimit}
              <small>
                {" "}
                / {quota?.limit || competition.effectiveDailyLimit} 票
              </small>
            </strong>
            <p>
              送给让你心动的作品
              <br />
              北京时间零点重置
            </p>
            {!user && (
              <button onClick={login}>
                登录后投票 <ArrowUpRight size={14} />
              </button>
            )}
          </div>
          <button className="sidebar-rules" onClick={rules}>
            查看活动规则 <ArrowUpRight size={14} />
          </button>
        </aside>
      </div>
      <section className="discovery-main">
        <div className="discovery-toolbar">
          <div>
            <h2>{ranking ? "码力人气榜" : "发现超级创意"}</h2>
            <p>
              {ranking
                ? "每一票，让超级创意被看见。"
                : stats
                  ? `${stats.works} 份作品，${stats.votes} 票支持。一起发现创意的无限可能。`
                  : "用同一道题目，打开不同的创意世界。"}
            </p>
          </div>
          {!ranking && (
            <label className="arcade-search">
              <Search size={18} />
              <input
                aria-label="搜索作品名称或编号"
                placeholder="寻找一份灵感"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="清空搜索">
                  <X size={15} />
                </button>
              )}
            </label>
          )}
          <button
            className="refresh-circle"
            title="刷新作品"
            aria-label="刷新作品"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {ranking && data?.updatedAt && (
          <p className="rank-updated">
            更新于{" "}
            {new Date(data.updatedAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            · 每分钟自动更新
          </p>
        )}
        {error ? (
          <ErrorBox message={error} retry={() => setRefresh((n) => n + 1)} />
        ) : !data ? (
          <Loading />
        ) : !data.items.length ? (
          <div className="state empty">
            <Bird size={42} />
            <h3>{search ? "暂时没有找到匹配作品" : "你的创意，等你来点亮"}</h3>
            <p>换个词找找，或带着你的百灵鸟来参赛。</p>
            <a className="button primary" href="#/submit">
              提交作品 <Plus size={16} />
            </a>
          </div>
        ) : (
          <>
            <div className={ranking ? "ranking-list" : "arcade-work-grid"}>
              {data.items.map((w) => (
                <Card
                  key={w.id}
                  w={w}
                  ranking={ranking}
                  voted={quota?.votedIds.includes(w.id) || false}
                  vote={vote}
                />
              ))}
            </div>
            <Pagination page={page} pages={data.pages} onChange={setPage} />
          </>
        )}
        <p className="arcade-gallery-note">
          <Code2 size={13} />{" "}
          欣赏创意，为喜欢的作品投票。评选期间，作者保持匿名。
        </p>
      </section>
      <section className="arcade-invitation">
        <div>
          <span>1024 程序员节 · 内源社区活动</span>
          <h2>下一份超级创意，由你创造。</h2>
        </div>
        <a className="button primary" href="#/submit">
          开始创作 <ArrowUpRight size={17} />
        </a>
      </section>
    </main>
  );
}
function Card({
  w,
  ranking,
  voted,
  vote,
}: {
  w: Work;
  ranking: boolean;
  voted: boolean;
  vote: (w: Work) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  useEffect(() => setAdded(false), [w.votes]);
  return (
    <article className={ranking ? "rank-card" : "arcade-card"}>
      {ranking && (
        <span
          className={`rank-number ${w.rank! <= 3 ? `top place-${w.rank}` : ""}`}
          aria-label={`第 ${w.rank} 名`}
        >
          {w.rank! <= 3 && <Medal size={26} aria-hidden="true" />}
          {String(w.rank).padStart(2, "0")}
        </span>
      )}
      <a className="work-cover" href={`#/work/${w.id}`}>
        {w.coverUrl ? (
          <img src={w.coverUrl} alt={w.title} loading="lazy" />
        ) : (
          <div className="cover-fallback">
            <Bird />
          </div>
        )}
        {w.recommended && (
          <span className="arcade-picked">
            <Code2 size={11} />
            精选
          </span>
        )}
        <span className="cover-hover">
          打开作品 <ArrowUpRight size={20} />
        </span>
      </a>
      <div className="arcade-card-body">
        <span className="arcade-card-number">
          作品 No.{String(w.number).padStart(3, "0")}
        </span>
        <a className="work-title" href={`#/work/${w.id}`}>
          {w.title}
        </a>
        <div className="arcade-card-meta">
          <span>{w.model}</span>
          <button
            className={`arcade-vote ${voted || added ? "voted" : ""}`}
            disabled={busy || voted || added}
            aria-label={`为${w.title}投票，当前${w.votes + (added ? 1 : 0)}票`}
            onClick={async () => {
              setBusy(true);
              try {
                if (await vote(w)) setAdded(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Heart size={15} fill={voted || added ? "currentColor" : "none"} />
            {w.votes + (added ? 1 : 0)}
          </button>
        </div>
      </div>
    </article>
  );
}
