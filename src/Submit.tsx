import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  UploadCloud,
  FileCode2,
  ImagePlus,
  Check,
  Plus,
  Pencil,
  Eye,
  Send,
  Undo2,
  Bird,
} from "lucide-react";
import { api, send, upload } from "./api";
import type { User } from "./auth";
import { type Work, type Competition, statusNames } from "./types";
import { ErrorBox, Loading, Modal } from "./ui";
export function SubmitPage({
  id,
  user,
  competition,
  login,
  notify,
}: {
  id?: string;
  user: User | null;
  competition: Competition;
  login: () => void;
  notify: (s: string) => void;
}) {
  const [form, setForm] = useState({
    title: "",
    description: "",
    model: "",
    prompt: competition.prompt,
    track: "classic",
    coverId: null as string | null,
    htmlId: null as string | null,
    version: 1,
  });
  const [cover, setCover] = useState<File | null>(null);
  const [html, setHtml] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [loaded, setLoaded] = useState(!id);
  const [saveId, setSaveId] = useState(id);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!id) return;
    api(`/works/${id}`)
      .then((w: Work) => {
        setForm({
          title: w.title,
          description: w.description,
          model: w.model,
          prompt: w.prompt,
          track: w.track,
          coverId: w.coverId,
          htmlId: w.htmlId,
          version: w.version,
        });
        setLoaded(true);
      })
      .catch((e) => {
        setError(e.message);
      });
  }, [id]);
  const field = (key: string, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save(submit: boolean) {
    if (!user) {
      login();
      return;
    }
    setBusy(true);
    setError("");
    try {
      let coverId = form.coverId,
        htmlId = form.htmlId;
      if (cover) {
        coverId = (await upload(cover, (p) => setProgress(`上传封面 ${p}%`)))
          .id;
        setForm((f) => ({ ...f, coverId }));
        setCover(null);
      }
      if (html) {
        htmlId = (await upload(html, (p) => setProgress(`上传 HTML ${p}%`))).id;
        setForm((f) => ({ ...f, htmlId }));
        setHtml(null);
      }
      setProgress("保存作品…");
      const w: Work = await send(
        saveId ? `/works/${saveId}` : "/works",
        { ...form, coverId, htmlId },
        saveId ? "PUT" : "POST",
      );
      setSaveId(w.id);
      setForm((f) => ({ ...f, version: w.version }));
      if (submit) {
        await send(`/works/${w.id}/submit`);
        notify("投稿成功！审核结果会显示在“我的作品”。");
        location.hash = "/mine";
      } else notify("草稿已保存，可继续编辑或提交审核。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress("");
      setConfirm(false);
    }
  }
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    if (action === "submit") {
      if (!(cover || form.coverId) || !(html || form.htmlId)) {
        setError("提交审核前，请上传封面和 HTML 文件");
        return;
      }
      setConfirm(true);
    } else void save(false);
  }
  return (
    <main className="container submit-page">
      <a href="#/gallery" className="back-link">
        ← 返回作品展区
      </a>
      <div className="page-heading">
        <span className="eyebrow">带着灵感，加入这片森林</span>
        <h1>{id ? "打磨你的灵感" : "让你的百灵鸟，飞进展区。"}</h1>
        <p className="muted">从一行提示词开始，让世界听见你的创意。</p>
      </div>
      {!user ? (
        <div className="state">
          <Bird size={40} />
          <h3>先选一个身份，再开启创作</h3>
          <button className="button primary" onClick={login}>
            登录并参赛
          </button>
        </div>
      ) : !loaded ? (
        <>{error ? <ErrorBox message={error} /> : <Loading />}</>
      ) : (
        <div className="submit-layout">
          <form className="form submission-form" onSubmit={onSubmit}>
            <fieldset disabled={busy}>
              <div className="form-step">
                <span>01</span>
                <h2>作品信息</h2>
              </div>
              <label>
                作品名称 <b>*</b>
                <input
                  required
                  maxLength={80}
                  placeholder="给你的灵感起个名字"
                  value={form.title}
                  onChange={(e) => field("title", e.target.value)}
                />
              </label>
              <label>
                作品介绍 <b>*</b>
                <textarea
                  required
                  maxLength={3000}
                  rows={4}
                  placeholder="它有什么故事？可以怎样互动？"
                  value={form.description}
                  onChange={(e) => field("description", e.target.value)}
                />
              </label>
              <label>
                使用的模型 <b>*</b>
                <input
                  required
                  maxLength={100}
                  placeholder="例如：你使用的模型及版本"
                  value={form.model}
                  onChange={(e) => field("model", e.target.value)}
                />
              </label>
              <label>
                统一提示词
                <textarea readOnly rows={6} value={competition.prompt} />
                <small>所有作品使用同一提示词，无需修改。</small>
              </label>
              <div className="form-step">
                <span>02</span>
                <h2>上传作品</h2>
              </div>
              <div className="upload-grid">
                <label className="upload-box">
                  <ImagePlus size={30} />
                  <strong>
                    {cover?.name ||
                      (form.coverId ? "封面已保存 · 可替换" : "上传作品封面")}
                  </strong>
                  <small>JPEG / PNG / WebP · 最大 2MB</small>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="上传封面"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f && f.size > 2 * 1024 * 1024) {
                        setError("封面不能超过 2MB");
                        e.target.value = "";
                        return;
                      }
                      setCover(f || null);
                    }}
                  />
                </label>
                <label className="upload-box">
                  <FileCode2 size={30} />
                  <strong>
                    {html?.name ||
                      (form.htmlId ? "HTML 已保存 · 可替换" : "上传 HTML 文件")}
                  </strong>
                  <small>单个 .html 文件 · 最大 5MB</small>
                  <input
                    type="file"
                    accept=".html,.htm,text/html"
                    aria-label="上传 HTML 作品"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f && f.size > 5 * 1024 * 1024) {
                        setError("HTML 不能超过 5MB");
                        e.target.value = "";
                        return;
                      }
                      setHtml(f || null);
                    }}
                  />
                </label>
              </div>
              <p className="help">
                提交 HTML 页面，百灵鸟使用内嵌 SVG
                绘制；所有内容包含在同一文件中，预览不访问外部网络。
              </p>
              {error && <ErrorBox message={error} />}
              <div aria-live="polite">
                {progress && (
                  <p className="upload-progress">
                    <UploadCloud size={16} />
                    {progress}
                  </p>
                )}
              </div>
              <div className="form-actions">
                <button className="button" type="submit" value="draft">
                  保存草稿
                </button>
                <button className="button primary" type="submit" value="submit">
                  {busy ? "正在处理…" : "提交审核"}
                  <ArrowUpRight size={18} />
                </button>
              </div>
            </fieldset>
          </form>
          <aside className="submit-guide">
            <span className="eyebrow">A NOTE TO CREATORS</span>
            <h2>
              好作品，
              <br />
              从一点不同开始。
            </h2>
            <p>
              同一段提示词，同一个起点。
              <br />用 SVG，让百灵鸟飞起来。
            </p>
            <div>
              <Check size={18} />
              <p>用统一提示词创作，提交 HTML + SVG 作品。</p>
            </div>
            <div>
              <Check size={18} />
              <p>审核通过后自动进入作品展区。</p>
            </div>
            <div>
              <Check size={18} />
              <p>修改已公开的作品后，需要重新提交审核。</p>
            </div>
            <span className="guide-note">CREATE SOMETHING ONLY YOU CAN.</span>
          </aside>
        </div>
      )}
      {confirm && (
        <Modal
          title="准备让灵感起飞？"
          onClose={() => !busy && setConfirm(false)}
        >
          <div className="prose">
            <p>
              提交后作品将进入审核。请确认你有权发布该作品，且文件不依赖外部网络。
            </p>
            <div className="form-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                继续编辑
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void save(true)}
              >
                {busy ? progress || "提交中…" : "确认提交"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
export function MyWorks({
  user,
  login,
  notify,
}: {
  user: User | null;
  login: () => void;
  notify: (s: string) => void;
}) {
  const [items, setItems] = useState<Work[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [withdraw, setWithdraw] = useState<Work | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) return;
    api("/me/works")
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  }, [user, refresh]);
  async function action(w: Work, type: string) {
    setBusy(true);
    try {
      await send(`/works/${w.id}/${type}`);
      notify(type === "withdraw" ? "作品已撤回" : "作品已提交审核");
      setWithdraw(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="container my-page">
      <div className="detail-heading">
        <div>
          <span className="eyebrow">MY LITTLE UNIVERSE</span>
          <h1>我的作品</h1>
          <p className="muted">每一份灵感，都有自己的生长轨迹。</p>
        </div>
        <a href="#/submit" className="button primary">
          新建作品 <Plus size={17} />
        </a>
      </div>
      {!user ? (
        <div className="state">
          <button className="button primary" onClick={login}>
            登录查看作品
          </button>
        </div>
      ) : error ? (
        <ErrorBox message={error} retry={() => setRefresh((n) => n + 1)} />
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="state">
          <Bird size={42} />
          <h3>这里，等着你的第一份作品</h3>
          <a href="#/submit" className="button">
            开始创作 <ArrowUpRight size={16} />
          </a>
        </div>
      ) : (
        <div className="my-list">
          {items.map((w) => (
            <article className="my-card" key={w.id}>
              {w.coverUrl ? (
                <img src={w.coverUrl} alt="" />
              ) : (
                <div className="my-placeholder">
                  <Bird />
                </div>
              )}
              <div>
                <span className={`status ${w.status}`}>
                  {statusNames[w.status]}
                </span>
                <h2>{w.title}</h2>
                <p className="muted">
                  HTML + SVG · 版本 {w.version} · {w.votes} 票
                </p>
                {w.reason && (
                  <p className="review-reason">审核反馈：{w.reason}</p>
                )}
              </div>
              <div className="my-actions">
                <a className="button small" href={`#/work/${w.id}`}>
                  <Eye size={15} />
                  预览
                </a>
                <a className="button small" href={`#/submit/${w.id}`}>
                  <Pencil size={15} />
                  编辑
                </a>
                {["draft", "rejected", "withdrawn"].includes(w.status) && (
                  <button
                    className="button small primary"
                    disabled={busy}
                    onClick={() => void action(w, "submit")}
                  >
                    <Send size={15} />
                    提交
                  </button>
                )}
                {["pending", "approved"].includes(w.status) && (
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() => setWithdraw(w)}
                  >
                    <Undo2 size={15} />
                    撤回
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {withdraw && (
        <Modal title="撤回这份作品？" onClose={() => setWithdraw(null)}>
          <div className="prose">
            <p>
              「{withdraw.title}
              」将从公开展区移除，已有票数保留。你可以在报名时间内重新提交。
            </p>
            <button
              disabled={busy}
              className="button primary"
              onClick={() => void action(withdraw, "withdraw")}
            >
              确认撤回
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
