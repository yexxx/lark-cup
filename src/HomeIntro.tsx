import { ArrowUpRight, Leaf, Copy, Feather } from "lucide-react";
import { FlightScene } from "./FlightScene";
import type { Competition } from "./types";
import { formatDate } from "./ui";
export function HomeIntro({
  competition,
  notify,
}: {
  competition: Competition;
  notify: (s: string) => void;
}) {
  return (
    <section className="nature-intro">
      <FlightScene />
      <div className="intro-overline">
        <Leaf size={14} />
        <span>百灵鸟杯 · AI 创作季</span>
      </div>
      <h1>
        给灵感<em>一双翅膀</em>
      </h1>
      <div className="prompt-card">
        <span className="prompt-card-label">
          <Feather size={16} /> 本期创作题目
        </span>
        <p>{competition.prompt}</p>
        <div>
          <button
            onClick={() => {
              navigator.clipboard
                .writeText(competition.prompt)
                .then(() => notify("提示词已复制"))
                .catch(() => notify("请手动选择并复制提示词"));
            }}
          >
            <Copy size={13} />
            复制提示词
          </button>
          <span>投稿至 {formatDate(competition.submissionEnd)}</span>
          <a href="#/submit">
            开始创作 <ArrowUpRight size={15} />
          </a>
        </div>
      </div>
      <span className="landscape-caption">
        小小的歌声，
        <br />
        也能飞过山谷。
      </span>
    </section>
  );
}
