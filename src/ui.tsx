import { useEffect, useRef, type ReactNode } from "react";
import {
  X,
  ArrowLeft,
  ArrowRight,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
let scrollLocks = 0;
let previousOverflow = "";
/** Modal layers share one lock so closing a layer preserves the remaining dialogs. */
export function lockBodyScroll() {
  if (scrollLocks === 0) previousOverflow = document.body.style.overflow;
  scrollLocks++;
  document.body.style.overflow = "hidden";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
  };
}
export const formatDate = (s: string) =>
  new Date(s).toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  });
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    const unlockScroll = lockBodyScroll();
    return () => {
      d.close();
      unlockScroll();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Loading() {
  return (
    <div className="state">
      <LoaderCircle className="spin" size={26} />
      <p>正在收集灵感…</p>
    </div>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && <button onClick={retry}>重试</button>}
    </div>
  );
}
export function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (n: number) => void;
}) {
  return (
    <nav className="pagination" aria-label="分页">
      <button
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="上一页"
      >
        <ArrowLeft size={17} />
      </button>
      <span>
        {page} / {pages}
      </span>
      <button
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
        aria-label="下一页"
      >
        <ArrowRight size={17} />
      </button>
    </nav>
  );
}
