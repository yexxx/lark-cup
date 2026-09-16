import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  CheckCheck,
  Settings2,
  Users,
  Heart,
  History,
  Download,
  ArrowUpRight,
  Star,
  Eye,
} from "lucide-react";
import { api, send } from "./api";
import type { User } from "./auth";
import { type Competition, type Work, statusNames } from "./types";
import { ErrorBox, Loading, Modal, Pagination } from "./ui";
const sections = [
  ["works", "作品审核", CheckCheck],
  ["settings", "赛事设置", Settings2],
  ["users", "用户管理", Users],
  ["votes", "投票记录", Heart],
  ["audit", "操作日志", History],
] as const;
export function Admin({
  user,
  login,
  notify,
  competition,
  refreshCompetition,
}: {
  user: User | null;
  login: () => void;
  notify: (s: string) => void;
  competition: Competition;
  refreshCompetition: () => Promise<void>;
}) {
  const [tab, setTab] = useState("works");
  const [data, setData] = useState<any>(null);
  const [overview, setOverview] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("pending");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    title: string;
    url: string;
    method?: string;
    body?: any;
    reason?: boolean;
  } | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (user?.role !== "admin") return;
    setError("");
    setData(null);
    if (tab === "settings") return;
    let live = true;
    api(`/admin/${tab}?page=${page}&size=12&status=${status}`)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [tab, page, status, refresh, user]);
  useEffect(() => {
    if (user?.role === "admin")
      api("/admin/overview")
        .then(setOverview)
        .catch(() => {});
  }, [user, refresh]);
  const action = async (url: string, body: any, method = "POST") => {
    setBusy(true);
    try {
      await send(url, body, method);
      notify("操作已完成");
      setDialog(null);
      setReason("");
      setRefresh((n) => n + 1);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="container admin-page">
      <div className="detail-heading">
        <div>
          <span className="eyebrow">LARK JAM / CONTROL ROOM</span>
          <h1>赛事管理</h1>
        </div>
        <a href="#/gallery" className="text-button">
          查看前台 <ArrowUpRight size={16} />
        </a>
      </div>
      {!user || user.role !== "admin" ? (
        <div className="state">
          <LayoutDashboard size={40} />
          <h3>使用管理员身份进入管理后台</h3>
          <button className="button primary" onClick={login}>
            切换登录身份
          </button>
        </div>
      ) : (
        <>
          <div className="admin-stats">
            {[
              ["待审核", overview?.pending],
              ["全部作品", overview?.works],
              ["有效投票", overview?.votes],
              ["注册身份", overview?.users],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value ?? "—"}</strong>
              </div>
            ))}
          </div>
          <div className="admin-layout">
            <aside className="admin-nav">
              {sections.map(([id, label, Icon]) => (
                <button
                  key={id}
                  className={tab === id ? "selected" : ""}
                  onClick={() => {
                    setTab(id);
                    setPage(1);
                  }}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
              <div className="system-note">
                <span className="live-dot" /> 服务运行中
                <p>
                  动态请求 {overview?.inflight ?? 0} /{" "}
                  {overview?.maxInflight ?? 32}
                  <br />
                  上传 {overview?.activeUploads ?? 0} /{" "}
                  {overview?.maxUploads ?? 2}
                  <br />
                  进程内存 {overview?.memoryMB ?? "—"} MB
                </p>
              </div>
            </aside>
            <section className="admin-content">
              {tab === "settings" ? (
                <Settings
                  competition={competition}
                  notify={notify}
                  refresh={refreshCompetition}
                />
              ) : (
                <>
                  <div className="admin-toolbar">
                    <h2>{sections.find((s) => s[0] === tab)?.[1]}</h2>
                    <div>
                      {tab === "works" && (
                        <select
                          aria-label="按作品状态筛选"
                          value={status}
                          onChange={(e) => {
                            setStatus(e.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="all">全部状态</option>
                          {Object.entries(statusNames).map(([key, name]) => (
                            <option key={key} value={key}>
                              {name}
                            </option>
                          ))}
                        </select>
                      )}
                      {["works", "votes"].includes(tab) && (
                        <a
                          className="button small"
                          href={`/api/v1/admin/export/${tab}`}
                        >
                          <Download size={14} />
                          导出 CSV
                        </a>
                      )}
                    </div>
                  </div>
                  {error ? (
                    <ErrorBox
                      message={error}
                      retry={() => setRefresh((n) => n + 1)}
                    />
                  ) : !data ? (
                    <Loading />
                  ) : !data.items.length ? (
                    <div className="state">暂无记录</div>
                  ) : (
                    <>
                      {tab === "works" ? (
                        <div>
                          {data.items.map((w: Work) => (
                            <article key={w.id} className="review-card">
                              <div className="review-header">
                                <div>
                                  <span className={`status ${w.status}`}>
                                    {statusNames[w.status]}
                                  </span>
                                  <h3>{w.title}</h3>
                                  <p className="muted">
                                    #{w.number} · {w.ownerId} · v{w.version}
                                  </p>
                                </div>
                                <a
                                  className="button small"
                                  href={`#/work/${w.id}`}
                                >
                                  <Eye size={15} />
                                  预览
                                </a>
                              </div>
                              <p>{w.description}</p>
                              {w.reason && (
                                <p className="review-reason">{w.reason}</p>
                              )}
                              <div className="review-actions">
                                {w.status === "pending" && (
                                  <>
                                    <button
                                      className="button primary small"
                                      disabled={busy}
                                      onClick={() =>
                                        setDialog({
                                          title: `通过「${w.title}」？`,
                                          url: `/admin/works/${w.id}/review`,
                                          body: {
                                            decision: "approved",
                                            version: w.version,
                                            reason: "",
                                          },
                                        })
                                      }
                                    >
                                      审核通过
                                    </button>
                                    <button
                                      className="button small"
                                      onClick={() =>
                                        setDialog({
                                          title: "填写驳回原因",
                                          url: `/admin/works/${w.id}/review`,
                                          body: {
                                            decision: "rejected",
                                            version: w.version,
                                          },
                                          reason: true,
                                        })
                                      }
                                    >
                                      驳回修改
                                    </button>
                                  </>
                                )}
                                {w.status === "approved" && (
                                  <>
                                    <button
                                      className="button small"
                                      disabled={busy}
                                      onClick={() =>
                                        void action(
                                          `/admin/works/${w.id}`,
                                          { recommended: !w.recommended },
                                          "PATCH",
                                        )
                                      }
                                    >
                                      <Star size={14} />
                                      {w.recommended ? "取消推荐" : "设为推荐"}
                                    </button>
                                    <button
                                      className="button small"
                                      onClick={() =>
                                        setDialog({
                                          title: "下架作品",
                                          url: `/admin/works/${w.id}`,
                                          method: "PATCH",
                                          body: { withdraw: true },
                                          reason: true,
                                        })
                                      }
                                    >
                                      下架
                                    </button>
                                  </>
                                )}
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                {(tab === "users"
                                  ? ["身份", "名称", "角色", "状态", "操作"]
                                  : tab === "votes"
                                    ? [
                                        "作品",
                                        "用户",
                                        "投票时间",
                                        "状态",
                                        "操作",
                                      ]
                                    : ["操作", "执行人", "目标", "时间", "详情"]
                                ).map((t) => (
                                  <th key={t}>{t}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {data.items.map((row: any) => (
                                <tr key={row.id}>
                                  {tab === "users" ? (
                                    <>
                                      <td>{row.id}</td>
                                      <td>{row.name}</td>
                                      <td>
                                        {row.role === "admin"
                                          ? "管理员"
                                          : "参赛者"}
                                      </td>
                                      <td>
                                        {row.status === "active"
                                          ? "正常"
                                          : "已停用"}
                                      </td>
                                      <td>
                                        <button
                                          className="table-action"
                                          disabled={busy || row.id === user.id}
                                          onClick={() =>
                                            setDialog({
                                              title: `${row.status === "active" ? "停用" : "启用"}用户 ${row.name}？`,
                                              url: `/admin/users/${row.id}`,
                                              method: "PATCH",
                                              body: {
                                                status:
                                                  row.status === "active"
                                                    ? "disabled"
                                                    : "active",
                                              },
                                            })
                                          }
                                        >
                                          {row.status === "active"
                                            ? "停用"
                                            : "启用"}
                                        </button>
                                      </td>
                                    </>
                                  ) : tab === "votes" ? (
                                    <>
                                      <td>{row.title}</td>
                                      <td>{row.user_id}</td>
                                      <td>
                                        {new Date(
                                          row.created_at,
                                        ).toLocaleString("zh-CN", {
                                          timeZone: "Asia/Shanghai",
                                        })}
                                      </td>
                                      <td>
                                        {row.valid
                                          ? "有效"
                                          : `已作废：${row.void_reason}`}
                                      </td>
                                      <td>
                                        {row.valid && (
                                          <button
                                            className="table-action"
                                            onClick={() =>
                                              setDialog({
                                                title: "作废投票",
                                                url: `/admin/votes/${row.id}/void`,
                                                reason: true,
                                              })
                                            }
                                          >
                                            作废
                                          </button>
                                        )}
                                      </td>
                                    </>
                                  ) : (
                                    <>
                                      <td>{row.action}</td>
                                      <td>{row.actor_id}</td>
                                      <td
                                        className="truncate"
                                        title={row.target}
                                      >
                                        {row.target}
                                      </td>
                                      <td>
                                        {new Date(
                                          row.created_at,
                                        ).toLocaleString("zh-CN", {
                                          timeZone: "Asia/Shanghai",
                                        })}
                                      </td>
                                      <td>
                                        <details>
                                          <summary>查看</summary>
                                          <pre>
                                            {JSON.stringify(
                                              row.detail,
                                              null,
                                              2,
                                            )}
                                          </pre>
                                        </details>
                                      </td>
                                    </>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <Pagination
                        page={page}
                        pages={data.pages}
                        onChange={setPage}
                      />
                    </>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
      {dialog && (
        <Modal
          title={dialog.title}
          onClose={() => {
            if (!busy) {
              setDialog(null);
              setReason("");
            }
          }}
        >
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void action(
                dialog.url,
                { ...dialog.body, ...(dialog.reason ? { reason } : {}) },
                dialog.method,
              );
            }}
          >
            {dialog.reason ? (
              <label>
                操作原因
                <textarea
                  required
                  maxLength={1000}
                  rows={4}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            ) : (
              <p>确认后立即生效，并记录到操作日志。</p>
            )}
            <button disabled={busy} className="button primary">
              {busy ? "处理中…" : "确认操作"}
            </button>
          </form>
        </Modal>
      )}
    </main>
  );
}
const localTime = (value: string) => {
  const d = new Date(new Date(value).getTime() + 8 * 3600000);
  return d.toISOString().slice(0, 16);
};
function Settings({
  competition,
  notify,
  refresh,
}: {
  competition: Competition;
  notify: (s: string) => void;
  refresh: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    ...competition,
    dailyLimit: competition.nextDailyLimit ?? competition.effectiveDailyLimit,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="form settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await send("/admin/competition", form, "PUT");
          await refresh();
          notify("赛事设置已保存，投票额度次日生效。");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>赛事设置</h2>
      {[
        ["title", "赛事名称"],
        ["tagline", "展区标题"],
        ["description", "赛事简介"],
        ["prompt", "统一提示词"],
        ["rules", "赛事规则"],
        ["prizes", "奖项设置"],
      ].map(([id, label]) => (
        <label key={id}>
          {label}
          {["title", "tagline"].includes(id) ? (
            <input
              required
              value={(form as any)[id]}
              onChange={(e) => setForm({ ...form, [id]: e.target.value })}
            />
          ) : (
            <textarea
              required
              rows={4}
              value={(form as any)[id]}
              onChange={(e) => setForm({ ...form, [id]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="form-columns">
        {[
          ["submissionStart", "报名开始"],
          ["submissionEnd", "报名结束"],
          ["voteStart", "投票开始"],
          ["voteEnd", "投票结束"],
        ].map(([id, label]) => (
          <label key={id}>
            {label}（北京时间）
            <input
              type="datetime-local"
              required
              value={localTime((form as any)[id])}
              onChange={(e) => {
                if (e.target.value)
                  setForm({ ...form, [id]: e.target.value + ":00+08:00" });
              }}
            />
          </label>
        ))}
      </div>
      <label>
        每人每日票数
        <input
          type="number"
          required
          min={1}
          max={100}
          value={form.dailyLimit}
          onChange={(e) =>
            setForm({ ...form, dailyLimit: Number(e.target.value) })
          }
        />
        <small>
          当前额度 {competition.effectiveDailyLimit}{" "}
          票，修改后在北京时间次日零点生效。
        </small>
      </label>
      {error && <ErrorBox message={error} />}
      <button className="button primary" disabled={busy}>
        {busy ? "保存中…" : "保存赛事设置"}
      </button>
    </form>
  );
}
