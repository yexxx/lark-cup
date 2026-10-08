export type GuideRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

/** Keep the card inside the viewport and reserve a separate area for the target. */
export function placeGuide(
  target: GuideRect,
  card: { width: number; height: number },
  viewport: GuideRect,
  mobile: boolean,
) {
  const margin = 12;
  const gap = 14;
  const left = viewport.left + margin;
  const top = viewport.top + margin;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const width = Math.min(card.width, right - left);
  const height = Math.min(card.height, bottom - top);
  const x = target.left;
  const y = target.top;
  const r = x + target.width;
  const b = y + target.height;
  let cardLeft = left;
  let cardTop = bottom - height;
  let holeBottom = cardTop - gap;
  let holeTop = top;
  let holeLeft = left;
  let holeRight = right;
  if (!mobile && r + gap + width <= right) {
    cardLeft = r + gap;
    cardTop = clamp(y + (target.height - height) / 2, top, bottom - height);
    holeBottom = bottom;
    holeRight = cardLeft - gap / 2;
  } else if (!mobile && x - gap - width >= left) {
    cardLeft = x - gap - width;
    cardTop = clamp(y + (target.height - height) / 2, top, bottom - height);
    holeBottom = bottom;
    holeLeft = cardLeft + width + gap / 2;
  } else if (!mobile && b + gap + height <= bottom) {
    cardLeft = clamp(x, left, right - width);
    cardTop = b + gap;
    holeBottom = cardTop - gap / 2;
  } else if (!mobile && y - gap - height >= top) {
    cardLeft = clamp(x, left, right - width);
    cardTop = y - gap - height;
    holeTop = cardTop + height + gap / 2;
    holeBottom = bottom;
  } else {
    cardLeft = mobile ? left : clamp(x, left, right - width);
  }
  const holeX = clamp(x - 5, holeLeft, holeRight);
  const holeY = clamp(y - 5, holeTop, holeBottom);
  return {
    card: { left: cardLeft, top: cardTop, width },
    hole: {
      left: holeX,
      top: holeY,
      width: Math.max(0, Math.min(r + 5, holeRight) - holeX),
      height: Math.max(0, Math.min(b + 5, holeBottom) - holeY),
    },
  };
}
