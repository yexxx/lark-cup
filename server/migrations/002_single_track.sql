UPDATE works SET track='classic';
UPDATE votes SET track='classic';
INSERT INTO daily_quotas(user_id,track,day,used) SELECT user_id,'classic',day,sum(used)::integer FROM daily_quotas GROUP BY user_id,day ON CONFLICT(user_id,track,day) DO UPDATE SET used=EXCLUDED.used;
DELETE FROM daily_quotas WHERE track='open';
DELETE FROM tracks WHERE id='open';
UPDATE tracks SET name='百灵鸟杯' WHERE id='classic';
UPDATE competition SET data=data || '{"prompt":"创建一个 HTML，内容是用 SVG 绘制一只飞行中唱歌的百灵鸟的 2D 动画。","rules":"单赛道，所有作品使用统一提示词。提交原创 AI 辅助 HTML 作品，百灵鸟必须使用内嵌 SVG 矢量图形绘制，不能使用图片冒充。作品需独立运行，不依赖外部网络。作品审核通过后进入展区，评选期间作者匿名。每日票数以页面显示额度为准，同一作品每天最多 1 票。禁止刷票，违规票经审核后作废。","prizes":"金羽奖 · 人气第一名\n银羽奖 · 人气第二名\n灵感奖 · 优秀创意作品\n具体奖品由主办方公布。"}'::jsonb WHERE id=1;

