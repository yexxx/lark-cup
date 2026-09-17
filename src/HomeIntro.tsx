import { useEffect, useState } from "react";
import { ArrowUpRight, ArrowRight, Copy, Code2, Flag } from "lucide-react";
import { FlightScene } from "./FlightScene";
import type { Competition } from "./types";
import { formatDate } from "./ui";
import { activityWindow } from "./activity";
export function HomeIntro({
  competition,
  notify,
}: {
  competition: Competition;
  notify: (s: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const submission = activityWindow(
    competition.submissionStart,
    competition.submissionEnd,
    now,
  );
  const voting = activityWindow(
    competition.voteStart,
    competition.voteEnd,
    now,
  );
  return (
    <>
      <section className="adventure-hero" aria-labelledby="activity-title">
        <div className="adventure-content">
          <span className="event-kicker">
            <Code2 size={16} /> 1024 程序员节 · 内源社区活动
          </span>
          <h1 id="activity-title">{competition.title}</h1>
          <p className="event-tagline">{competition.tagline}</p>
          <p className="event-description">{competition.description}</p>
          <div className="adventure-actions">
            <a className="button primary" href="#/submit">
              开始创作 <ArrowUpRight size={18} />
            </a>
            <a className="button secondary" href="#/gallery">
              浏览作品 <ArrowRight size={18} />
            </a>
          </div>
          <div className="event-schedule">
            <span>
              <Flag size={14} /> 投稿{submission}
            </span>
            <span>投票{voting}</span>
          </div>
        </div>
        <FlightScene />
      </section>
      <div className="container adventure-brief">
        <section className="challenge-card" aria-labelledby="challenge-title">
          <div className="challenge-heading">
            <span className="eyebrow">THE CHALLENGE / 创作挑战</span>
            <h2 id="challenge-title">同一道题，无限种码力。</h2>
          </div>
          <div className="challenge-body">
            <p>{competition.prompt}</p>
            <div className="challenge-actions">
              <button
                className="text-button"
                onClick={() => {
                  navigator.clipboard
                    .writeText(competition.prompt)
                    .then(() => notify("提示词已复制"))
                    .catch(() => notify("请手动选择并复制提示词"));
                }}
              >
                <Copy size={15} />
                复制提示词
              </button>
              <span>
                投稿 {formatDate(competition.submissionStart)} —{" "}
                {formatDate(competition.submissionEnd)}
              </span>
            </div>
          </div>
        </section>
        <ol className="adventure-steps" aria-label="活动参与步骤">
          <li>
            <span className="step-number">01</span>
            <div>
              <strong>领取题目</strong>
              <p>复制统一提示词，准备出发</p>
            </div>
          </li>
          <li>
            <span className="step-number">02</span>
            <div>
              <strong>创作并提交</strong>
              <p>用 AI 创作，上传 HTML 与封面</p>
            </div>
          </li>
          <li>
            <span className="step-number">03</span>
            <div>
              <strong>展示与投票</strong>
              <p>审核通过后展示，为创意加油</p>
            </div>
          </li>
        </ol>
      </div>
    </>
  );
}
