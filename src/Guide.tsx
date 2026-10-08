import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, BookOpen, X } from "lucide-react";
import type { GuideStep, PageGuide } from "./guides";
import { placeGuide, type GuideRect } from "./guide-layout";
import { lockBodyScroll } from "./ui";

type Session = {
  guide: PageGuide;
  owner: string;
  opener: HTMLElement | null;
  restore: { current: boolean };
};
type GuideContextValue = {
  definition: PageGuide | null;
  register: (owner: string, definition: PageGuide | null) => void;
  unregister: (owner: string) => void;
  start: (opener: HTMLElement) => void;
  close: (restore?: boolean) => void;
};
const GuideContext = createContext<GuideContextValue | null>(null);
export function useGuide() {
  const context = useContext(GuideContext);
  if (!context) throw new Error("GuideProvider is required");
  return context;
}
export function usePageGuide(definition: PageGuide | null) {
  const { register, unregister } = useGuide();
  const owner = useId();
  const serialized = JSON.stringify(definition);
  useEffect(() => {
    register(owner, JSON.parse(serialized) as PageGuide | null);
  }, [owner, serialized, register]);
  useEffect(() => () => unregister(owner), [owner, unregister]);
}
export function guideTarget(anchor: string): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-guide="${CSS.escape(anchor)}"]`,
    ),
  ).find(
    (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden" &&
      !element.closest("[hidden]"),
  );
}
export function GuideProvider({ children }: { children: ReactNode }) {
  const [definitions, setDefinitions] = useState<Record<string, PageGuide>>({});
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const close = useCallback((restore = true) => {
    if (sessionRef.current) sessionRef.current.restore.current = restore;
    setSession(null);
  }, []);
  const register = useCallback(
    (owner: string, definition: PageGuide | null) => {
      setDefinitions((current) => {
        const next = { ...current };
        if (definition) next[owner] = definition;
        else delete next[owner];
        return next;
      });
    },
    [],
  );
  const unregister = useCallback((owner: string) => {
    setDefinitions((current) => {
      const next = { ...current };
      delete next[owner];
      return next;
    });
    if (sessionRef.current?.owner === owner) {
      sessionRef.current.restore.current = false;
      setSession(null);
    }
  }, []);
  const entry = Object.entries(definitions).sort(
    ([, a], [, b]) => (b.priority ?? 0) - (a.priority ?? 0),
  )[0];
  const definition = entry?.[1] ?? null;
  const start = (opener: HTMLElement) => {
    if (!entry || !definition?.ready) return;
    const steps = definition.steps.filter((step) => guideTarget(step.anchor));
    if (!steps.length) return;
    setSession({
      guide: { ...definition, steps },
      owner: entry[0],
      opener,
      restore: { current: true },
    });
  };
  return (
    <GuideContext.Provider
      value={{ definition, register, unregister, start, close }}
    >
      {children}
      {session && <GuideOverlay session={session} onClose={close} />}
    </GuideContext.Provider>
  );
}
export function GuideButton({
  beforeStart,
  disabled = false,
}: {
  beforeStart?: () => void;
  disabled?: boolean;
}) {
  const { definition, start } = useGuide();
  return (
    <button
      type="button"
      className="guide-entry"
      data-guide-entry
      disabled={disabled || !definition?.ready}
      onClick={(event) => {
        const opener = event.currentTarget;
        beforeStart?.();
        requestAnimationFrame(() => start(opener));
      }}
    >
      <BookOpen size={15} aria-hidden="true" /> 操作引导
    </button>
  );
}

const viewportRect = (): GuideRect => ({
  left: window.visualViewport?.offsetLeft ?? 0,
  top: window.visualViewport?.offsetTop ?? 0,
  width: window.visualViewport?.width ?? window.innerWidth,
  height: window.visualViewport?.height ?? window.innerHeight,
});
function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (
    let parent = element.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    if (
      /auto|scroll/.test(getComputedStyle(parent).overflowY) &&
      (parent instanceof HTMLDialogElement ||
        parent.scrollHeight > parent.clientHeight)
    )
      return parent;
  }
  return null;
}
function GuideOverlay({
  session,
  onClose,
}: {
  session: Session;
  onClose: (restore?: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const [steps, setSteps] = useState(session.guide.steps);
  const [stepId, setStepId] = useState(steps[0].id);
  const step = steps.find((item) => item.id === stepId) ?? steps[0];
  const index = steps.indexOf(step);
  const [layout, setLayout] = useState<ReturnType<typeof placeGuide> | null>(
    null,
  );
  const spacers = useRef(
    new Map<HTMLElement, { padding: string; scrollTop: number }>(),
  );
  const titleId = useId();
  const bodyId = useId();
  useLayoutEffect(() => {
    const d = dialog.current!;
    const scroll = { x: window.scrollX, y: window.scrollY };
    d.showModal();
    const unlockScroll = lockBodyScroll();
    return () => {
      d.close();
      unlockScroll();
      for (const [element, original] of spacers.current) {
        element.style.paddingBottom = original.padding;
        if (session.restore.current) element.scrollTop = original.scrollTop;
      }
      if (session.restore.current) {
        window.scrollTo(scroll.x, scroll.y);
        const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
        const opener = session.opener;
        const canRestore =
          opener?.isConnected &&
          opener.getClientRects().length &&
          (!modal || modal.contains(opener));
        const fallback = Array.from(
          (modal ?? document).querySelectorAll<HTMLElement>(
            "[data-guide-entry], .mobile-toggle",
          ),
        ).find((element) => element.getClientRects().length);
        (canRestore ? opener : fallback)?.focus({ preventScroll: true });
      }
    };
  }, [session]);
  useLayoutEffect(() => {
    const target = guideTarget(step.anchor);
    const panel = card.current!;
    const align = () => {
      const element = guideTarget(step.anchor);
      if (!element) return;
      const viewport = viewportRect();
      const height = panel.getBoundingClientRect().height;
      const container = scrollContainer(element) ?? document.body;
      if (!spacers.current.has(container)) {
        spacers.current.set(container, {
          padding: container.style.paddingBottom,
          scrollTop: container.scrollTop,
        });
        container.style.paddingBottom = `${parseFloat(getComputedStyle(container).paddingBottom) + Math.min(viewport.height / 2, 400) + 30}px`;
      }
      element.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      const rect = element.getBoundingClientRect();
      const stacked =
        window.innerWidth <= 600 ||
        (rect.right + 14 + panel.offsetWidth >
          viewport.left + viewport.width - 12 &&
          rect.left - 14 - panel.offsetWidth < viewport.left + 12);
      if (stacked) {
        const availableHeight = Math.max(40, viewport.height - height - 38);
        const desired =
          viewport.top + 12 + Math.max(0, (availableHeight - rect.height) / 2);
        const delta = rect.top - desired;
        if (container === document.body)
          window.scrollBy({ top: delta, behavior: "instant" });
        else container.scrollBy({ top: delta, behavior: "instant" });
      }
    };
    if (target) align();
    let frame = 0;
    const measure = () => {
      const available = session.guide.steps.filter((item) =>
        guideTarget(item.anchor),
      );
      if (!available.length) {
        onClose();
        return;
      }
      setSteps((current) =>
        current.map((item) => item.id).join() ===
        available.map((item) => item.id).join()
          ? current
          : available,
      );
      const element = guideTarget(step.anchor);
      if (!element) {
        const originalIndex = session.guide.steps.indexOf(step);
        setStepId(
          (
            available.find(
              (item) => session.guide.steps.indexOf(item) > originalIndex,
            ) ?? available[available.length - 1]
          ).id,
        );
        return;
      }
      const rect = element.getBoundingClientRect();
      const viewport = viewportRect();
      const next = placeGuide(
        rect,
        {
          width: Math.min(
            window.innerWidth <= 600 ? viewport.width - 24 : 360,
            viewport.width - 24,
          ),
          height: panel.getBoundingClientRect().height,
        },
        viewport,
        window.innerWidth <= 600,
      );
      setLayout((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    nextButton.current?.focus({ preventScroll: true });
    const resize = new ResizeObserver(() => {
      align();
      schedule();
    });
    resize.observe(panel);
    if (target) resize.observe(target);
    const mutation = new MutationObserver((records) => {
      if (records.some((record) => !dialog.current?.contains(record.target)))
        schedule();
    });
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-guide", "hidden", "class", "style", "open"],
    });
    const realign = () => {
      align();
      schedule();
    };
    window.addEventListener("resize", realign);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", realign);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", realign);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", realign);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [step, session, onClose]);
  const hole = layout?.hole;
  return createPortal(
    <dialog
      ref={dialog}
      className="guide-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        if (event.shiftKey && document.activeElement === buttons[0]) {
          event.preventDefault();
          buttons[buttons.length - 1]?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === buttons[buttons.length - 1]
        ) {
          event.preventDefault();
          buttons[0]?.focus();
        }
      }}
    >
      <svg
        className="guide-scrim"
        aria-hidden="true"
        width="100%"
        height="100%"
      >
        <defs>
          <mask id={`${titleId}-mask`}>
            <rect width="100%" height="100%" fill="white" />
            {hole && (
              <rect
                x={hole.left}
                y={hole.top}
                width={hole.width}
                height={hole.height}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="#10243bcc"
          mask={`url(#${titleId}-mask)`}
        />
        {hole && (
          <rect
            className="guide-highlight"
            x={hole.left}
            y={hole.top}
            width={hole.width}
            height={hole.height}
          />
        )}
      </svg>
      <section
        ref={card}
        className="guide-card"
        data-guide-step={step.id}
        style={
          layout
            ? {
                left: layout.card.left,
                top: layout.card.top,
                width: layout.card.width,
              }
            : { visibility: "hidden" }
        }
      >
        <div className="guide-card-head">
          <span>
            <BookOpen size={16} aria-hidden="true" /> {session.guide.title}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭操作引导"
            onClick={() => onClose()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="guide-copy" aria-live="polite" aria-atomic="true">
          <span className="guide-progress">
            操作引导 · {index + 1} / {steps.length}
          </span>
          <h2 id={titleId}>{step.title}</h2>
          <p id={bodyId}>{step.body}</p>
        </div>
        <div className="guide-controls">
          <button
            type="button"
            className="guide-skip"
            onClick={() => onClose()}
          >
            跳过
          </button>
          <button
            type="button"
            className="button small"
            aria-label="上一步"
            disabled={index === 0}
            onClick={() => setStepId(steps[index - 1].id)}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
          <button
            ref={nextButton}
            type="button"
            className="button small primary"
            onClick={() =>
              index === steps.length - 1
                ? onClose()
                : setStepId(steps[index + 1].id)
            }
          >
            {index === steps.length - 1 ? "完成" : "下一步"}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </section>
    </dialog>,
    document.body,
  );
}
