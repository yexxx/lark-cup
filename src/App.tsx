import { useState, useEffect, useCallback } from "react";
import {
  Bird,
  ArrowUpRight,
  ArrowRight,
  Heart,
  Sparkles,
  Search,
  SlidersHorizontal,
  Trophy,
  Plus,
  LogOut,
  Menu,
  X,
  Music2,
  Flag,
  Leaf,
  ChevronDown,
  Check,
  RefreshCw,
  UserRound,
  Code2,
} from "lucide-react";
import { api, send } from "./api";
import { authAdapter, type User } from "./auth";
import type { Work, Competition, Quota } from "./types";
import { Modal, Loading, ErrorBox, Pagination, formatDate } from "./ui";
import { SubmitPage, MyWorks } from "./Submit";
import { Admin } from "./Admin";
import { HomeIntro } from "./HomeIntro";
import { Gallery } from "./Gallery";

const navigate = (path: string) => {
  location.hash = path;
};
export function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  const [user, setUser] = useState<User | null>(null);
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [info, setInfo] = useState<"rules" | "prizes" | "prompt" | null>(null);
  const [toast, setToast] = useState("");
  const [startupError, setStartupError] = useState("");
  const [mobile, setMobile] = useState(false);
  const notify = useCallback((text: string) => setToast(text), []);
  const loadQuota = useCallback(async () => {
    try {
      setQuota(await api("/me/quota"));
    } catch {
      setQuota(null);
    }
  }, []);
  const refreshCompetition = useCallback(
    async () => setCompetition(await api("/competition")),
    [],
  );
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || "/");
      setMobile(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    (async () => {
      try {
        await refreshCompetition();
        setUser((await authAdapter.currentUser()).user);
      } catch (e) {
        setStartupError((e as Error).message);
      }
    })();
  }, [refreshCompetition]);
  useEffect(() => {
    if (user) void loadQuota();
    else setQuota(null);
  }, [user, loadQuota]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  const requireLogin = () => {
    if (user) return true;
    setAuthOpen(true);
    return false;
  };
  const vote = async (w: Work) => {
    if (!requireLogin()) return false;
    try {
      await send(`/works/${w.id}/votes`, undefined, "POST", {
        "Idempotency-Key": crypto.randomUUID(),
      });
      await loadQuota();
      notify("心意送达！这一票，送给好创意。");
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  const isHome = route === "/" || route === "/gallery";
  return (
    <>
      <header className="header">
        <a href="#/" className="brand">
          <span className="brand-icon">
            <Bird size={26} />
          </span>
          <strong>
            {competition?.title || "百灵鸟杯"}
            <span>让灵感，自然生长</span>
          </strong>
        </a>
        <nav className={mobile ? "nav open" : "nav"}>
          <a className={isHome ? "active" : ""} href="#/gallery">
            作品展区
          </a>
          <a className={route === "/ranking" ? "active" : ""} href="#/ranking">
            人气榜单 <ArrowUpRight size={14} />
          </a>
          <button onClick={() => setInfo("rules")}>赛事规则</button>
          <button onClick={() => setInfo("prizes")}>奖项设置</button>
          {mobile && user && (
            <button
              onClick={async () => {
                try {
                  await authAdapter.logout();
                  setUser(null);
                  setMobile(false);
                  notify("已退出登录");
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              退出登录
            </button>
          )}
        </nav>
        <div className="header-actions">
          {user ? (
            <>
              <button
                className="user-button"
                aria-label={`${user.name}的作品`}
                onClick={() => navigate("/mine")}
              >
                <UserRound size={16} />
                <span>{user.name}</span>
              </button>
              <button
                className="icon-button"
                title="退出登录"
                aria-label="退出登录"
                onClick={async () => {
                  await authAdapter.logout();
                  setUser(null);
                  notify("已退出登录");
                }}
              >
                <LogOut size={17} />
              </button>
            </>
          ) : (
            <button className="login-link" onClick={() => setAuthOpen(true)}>
              登录
            </button>
          )}
          <button
            className="button small primary"
            onClick={() => {
              if (requireLogin()) navigate("/submit");
            }}
          >
            我要参赛 <Plus size={16} />
          </button>
          <button
            className="mobile-toggle icon-button"
            aria-label="切换导航"
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      {startupError ? (
        <main className="container">
          <ErrorBox message={startupError} retry={() => location.reload()} />
        </main>
      ) : !competition ? (
        <Loading />
      ) : (
        <>
          {route === "/" && (
            <HomeIntro competition={competition} notify={notify} />
          )}
          {isHome || route === "/ranking" ? (
            <Gallery
              ranking={route === "/ranking"}
              quota={quota}
              user={user}
              competition={competition}
              vote={vote}
              login={() => setAuthOpen(true)}
              rules={() => setInfo("rules")}
            />
          ) : route.startsWith("/work/") ? (
            <WorkDetail
              id={route.split("/")[2]}
              vote={vote}
              quota={quota}
              notify={notify}
            />
          ) : route.startsWith("/submit") ? (
            <SubmitPage
              id={route.split("/")[2]}
              user={user}
              competition={competition}
              login={() => setAuthOpen(true)}
              notify={notify}
            />
          ) : route === "/mine" ? (
            <MyWorks
              user={user}
              login={() => setAuthOpen(true)}
              notify={notify}
            />
          ) : route === "/admin" ? (
            <Admin
              user={user}
              login={() => setAuthOpen(true)}
              notify={notify}
              competition={competition}
              refreshCompetition={refreshCompetition}
            />
          ) : (
            <main className="state">
              <h2>页面不存在</h2>
              <a href="#/">返回首页</a>
            </main>
          )}
        </>
      )}
      <footer className="footer">
        <a href="#/" className="brand">
          <Bird size={25} />
          <strong>
            百灵鸟杯<span>LET YOUR IDEAS TAKE FLIGHT.</span>
          </strong>
        </a>
        <div>
          <a href="#/mine">我的作品</a>
          <button onClick={() => setInfo("rules")}>比赛规则</button>
          <a href="#/admin">管理后台</a>
          <span>© 2026 LARK JAM</span>
        </div>
      </footer>
      {authOpen && (
        <Login
          onClose={() => setAuthOpen(false)}
          onLogin={(u) => {
            setUser(u);
            setAuthOpen(false);
            notify(`欢迎回来，${u.name}`);
          }}
        />
      )}
      {info && competition && (
        <Modal
          title={
            info === "rules"
              ? "赛事规则"
              : info === "prizes"
                ? "奖项设置"
                : "统一提示词"
          }
          onClose={() => setInfo(null)}
        >
          <div className="prose">
            <p>{competition[info]}</p>
            {info === "rules" && (
              <>
                <h3>投票规则</h3>
                <p>
                  每人每天 {competition.effectiveDailyLimit}{" "}
                  票，同一作品每天最多 1
                  票。北京时间零点重置；作废票不返还当日额度。
                </p>
                <h3>赛程</h3>
                <p>
                  投稿：{formatDate(competition.submissionStart)} —{" "}
                  {formatDate(competition.submissionEnd)}
                  <br />
                  投票：{formatDate(competition.voteStart)} —{" "}
                  {formatDate(competition.voteEnd)}
                </p>
              </>
            )}
            {info === "prompt" && (
              <button
                className="button primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(competition.prompt);
                    notify("提示词已复制");
                  } catch {
                    notify("请手动选择并复制提示词");
                  }
                }}
              >
                复制提示词
              </button>
            )}
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button onClick={() => setToast("")} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

function Login({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (u: User) => void;
}) {
  const [id, setId] = useState("visitor");
  const [name, setName] = useState("灵感访客");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="欢迎来到百灵鸟杯" onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            onLogin((await authAdapter.login(id, name)).user);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">登录认证待接入，当前使用演示身份体验完整流程。</p>
        <div className="segmented">
          <button
            type="button"
            className={id === "visitor" ? "selected" : ""}
            onClick={() => {
              setId("visitor");
              setName("灵感访客");
            }}
          >
            参赛者
          </button>
          <button
            type="button"
            className={id === "admin" ? "selected" : ""}
            onClick={() => {
              setId("admin");
              setName("赛事管理员");
            }}
          >
            管理员
          </button>
        </div>
        <label>
          身份标识
          <input
            required
            pattern="[a-zA-Z0-9_-]{1,48}"
            value={id}
            onChange={(e) => setId(e.target.value)}
            maxLength={48}
          />
          <small>
            英文字母、数字、下划线或短横线，可填写不同标识体验多用户。
          </small>
        </label>
        <label>
          显示名称
          <input
            required
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <ErrorBox message={error} />}
        <button disabled={busy} className="button primary">
          {busy ? "正在进入…" : "进入比赛"}
          <ArrowRight size={18} />
        </button>
      </form>
    </Modal>
  );
}

function WorkDetail({
  id,
  vote,
  quota,
  notify,
}: {
  id: string;
  vote: (w: Work) => Promise<boolean>;
  quota: Quota | null;
  notify: (s: string) => void;
}) {
  const [w, setW] = useState<Work | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setW(null);
    setError("");
    setPreview(false);
    api(`/works/${id}`)
      .then(setW)
      .catch((e) => setError(e.message));
  }, [id, reload]);
  return (
    <main className="container detail">
      <a href="#/gallery" className="back-link">
        ← 返回作品展区
      </a>
      {error ? (
        <ErrorBox message={error} retry={() => setReload((n) => n + 1)} />
      ) : !w ? (
        <Loading />
      ) : (
        <>
          <div className="detail-heading">
            <div>
              <span className="eyebrow">
                HTML + SVG / NO. {String(w.number).padStart(4, "0")}
              </span>
              <h1>{w.title}</h1>
              <p className="muted">
                使用 {w.model} 创作
                {w.ownerId ? ` · 作者 ${w.ownerId}` : " · 作者评选期间匿名"}
              </p>
            </div>
            <button
              className="button primary"
              disabled={
                busy ||
                quota?.votedIds.includes(w.id) ||
                w.status !== "approved"
              }
              onClick={async () => {
                setBusy(true);
                try {
                  if (await vote(w)) setW({ ...w, votes: w.votes + 1 });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Heart size={19} />
              {quota?.votedIds.includes(w.id) ? "今日已投" : "投它一票"} ·{" "}
              {w.votes}
            </button>
          </div>
          <div className="preview-toolbar">
            <span>
              <Code2 size={17} /> 交互作品
            </span>
            <div>
              <button
                onClick={() => {
                  navigator.clipboard
                    .writeText(location.href)
                    .then(() => notify("作品链接已复制"))
                    .catch(() => notify("请复制地址栏链接"));
                }}
              >
                复制链接
              </button>
              {preview && (
                <button onClick={() => setKey((n) => n + 1)}>
                  <RefreshCw size={14} />
                  重新加载
                </button>
              )}
              <button
                onClick={async () => {
                  if (!preview) {
                    try {
                      setW(await api(`/works/${id}`));
                    } catch (e) {
                      notify((e as Error).message);
                      return;
                    }
                  }
                  setPreview(!preview);
                }}
              >
                {preview ? "关闭预览" : "打开交互预览"}
              </button>
            </div>
          </div>
          <div className="preview-stage">
            {preview && w.previewUrl ? (
              <iframe
                key={key}
                title={`${w.title}交互预览`}
                src={w.previewUrl}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            ) : (
              <>
                {w.coverUrl && <img src={w.coverUrl} alt={w.title} />}
                <button
                  className="button dark preview-start"
                  disabled={!w.previewUrl}
                  onClick={() => setPreview(true)}
                >
                  <Code2 size={18} />
                  开始体验作品
                </button>
              </>
            )}
          </div>
          <div className="detail-copy">
            <section>
              <h2>关于这个灵感</h2>
              <p>{w.description}</p>
            </section>
            <section>
              <h2>创作提示词</h2>
              <p className="prompt-block">{w.prompt}</p>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
