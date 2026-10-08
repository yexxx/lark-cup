import { useState, useEffect, useCallback, useRef } from "react";
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
  KeyRound,
} from "lucide-react";
import { api, send } from "./api";
import { authAdapter, type User } from "./auth";
import { sessionVersion, updateSession } from "./session";
import type { Work, Competition, Quota } from "./types";
import { Modal, Loading, ErrorBox, Pagination, formatDate } from "./ui";
import { SubmitPage, MyWorks } from "./Submit";
import { Admin } from "./Admin";
import { HomeIntro } from "./HomeIntro";
import { Gallery } from "./Gallery";
import { GuideButton, GuideProvider, useGuide, usePageGuide } from "./Guide";
import { detailGuide, loginGuide } from "./guides";

const navigate = (path: string) => {
  location.hash = path;
};
export function App() {
  return (
    <GuideProvider>
      <AppContent />
    </GuideProvider>
  );
}
function AppContent() {
  const { close: closeGuide } = useGuide();
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  const [user, setUser] = useState<User | null>(null);
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const currentUser = useRef<User | null>(null);
  const refreshSequence = useRef(0);
  const authChannel = useRef<BroadcastChannel | null>(null);
  const [info, setInfo] = useState<"rules" | "prizes" | "prompt" | null>(null);
  const [toast, setToast] = useState("");
  const [startupError, setStartupError] = useState("");
  const [mobile, setMobile] = useState(false);
  useEffect(
    () => closeGuide(false),
    [route, authRevision, authOpen, passwordOpen, info, closeGuide],
  );
  const notify = useCallback((text: string) => setToast(text), []);
  const applyUser = useCallback((u: User | null, force = false) => {
    const changed = currentUser.current?.id !== u?.id;
    currentUser.current = u;
    updateSession(u?.id || null, force);
    if (u) setAuthOpen(false);
    if (changed || force) {
      setQuota(null);
      setAuthRevision((n) => n + 1);
      setPasswordOpen(false);
    }
    setUser(u);
  }, []);
  const refreshUser = useCallback(
    async (force = false) => {
      const sequence = ++refreshSequence.current;
      const result = await authAdapter.currentUser();
      if (sequence === refreshSequence.current) applyUser(result.user, force);
    },
    [applyUser],
  );
  const announceUser = useCallback(
    (u: User | null) => {
      refreshSequence.current++;
      applyUser(u, true);
      authChannel.current?.postMessage({ type: "changed" });
    },
    [applyUser],
  );
  const logout = async () => {
    try {
      await authAdapter.logout();
      announceUser(null);
      setMobile(false);
      notify("已退出登录");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const loadQuota = useCallback(async () => {
    const version = sessionVersion();
    try {
      const next = await api<Quota>("/me/quota");
      if (version === sessionVersion()) setQuota(next);
    } catch {
      if (version === sessionVersion()) setQuota(null);
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
        await refreshUser();
      } catch (e) {
        setStartupError((e as Error).message);
      }
    })();
  }, [refreshCompetition, refreshUser]);
  useEffect(() => {
    const sync = () => {
      refreshSequence.current++;
      applyUser(null, true);
      void refreshUser(true).catch(() => {});
    };
    const focus = () => {
      void refreshUser().catch(() => {});
    };
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    const expired = () => {
      refreshSequence.current++;
      applyUser(null, true);
      setAuthOpen(true);
      notify("登录已过期，请重新登录");
    };
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("lark-auth");
    authChannel.current = channel;
    if (channel)
      channel.onmessage = (event) => {
        if (event.data?.type === "changed") sync();
      };
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", focus);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("lark:auth-expired", expired);
    window.addEventListener("lark:auth-changed", sync);
    return () => {
      refreshSequence.current++;
      channel?.close();
      authChannel.current = null;
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", focus);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("lark:auth-expired", expired);
      window.removeEventListener("lark:auth-changed", sync);
    };
  }, [applyUser, refreshUser, notify]);
  useEffect(() => {
    if (user) void loadQuota();
    else setQuota(null);
  }, [user, authRevision, loadQuota]);
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
      notify("投票成功！为好创意加一码力。");
      return true;
    } catch (e) {
      if ((e as Error).name !== "AbortError") notify((e as Error).message);
      return false;
    }
  };
  useEffect(() => {
    document.title = `${competition?.title || "超级码力"} · 1024 程序员节 · Relay 创造营`;
  }, [competition?.title]);
  const isHome = route === "/" || route === "/gallery";
  const hasGuide =
    isHome ||
    route === "/ranking" ||
    route === "/mine" ||
    /^\/work\/[^/]+$/.test(route) ||
    /^\/submit(?:\/[^/]+)?$/.test(route);
  return (
    <>
      <header className="header">
        <a href="#/" className="brand">
          <span className="brand-icon">
            <Code2 size={26} />
          </span>
          <strong>
            {competition?.title || "超级码力"}
            <span>1024 · 程序员节</span>
          </strong>
        </a>
        <nav className={mobile ? "nav open" : "nav"}>
          <a className={isHome ? "active" : ""} href="#/gallery">
            作品展区
          </a>
          <a className={route === "/ranking" ? "active" : ""} href="#/ranking">
            人气榜单 <ArrowUpRight size={14} />
          </a>
          <button onClick={() => setInfo("rules")}>活动规则</button>
          <button onClick={() => setInfo("prizes")}>奖项设置</button>
          {hasGuide && (
            <GuideButton
              disabled={!!startupError}
              beforeStart={() => setMobile(false)}
            />
          )}
          {mobile && user && (
            <button
              onClick={() => {
                setPasswordOpen(true);
                setMobile(false);
              }}
            >
              修改密码
            </button>
          )}
          {mobile && user && <button onClick={logout}>退出登录</button>}
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
                title="修改密码"
                aria-label="修改密码"
                onClick={() => setPasswordOpen(true)}
              >
                <KeyRound size={17} />
              </button>
              <button
                className="icon-button"
                title="退出登录"
                aria-label="退出登录"
                onClick={logout}
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
              home={route === "/"}
              key={`${authRevision}:${route === "/ranking" ? "ranking" : "gallery"}`}
              ranking={route === "/ranking"}
              quota={quota}
              user={user}
              competition={competition}
              vote={vote}
              login={() => setAuthOpen(true)}
              rules={() => setInfo("rules")}
            />
          ) : /^\/work\/[^/]+$/.test(route) ? (
            <WorkDetail
              key={`${authRevision}:${route}`}
              id={route.split("/")[2]}
              vote={vote}
              quota={quota}
              notify={notify}
              competition={competition}
              user={user}
            />
          ) : /^\/submit(?:\/[^/]+)?$/.test(route) ? (
            <SubmitPage
              key={`${authRevision}:${route}`}
              id={route.split("/")[2]}
              user={user}
              competition={competition}
              login={() => setAuthOpen(true)}
              notify={notify}
            />
          ) : route === "/mine" ? (
            <MyWorks
              key={authRevision}
              user={user}
              login={() => setAuthOpen(true)}
              notify={notify}
            />
          ) : route === "/admin" ? (
            <Admin
              key={authRevision}
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
          <Code2 size={25} />
          <strong>
            {competition?.title || "超级码力"}
            <span>1024 程序员节 · Relay 创造营</span>
          </strong>
        </a>
        <div>
          <a href="#/mine">我的作品</a>
          <button onClick={() => setInfo("rules")}>活动规则</button>
          {hasGuide && <GuideButton disabled={!!startupError} />}
          <a href="#/admin">管理后台</a>
          <span>SUPER CODE / 1024</span>
        </div>
      </footer>
      {authOpen && (
        <Login
          onClose={() => setAuthOpen(false)}
          onLogin={(u) => {
            announceUser(u);
            setAuthOpen(false);
            notify(`欢迎，${u.name}`);
          }}
        />
      )}
      {passwordOpen && user && (
        <ChangePassword
          onClose={() => setPasswordOpen(false)}
          onChanged={() => {
            announceUser(null);
            setAuthOpen(true);
            notify("密码已修改，请重新登录");
          }}
        />
      )}
      {info && competition && (
        <Modal
          title={
            info === "rules"
              ? "活动规则"
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
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  usePageGuide(loginGuide(register, busy));
  return (
    <Modal
      title="欢迎来到超级码力"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setError("");
          if (register && password !== confirmation) {
            setError("两次密码输入需要一致");
            return;
          }
          setBusy(true);
          try {
            const result = register
              ? await authAdapter.register(username, name, password)
              : await authAdapter.login(username, password);
            onLogin(result.user);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <GuideButton />
        <div className="segmented" data-guide="auth-mode">
          <button
            type="button"
            disabled={busy}
            className={!register ? "selected" : ""}
            onClick={() => {
              setRegister(false);
              setError("");
              setPassword("");
              setConfirmation("");
            }}
          >
            登录
          </button>
          <button
            type="button"
            disabled={busy}
            className={register ? "selected" : ""}
            onClick={() => {
              setRegister(true);
              setError("");
              setPassword("");
              setConfirmation("");
            }}
          >
            注册
          </button>
        </div>
        <div className="guide-fields" data-guide="auth-account">
          <label>
            用户名
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              pattern="[a-zA-Z0-9_-]{3,32}"
              maxLength={32}
              value={username}
              disabled={busy}
              onChange={(e) => setUsername(e.target.value)}
            />
            <small>
              3～32 位英文字母、数字、下划线或短横线，大小写统一处理。
            </small>
          </label>
          {register && (
            <label>
              显示姓名
              <input
                name="name"
                autoComplete="nickname"
                required
                maxLength={40}
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="guide-fields" data-guide="auth-password">
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              required
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
            <small>8～128 个字符，支持空格和中文。</small>
          </label>
          {register && (
            <label>
              确认密码
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                required
                value={confirmation}
                disabled={busy}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
          )}
        </div>
        {error && <ErrorBox message={error} />}
        {!register && (
          <p className="muted">忘记密码时，请联系赛事管理员重置。</p>
        )}
        <button
          disabled={busy}
          className="button primary"
          data-guide="auth-submit"
        >
          {busy ? "正在处理…" : register ? "注册并进入比赛" : "登录并进入比赛"}
          <ArrowRight size={18} />
        </button>
      </form>
    </Modal>
  );
}
function ChangePassword({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="修改密码"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setError("");
          if (newPassword !== confirmation) {
            setError("两次密码输入需要一致");
            return;
          }
          setBusy(true);
          try {
            await authAdapter.changePassword(currentPassword, newPassword);
            onChanged();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">修改后，所有设备需要使用新密码重新登录。</p>
        <label>
          当前密码
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            required
            disabled={busy}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            required
            disabled={busy}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <small>8～128 个字符，支持空格和中文。</small>
        </label>
        <label>
          确认新密码
          <input
            type="password"
            name="confirmation"
            autoComplete="new-password"
            required
            disabled={busy}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        {error && <ErrorBox message={error} />}
        <button className="button primary" disabled={busy}>
          {busy ? "正在修改…" : "修改密码"}
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
  competition,
  user,
}: {
  id: string;
  vote: (w: Work) => Promise<boolean>;
  quota: Quota | null;
  notify: (s: string) => void;
  competition: Competition;
  user: User | null;
}) {
  const [w, setW] = useState<Work | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  usePageGuide(detailGuide(w, competition, user, quota, !!w && !error));
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
      <a href="#/gallery" className="back-link" data-guide="detail-back">
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
                {w.model ? `使用 ${w.model} 创作 · ` : ""}
                {w.ownerId ? `作者 ${w.ownerId}` : "作者评选期间匿名"}
              </p>
            </div>
            <button
              className="button primary"
              data-guide="detail-vote"
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
                data-guide="detail-share"
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
                data-guide="detail-preview"
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
            {w.description && (
              <section>
                <h2>关于这个灵感</h2>
                <p>{w.description}</p>
              </section>
            )}
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
