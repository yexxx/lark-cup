# 超级码力：设计与实现

## 活动定位

超级码力 · 1024 程序员节内源社区活动。宣传语：让灵感起飞，让码力集结。沿用统一百灵鸟 HTML/SVG 创作题目、单赛道、审核、匿名展示、每日投票与榜单。

## 视觉与页面

用户提供的像素平台场景作为风格参考，提取天空蓝、金币黄、砖块橙、草地绿、彩虹城堡及飞行百灵鸟。桌面首屏使用一张连续的宽幅背景，标题与可操作元素独立渲染。手机使用同一风格的纵深场景，将活动信息置于浅色面板，保证标题、日期和入口完整可读。

- 首页：活动标识、配置驱动的名称／口号／简介、创作与浏览入口、独立投稿及投票状态、完整题目、复制提示词、三步参与指引。
- 展区：桌面侧栏加三列作品，中等宽度两列，手机单列。封面保留投稿原图；票数、筛选与匿名规则使用真实业务数据。
- 榜单：按服务端名次显示奖牌，同票同名次。路由切换时重新初始化展区／榜单，确保名次来自榜单响应。
- 投稿：领取题目、作品信息、上传作品三个步骤。编辑和新建路由独立初始化，反馈与后续操作在我的作品中相邻展示。
- 后台：统一品牌、控件及配色，表格采用内部滚动，适配窄屏。
- 交互：首页百灵鸟轻量飞行，声音默认关闭；提供暂停和音频开关，遵循减少动态效果偏好，离屏与后台标签页暂停。

样式由 `src/style.css` 提供基础布局，`src/arcade.css` 提供主题变量及活动组件。旧自然主题与旧飞行背景规则已清理。中文使用系统无衬线字体，图标复用现有 Lucide 库。

## 数据兼容

`003_super_code_brand.sql` 逐字段匹配旧默认名称、口号、介绍并替换为新品牌；用户自定义字段、赛程、奖项、作品、投票记录保持原值。品牌变更沿用现有 Competition 接口。1024 为主题标识，实际开放时间读取后台配置。

## 素材来源与制作提示

以下素材由内置 ImageGen 生成并保存到项目，图片用于活动装饰，作品内容继续采用原有 HTML/SVG。

- `public/pixel-panorama.png`：2098 × 749，桌面完整连续像素场景。
- `public/pixel-world.png`：1536 × 1024，手机场景。
- `public/pixel-lark.png`：1448 × 1086，透明底百灵鸟。

桌面最终提示：Recompose the reference into a single seamless ultrawide panoramic website hero background, 2.8:1 aspect. Crisp vibrant pixel art, blue sky, clouds, orange castle under rainbow fully visible in right quarter, floating brick platforms, golden coins, green pipes, mushrooms, continuous grass and brick ground along bottom. Left 55% nearly empty blue sky for live website text. Entire artwork one continuous scene edge to edge. No bird, text, logo or watermark.

手机场景提示：Production website background illustration, landscape 1536x1024. Crisp 16-bit pixel art, blue sky, white clouds, rainbow over a warm orange brick castle in upper right, floating platforms with coins, green pipes, mushrooms, grass and brick ground. Airy open blue sky on left for live content. No birds, text, logo or watermark.

百灵鸟提示：Original charming golden cream songbird / lark flying right, both wings spread, full bird including long tail and orange feet. Crisp authentic 16-bit pixel art, large pixel clusters, dark brown stepped outlines, warm gold and orange feathers, cream chest, expressive black eye and orange beak. Centered landscape 4:3 composition with small padding. Cheerful retro platform adventure style. Genuinely transparent alpha background, single bird only, no scenery, shadow, checkerboard, text, logos or watermark.

对照图：`super-code-comparison.png`。左侧为用户提供的风格参考，右侧为实际网页首屏；二者内容与比例各自保留，比较色彩、场景连续性和元素风格。页面截图见 `super-code-desktop.png` 与 `super-code-mobile.png`。
