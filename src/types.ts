export type Work = {
  id: string;
  number: number;
  title: string;
  description: string;
  model: string;
  prompt: string;
  track: "classic" | "open";
  status: string;
  reason: string;
  recommended: boolean;
  version: number;
  votes: number;
  coverId: string | null;
  htmlId: string | null;
  coverUrl: string | null;
  previewUrl?: string;
  ownerId?: string;
  rank?: number;
  createdAt: string;
  updatedAt: string;
};
export type Competition = {
  title: string;
  tagline: string;
  description: string;
  prompt: string;
  rules: string;
  prizes: string;
  submissionStart: string;
  submissionEnd: string;
  voteStart: string;
  voteEnd: string;
  dailyLimit: number;
  effectiveDailyLimit: number;
  nextDailyLimit: number | null;
  limitEffectiveDate: string | null;
};
export type Quota = {
  day: string;
  limit: number;
  classic: number;
  open: number;
  votedIds: string[];
};
export const statusNames: Record<string, string> = {
  draft: "草稿",
  pending: "待审核",
  approved: "已公开",
  rejected: "需修改",
  withdrawn: "已撤回",
};
