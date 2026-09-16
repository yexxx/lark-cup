/** Native SVG source, shared by each demo HTML and its rasterized cover. */
export const demoDesigns = [
  {
    title: "林间来信",
    label: "A LETTER FROM THE FOREST",
    bg: "#e4ecd6",
    ink: "#355b45",
    light: "#c9dc9e",
    feather: "#a77546",
    belly: "#f3e4bc",
    variant: 0,
  },
  {
    title: "风起时，唱一首歌",
    label: "WHEN THE WIND SINGS",
    bg: "#c0ddd9",
    ink: "#205d65",
    light: "#ebf1ca",
    feather: "#b8814f",
    belly: "#fae9c7",
    variant: 1,
  },
  {
    title: "百灵鸟的夜间电台",
    label: "THE MIDNIGHT RADIO",
    bg: "#202f45",
    ink: "#dbdaa2",
    light: "#3b526d",
    feather: "#ca995e",
    belly: "#ffedbd",
    variant: 2,
  },
  {
    title: "把天空唱成一首诗",
    label: "POETRY IN FLIGHT",
    bg: "#f2e9d6",
    ink: "#8a633d",
    light: "#e2cfab",
    feather: "#ba8b57",
    belly: "#faf3dd",
    variant: 3,
  },
  {
    title: "风的频率",
    label: "THE FREQUENCY OF WIND",
    bg: "#254f49",
    ink: "#d6e5b9",
    light: "#47766a",
    feather: "#d2a46c",
    belly: "#f4e6bf",
    variant: 4,
  },
  {
    title: "日落前的最后一首歌",
    label: "ONE LAST SONG",
    bg: "#edbd8c",
    ink: "#804e46",
    light: "#f5d8a8",
    feather: "#a36c4d",
    belly: "#ffe6b2",
    variant: 5,
  },
  {
    title: "小鸟，也有大梦想",
    label: "A LITTLE BIG DREAM",
    bg: "#dbe7ed",
    ink: "#456b82",
    light: "#c5d9e4",
    feather: "#a6835d",
    belly: "#f8eccd",
    variant: 6,
  },
  {
    title: "你好，春天！",
    label: "HELLO, SPRING",
    bg: "#e9edc9",
    ink: "#617943",
    light: "#d1dfa8",
    feather: "#b18c4a",
    belly: "#fff1c8",
    variant: 7,
  },
];
export function demoSvg(d: (typeof demoDesigns)[number], animate: boolean) {
  const dark = d.variant === 2 || d.variant === 4;
  const stars = Array.from(
    { length: 16 },
    (_, i) =>
      `<circle cx="${50 + ((i * 83) % 510)}" cy="${60 + ((i * 37) % 210)}" r="${(i % 3) + 1}" fill="${d.ink}" opacity="${dark ? 0.4 : 0.15}"/>`,
  ).join("");
  const notes = Array.from(
    { length: 3 },
    (_, i) =>
      `<g opacity="${animate ? 0 : 0.8}" transform="translate(${403 + i * 24} ${125 - i * 23})"><path d="M0 0v22c-12-4-18 7-9 10 7 2 13-3 13-8V7l12-4V-3Z" fill="${d.ink}"/>${animate ? `<animate attributeName="opacity" values="0;1;0" dur="2.5s" begin="${i * 0.8}s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="400 160;${445 + i * 18} ${62 - i * 8}" dur="2.5s" begin="${i * 0.8}s" repeatCount="indefinite"/>` : ""}</g>`,
  ).join("");
  const scenery =
    d.variant === 3
      ? `<path d="M45 310H555M45 320H555M45 330H555M45 340H555" stroke="${d.ink}" opacity=".25"/>`
      : d.variant === 4
        ? Array.from(
            { length: 18 },
            (_, i) =>
              `<rect x="${50 + i * 29}" y="${325 - ((i * 19) % 55)}" width="8" height="${20 + ((i * 19) % 55)}" rx="4" fill="${d.light}"/>`,
          ).join("")
        : `<path d="M0 337 Q130 255 255 324 T600 305V420H0Z" fill="${d.light}"/><path d="M0 382 Q185 312 330 364 T600 344V420H0Z" fill="${d.ink}" opacity=".1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420" viewBox="0 0 600 420" role="img" aria-label="${d.title}：飞行中唱歌的百灵鸟"><rect width="600" height="420" fill="${d.bg}"/><rect x="18" y="18" width="564" height="384" rx="2" fill="none" stroke="${d.ink}" opacity=".22"/><text x="300" y="56" text-anchor="middle" font-family="monospace" font-size="12" letter-spacing="3" fill="${d.ink}">${d.label}</text>${stars}<circle cx="302" cy="190" r="${d.variant === 5 ? 117 : 106}" fill="${d.light}" opacity=".65"/>${scenery}<g id="lark" stroke="${d.ink}" stroke-width="1.5" stroke-linejoin="round">${animate ? '<animateTransform attributeName="transform" type="translate" values="-10 10;12 -10;-10 10" dur="3.6s" repeatCount="indefinite"/>' : ""}<path d="M269 235 143 290 224 279 189 311 288 256Z" fill="${d.feather}"/><path d="M289 228 C233 197 207 144 232 100 L257 145 256 93 280 154 288 117 311 207Z" fill="${d.feather}" opacity=".65"/><path d="M246 218 C263 187 308 179 340 189 C351 156 375 143 394 154 L398 138 408 155 425 146 421 168 C442 197 406 221 380 225 C357 276 281 287 250 260Z" fill="${d.feather}"/><path d="M262 236 C294 255 337 256 361 219 C374 202 387 198 402 201 C385 244 334 289 276 265Z" fill="${d.belly}" stroke="none"/><path d="M380 170 408 164" stroke-width="5" stroke="${d.belly}"/><circle cx="403" cy="179" r="5" fill="${d.ink}"/><circle cx="404" cy="177" r="1.7" fill="#fff"/><path d="M418 184 444 174 426 193Z" fill="#dda344"/><path d="M425 195 447 202 419 202Z" fill="#d5a14a"/><path d="M378 185 387 181M370 193 378 190" stroke="${d.ink}" opacity=".5"/><g>${animate ? '<animateTransform attributeName="transform" type="rotate" values="-12 292 206;30 292 206;-12 292 206" dur=".65s" repeatCount="indefinite"/>' : ""}<path d="M307 222 C265 211 227 157 205 86 C227 95 244 125 255 139 L242 73 C266 88 281 123 284 145 L287 96 C307 119 318 153 315 178 L329 143 C348 184 334 206 307 222Z" fill="${d.feather}"/><path d="M212 101 295 203M251 94 303 197M291 119 310 190" fill="none" stroke="${d.belly}" stroke-width="7" opacity=".55"/></g><path d="M323 265 313 282 329 278M341 259 338 274 352 268" fill="none" stroke-width="3"/></g>${notes}<text x="300" y="386" text-anchor="middle" font-family="monospace" font-size="9" letter-spacing="3" fill="${d.ink}">LARK JAM / SVG MOTION STUDY 0${d.variant + 1}</text></svg>`;
}
export function demoHtml(d: (typeof demoDesigns)[number]) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${d.title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${d.bg};font-family:system-ui,sans-serif;color:${d.ink}}main{width:min(860px,100%);text-align:center;padding:20px;box-sizing:border-box}svg{display:block;width:100%;height:auto}button{border:1px solid ${d.ink};padding:10px 18px;margin:12px 7px;background:transparent;color:inherit;font:inherit;cursor:pointer}p{font-size:12px;line-height:1.8}button:focus-visible{outline:3px solid currentColor;outline-offset:3px}</style></head><body><main>${demoSvg(d, true)}<button id="pause">暂停飞行</button><button id="sing">听百灵鸟唱歌 ♪</button><p id="status" aria-live="polite">${d.title} · 用矢量线条，记录一段飞行。</p></main><script>const svg=document.querySelector('svg');let paused=false;let ctx;document.querySelector('#pause').onclick=()=>{paused=!paused;paused?svg.pauseAnimations():svg.unpauseAnimations();document.querySelector('#pause').textContent=paused?'继续飞行':'暂停飞行'};document.querySelector('#sing').onclick=()=>{ctx=ctx||new AudioContext();ctx.resume();[0,.13,.28,.5].forEach((d,i)=>{let o=ctx.createOscillator(),g=ctx.createGain(),t=ctx.currentTime+d;o.frequency.setValueAtTime(1600+i*170,t);o.frequency.exponentialRampToValueAtTime(2900-i*80,t+.08);g.gain.setValueAtTime(.025,t);g.gain.exponentialRampToValueAtTime(.001,t+.14);o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+.15);o.onended=()=>{o.disconnect();g.disconnect()}});document.querySelector('#status').textContent='♪ 这一小段旋律，唱给你听。'};document.addEventListener('visibilitychange',()=>{document.hidden||paused?svg.pauseAnimations():svg.unpauseAnimations()});if(matchMedia('(prefers-reduced-motion: reduce)').matches)document.querySelector('#pause').click();</script></body></html>`;
}
