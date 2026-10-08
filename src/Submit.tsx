import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ClipboardEvent,
} from "react";
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
import {
  type Work,
  type Competition,
  type AutoCover,
  statusNames,
} from "./types";
import {
  pastedFile,
  htmlFile,
  validateUploadFile,
  type UploadKind,
} from "./uploads";
import { ErrorBox, Loading, Modal } from "./ui";
import { GuideButton, usePageGuide } from "./Guide";
import { mineGuide, submitGuide } from "./guides";
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
    coverMode: "auto" as "auto" | "manual",
    htmlId: null as string | null,
    version: 1,
  });
  const [cover, setCover] = useState<File | null>(null);
  const [html, setHtml] = useState<File | null>(null);
  const [autoCover, setAutoCover] = useState<AutoCover | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [transfers, setTransfers] = useState({ html: "", cover: "" });
  const [failed, setFailed] = useState({ html: false, cover: false });
  const [pasteOpen, setPasteOpen] = useState(false);
  const [source, setSource] = useState("");
  const [published, setPublished] = useState(false);
  const operations = useRef({ html: 0, cover: 0 });
  const controllers = useRef<{
    html?: AbortController;
    cover?: AbortController;
    save?: AbortController;
    auto?: AbortController;
  }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [loaded, setLoaded] = useState(!id);
  const [saveId, setSaveId] = useState(id);
  const [confirm, setConfirm] = useState(false);
  usePageGuide(
    submitGuide(
      competition,
      user,
      !user || (loaded && !busy && !transfers.html && !transfers.cover),
      published,
    ),
  );
  useEffect(() => {
    return () => {
      operations.current.html++;
      operations.current.cover++;
      Object.values(controllers.current).forEach((controller) =>
        controller?.abort(),
      );
    };
  }, [id, user?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(!id);
    setSaveId(id);
    setForm({
      title: "",
      description: "",
      model: "",
      prompt: competition.prompt,
      track: "classic",
      coverId: null,
      htmlId: null,
      coverMode: "auto",
      version: 1,
    });
    setHtml(null);
    setCover(null);
    setAutoCover(null);
    setManualUrl(null);
    setTransfers({ html: "", cover: "" });
    setFailed({ html: false, cover: false });
    setPublished(false);
    setBusy(false);
    setError("");
    setProgress("");
    setConfirm(false);
    setPasteOpen(false);
    setSource("");
    if (!id) return;
    api<Work>(`/works/${id}`, { signal: controller.signal })
      .then((w: Work) => {
        if (controller.signal.aborted) return;
        setForm({
          title: w.title,
          description: w.description,
          model: w.model,
          prompt: w.prompt,
          track: w.track,
          coverId: w.coverId,
          coverMode: w.coverMode,
          htmlId: w.htmlId,
          version: w.version,
        });
        setPublished(w.status === "approved");
        if (w.coverMode === "manual") setManualUrl(w.coverUrl);
        const sequence = operations.current.html;
        if (w.coverMode === "auto" && w.coverId && w.coverUrl)
          setAutoCover({
            id: w.coverId,
            url: w.coverUrl,
            status: w.coverStatus || "pending",
          });
        if (w.htmlId)
          void api<AutoCover>(`/uploads/${w.htmlId}/cover`, {
            signal: controller.signal,
          })
            .then((cover) => {
              if (
                !controller.signal.aborted &&
                sequence === operations.current.html
              )
                setAutoCover(cover);
            })
            .catch(() => {});
        setLoaded(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id, user?.id]);
  useEffect(() => {
    if (!form.htmlId || autoCover?.status !== "pending") return;
    const controller = new AbortController();
    const sequence = operations.current.html;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<AutoCover>(`/uploads/${form.htmlId}/cover`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || sequence !== operations.current.html)
          return;
        setAutoCover(result);
        if (result.status !== "pending") return;
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [form.htmlId, autoCover?.status, user?.id]);

  async function selectFile(file: File, kind: UploadKind) {
    try {
      validateUploadFile(file, kind);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    controllers.current[kind]?.abort();
    if (kind === "html") controllers.current.auto?.abort();
    const controller = (controllers.current[kind] = new AbortController());
    const sequence = ++operations.current[kind];
    if (kind === "html") setHtml(file);
    else setCover(file);
    setError("");
    setFailed((f) => ({ ...f, [kind]: false }));
    setTransfers((t) => ({ ...t, [kind]: "0%" }));
    try {
      const result = await upload(
        file,
        (p) => {
          if (sequence === operations.current[kind])
            setTransfers((t) => ({ ...t, [kind]: `${p}%` }));
        },
        controller.signal,
      );
      if (sequence !== operations.current[kind] || controller.signal.aborted)
        return;
      if (result.kind !== kind) throw new Error("上传文件类型与所选位置不一致");
      if (kind === "html") {
        if (!result.autoCover) throw new Error("自动封面响应异常，请重试");
        const generated = result.autoCover;
        setAutoCover(generated);
        setForm((f) => ({
          ...f,
          htmlId: result.id,
          coverId: f.coverMode === "auto" ? generated.id : f.coverId,
        }));
      } else {
        setManualUrl(`/media/${result.id}`);
        setForm((f) => ({ ...f, coverId: result.id, coverMode: "manual" }));
      }
    } catch (e) {
      if (sequence === operations.current[kind] && !controller.signal.aborted) {
        setFailed((f) => ({ ...f, [kind]: true }));
        setError((e as Error).message);
      }
    } finally {
      if (sequence === operations.current[kind])
        setTransfers((t) => ({ ...t, [kind]: "" }));
    }
  }
  function paste(e: ClipboardEvent, kind: UploadKind) {
    e.preventDefault();
    if (busy) return;
    try {
      void selectFile(pastedFile(e.clipboardData, kind), kind);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function useAutomaticCover() {
    controllers.current.cover?.abort();
    operations.current.cover++;
    setCover(null);
    setManualUrl(null);
    setTransfers((t) => ({ ...t, cover: "" }));
    setFailed((f) => ({ ...f, cover: false }));
    setError("");
    setForm((f) => ({
      ...f,
      coverMode: "auto",
      coverId: autoCover?.id || null,
    }));
    if (form.htmlId && !autoCover) {
      await regenerateCover();
    }
  }
  async function regenerateCover() {
    if (!form.htmlId) return;
    controllers.current.auto?.abort();
    const controller = (controllers.current.auto = new AbortController());
    const sequence = operations.current.html;
    try {
      const cover = await api<AutoCover>(
        `/uploads/${form.htmlId}/cover/retry`,
        {
          method: "POST",
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || sequence !== operations.current.html)
        return;
      setAutoCover(cover);
      setForm((f) =>
        f.coverMode === "auto" ? { ...f, coverId: cover.id } : f,
      );
    } catch (e) {
      if (!controller.signal.aborted && sequence === operations.current.html)
        setError((e as Error).message);
    }
  }
  const uploading = !!(transfers.html || transfers.cover);
  const field = (key: string, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save(submit: boolean) {
    if (busy || uploading || failed.html || failed.cover) return;
    if (!user) {
      login();
      return;
    }
    setBusy(true);
    setError("");
    const controller = (controllers.current.save = new AbortController());
    try {
      setProgress("保存作品…");
      const w = await api<Work>(saveId ? `/works/${saveId}` : "/works", {
        body: JSON.stringify(form),
        method: saveId ? "PUT" : "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSaveId(w.id);
      setForm((f) => ({ ...f, version: w.version, coverId: w.coverId }));
      if (submit) {
        await api(`/works/${w.id}/submit`, {
          method: "POST",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        notify("作品已发布，已进入作品展区。");
        location.hash = `/work/${w.id}`;
      } else
        notify(
          published
            ? "作品已更新，继续在展区展示。"
            : "草稿已保存，可继续编辑或发布。",
        );
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setProgress("");
        setConfirm(false);
      }
    }
  }
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || uploading || failed.html || failed.cover) return;
    const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    if (action === "submit") {
      if (!form.htmlId) {
        setError("发布作品前，请上传或粘贴 HTML");
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
        <span className="eyebrow">1024 · 开启你的创作挑战</span>
        <h1>{id ? "打磨你的灵感" : "让你的超级创意，正式登场。"}</h1>
        <p className="muted">从一行提示词开始，让世界听见你的创意。</p>
        <GuideButton />
      </div>
      {!user ? (
        <div className="state">
          <Bird size={40} />
          <h3>先选一个身份，再开启创作</h3>
          <button
            className="button primary"
            onClick={login}
            data-guide="submit-login"
          >
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
                <h2>领取创作题目</h2>
              </div>
              <label data-guide="submit-prompt">
                统一提示词
                <textarea readOnly rows={3} value={competition.prompt} />
                <small>所有作品使用同一提示词，以 HTML + SVG 完成创作。</small>
              </label>
              <div className="form-step">
                <span>02</span>
                <h2>作品信息</h2>
              </div>
              <div className="guide-fields" data-guide="submit-info">
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
                  作品介绍 <small className="optional-label">选填</small>
                  <textarea
                    maxLength={3000}
                    rows={4}
                    placeholder="它有什么故事？可以怎样互动？"
                    value={form.description}
                    onChange={(e) => field("description", e.target.value)}
                  />
                </label>
                <label>
                  使用的模型 <small className="optional-label">选填</small>
                  <input
                    maxLength={100}
                    placeholder="例如：你使用的模型及版本"
                    value={form.model}
                    onChange={(e) => field("model", e.target.value)}
                  />
                </label>
              </div>
              <div className="form-step">
                <span>03</span>
                <h2>上传作品</h2>
              </div>
              <div className="upload-grid">
                <div className="upload-column" data-guide="submit-cover">
                  <label
                    className="upload-box"
                    tabIndex={0}
                    onPaste={(e) => paste(e, "cover")}
                    aria-label="封面粘贴区"
                  >
                    {(
                      form.coverMode === "auto" ? autoCover?.url : manualUrl
                    ) ? (
                      <img
                        className="upload-cover-preview"
                        src={
                          (form.coverMode === "auto"
                            ? autoCover?.url
                            : manualUrl)!
                        }
                        alt="作品封面预览"
                      />
                    ) : (
                      <ImagePlus size={30} />
                    )}
                    <strong>
                      {form.coverMode === "manual"
                        ? cover?.name || "自定义封面 · 可替换"
                        : autoCover
                          ? "HTML 自动封面"
                          : "作品封面 · 选填"}
                    </strong>
                    <small>点击选择或在此粘贴图片 · 最大 2MB</small>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      aria-label="上传封面"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void selectFile(f, "cover");
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <p className="help" aria-live="polite">
                    {transfers.cover
                      ? `上传封面 ${transfers.cover}`
                      : form.coverMode === "manual"
                        ? "JPEG / PNG / WebP · 使用你的自定义封面"
                        : autoCover?.status === "pending"
                          ? "自动封面准备中，当前封面可直接发布。"
                          : autoCover?.status === "fallback"
                            ? "当前使用占位封面，可直接发布，也可重新生成或上传图片。"
                            : autoCover
                              ? "已根据 HTML 生成封面。"
                              : "提供 HTML 后自动生成封面。"}
                  </p>
                  <div className="upload-actions">
                    {form.coverMode === "manual" || failed.cover ? (
                      <button
                        type="button"
                        className="button small"
                        onClick={useAutomaticCover}
                      >
                        使用自动封面
                      </button>
                    ) : null}
                    {failed.cover && cover && (
                      <button
                        type="button"
                        className="button small"
                        onClick={() => void selectFile(cover, "cover")}
                      >
                        重试封面上传
                      </button>
                    )}
                    {form.htmlId && autoCover?.status === "fallback" && (
                      <button
                        type="button"
                        className="button small"
                        onClick={() => void regenerateCover()}
                      >
                        重新生成封面
                      </button>
                    )}
                  </div>
                </div>
                <div className="upload-column" data-guide="submit-html">
                  <label
                    className="upload-box"
                    tabIndex={0}
                    onPaste={(e) => paste(e, "html")}
                    aria-label="HTML 粘贴区"
                  >
                    <FileCode2 size={30} />
                    <strong>
                      {html?.name ||
                        (form.htmlId
                          ? "HTML 已保存 · 可替换"
                          : "上传 HTML 文件")}
                    </strong>
                    <small>点击选择或在此粘贴 HTML · 最大 5MB</small>
                    <input
                      type="file"
                      accept=".html,.htm,text/html"
                      aria-label="上传 HTML 作品"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void selectFile(f, "html");
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <p className="help" aria-live="polite">
                    {transfers.html
                      ? `上传 HTML ${transfers.html}`
                      : failed.html
                        ? "HTML 上传失败，请重试。"
                        : form.htmlId
                          ? "HTML 已上传，保存和发布将复用该文件。"
                          : "完整 HTML 源码或单个 .html / .htm 文件"}
                  </p>
                  <div className="upload-actions">
                    <button
                      className="button small"
                      type="button"
                      onClick={() => setPasteOpen(true)}
                    >
                      粘贴 HTML
                    </button>
                    {failed.html && html && (
                      <button
                        className="button small"
                        type="button"
                        onClick={() => void selectFile(html, "html")}
                      >
                        重试 HTML 上传
                      </button>
                    )}
                  </div>
                </div>
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
                <button
                  className="button"
                  type="submit"
                  value="draft"
                  data-guide="submit-save"
                  disabled={uploading || failed.html || failed.cover}
                >
                  {published ? "保存更改" : "保存草稿"}
                </button>
                <button
                  className="button primary"
                  type="submit"
                  value="submit"
                  data-guide="submit-publish"
                  disabled={uploading || failed.html || failed.cover}
                >
                  {busy ? "正在处理…" : "发布作品"}
                  <ArrowUpRight size={18} />
                </button>
              </div>
            </fieldset>
          </form>
          <aside className="submit-guide">
            <span className="eyebrow">CREATOR GUIDE / 创作指南</span>
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
              <p>作品发布后直接进入展区。</p>
            </div>
            <div>
              <Check size={18} />
              <p>介绍、模型与封面可选填，HTML 自动生成封面。</p>
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
              发布后作品将直接进入展区。请确认你有权发布该作品，且文件不依赖外部网络。
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
                {busy ? progress || "发布中…" : "确认发布"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pasteOpen && (
        <Modal title="粘贴 HTML 源码" wide onClose={() => setPasteOpen(false)}>
          <div className="form">
            <label>
              完整 HTML 页面
              <textarea
                className="html-source-input"
                rows={12}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="<!doctype html>…"
                autoFocus
              />
            </label>
            <p className="help">最大 5MB，需包含内嵌 SVG 图形。</p>
            <button
              className="button primary"
              disabled={!source.trim()}
              onClick={() => {
                try {
                  const file = htmlFile(source);
                  setPasteOpen(false);
                  setSource("");
                  void selectFile(file, "html");
                } catch (e) {
                  setError((e as Error).message);
                  setPasteOpen(false);
                }
              }}
            >
              使用这份 HTML
            </button>
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
  usePageGuide(mineGuide(user, !user || (!!items && !error && !busy), items));
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
      notify(type === "withdraw" ? "作品已撤回" : "作品已发布");
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
          <span className="eyebrow">MY CREATIONS / 我的创作记录</span>
          <h1>我的作品</h1>
          <p className="muted">从草稿到公开展示，记录你的每一步创作。</p>
        </div>
        <div className="heading-actions">
          <GuideButton />
          <a
            href="#/submit"
            className="button primary"
            data-guide="mine-create"
          >
            新建作品 <Plus size={17} />
          </a>
        </div>
      </div>
      {!user ? (
        <div className="state">
          <button
            className="button primary"
            onClick={login}
            data-guide="mine-login"
          >
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
                <span className={`status ${w.status}`} data-guide="mine-status">
                  {statusNames[w.status]}
                </span>
                <h2>{w.title}</h2>
                <p className="muted">
                  HTML + SVG · 版本 {w.version} · {w.votes} 票
                </p>
                {w.reason && (
                  <p className="review-reason">管理反馈：{w.reason}</p>
                )}
              </div>
              <div className="my-actions" data-guide="mine-edit">
                <a className="button small" href={`#/work/${w.id}`}>
                  <Eye size={15} />
                  预览
                </a>
                <a className="button small" href={`#/submit/${w.id}`}>
                  <Pencil size={15} />
                  编辑
                </a>
                {["draft", "withdrawn"].includes(w.status) && (
                  <button
                    className="button small primary"
                    disabled={busy}
                    data-guide="mine-publish"
                    onClick={() => void action(w, "submit")}
                  >
                    <Send size={15} />
                    发布
                  </button>
                )}
                {w.status === "approved" && (
                  <button
                    className="button small"
                    data-guide="mine-withdraw"
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
