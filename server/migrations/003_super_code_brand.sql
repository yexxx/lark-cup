UPDATE competition SET data=jsonb_set(data, '{title}', '"超级码力"'::jsonb) WHERE data->>'title'='百灵鸟杯';
UPDATE competition SET data=jsonb_set(data, '{tagline}', '"让灵感起飞，让码力集结"'::jsonb) WHERE data->>'tagline'='一只百灵鸟，无限种可能。';
UPDATE competition SET data=jsonb_set(data, '{description}', '"一段提示词，一只百灵鸟，一场创意冒险。用 AI 点亮灵感，与内源社区一起，创造属于你的超级作品。"'::jsonb) WHERE data->>'description'='用 AI，让想象自由鸣唱。一个主题，不同模型，创造属于你的百灵鸟世界。';
UPDATE tracks SET name='超级码力' WHERE id='classic' AND name='百灵鸟杯';
