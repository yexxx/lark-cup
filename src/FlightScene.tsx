import { useEffect, useMemo, useRef, useState } from "react";
import { demoSvg, demoDesigns } from "../server/demo-art";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
export function FlightScene() {
  const vectorBird = useMemo(() => {
    const document = new DOMParser().parseFromString(
      demoSvg(demoDesigns[0], true),
      "image/svg+xml",
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="120 55 345 260">${document.getElementById("lark")!.outerHTML}</svg>`;
  }, []);
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const [paused, setPaused] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [visible, setVisible] = useState(true);
  const [sound, setSound] = useState(false);
  const [chirps, setChirps] = useState(0);
  useEffect(() => {
    const svg = root.current?.querySelector("svg") as SVGSVGElement | null;
    if (svg && "pauseAnimations" in svg) {
      if (paused || !visible) svg.pauseAnimations();
      else svg.unpauseAnimations();
    }
  }, [paused, visible]);
  useEffect(() => {
    const el = root.current!;
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(
      ([e]) => {
        intersecting = e.isIntersecting;
        update();
      },
      { threshold: 0.05 },
    );
    observer.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    if (!sound || paused || !visible) return;
    const sing = () => {
      const ctx = audio.current;
      if (!ctx || ctx.state !== "running") return;
      [0, 0.13, 0.29, 0.48].forEach((delay, i) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + delay;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(1600 + i * 210, start);
        oscillator.frequency.exponentialRampToValueAtTime(
          3100 - i * 150,
          start + 0.07,
        );
        oscillator.frequency.exponentialRampToValueAtTime(
          1700 + i * 100,
          start + 0.12,
        );
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.028, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.15);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
      });
    };
    sing();
    const timer = setInterval(sing, 3200);
    return () => clearInterval(timer);
  }, [sound, paused, visible, chirps]);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );
  const toggleSound = async () => {
    try {
      if (!audio.current) audio.current = new AudioContext();
      await audio.current.resume();
      setSound((v) => !v);
    } catch {
      setSound(false);
    }
  };
  return (
    <div
      ref={root}
      className={`scene flight-scene ${paused || !visible ? "motion-paused" : ""}`}
      aria-label="边飞边唱的百灵鸟"
    >
      <span className="scene-corner">在风里，自由鸣唱</span>
      <div className="flight-orbit">
        <button
          className="flying-lark"
          title="让百灵鸟唱一声"
          aria-label="让百灵鸟唱一声"
          onClick={() => {
            setChirps((n) => n + 1);
            if (!sound) void toggleSound();
          }}
        >
          <span
            className="vector-lark"
            dangerouslySetInnerHTML={{ __html: vectorBird }}
          />
          <span className="sing-note n1" aria-hidden="true">
            ♪
          </span>
          <span className="sing-note n2" aria-hidden="true">
            ♫
          </span>
          <span className="sing-note n3" aria-hidden="true">
            ♩
          </span>
        </button>
      </div>
      <div className="scene-label">
        <span>♪</span> 点击小鸟，听一段鸣唱
      </div>
      <div className="scene-controls">
        <button
          onClick={() => setPaused((v) => !v)}
          aria-label={paused ? "播放飞行动画" : "暂停飞行动画"}
          title={paused ? "继续飞行" : "暂停飞行"}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <button
          onClick={() => void toggleSound()}
          aria-label={sound ? "关闭鸟鸣" : "开启鸟鸣"}
          title={sound ? "关闭鸟鸣" : "开启鸟鸣"}
        >
          {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
      </div>
    </div>
  );
}
