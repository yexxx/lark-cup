import { parse } from "parse5";
import { fail } from "./domain.js";
/** A structural submission check, not a replacement for human review or the preview sandbox. */
export function validateHtml(data: Buffer) {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    fail(400, "HTML 必须使用 UTF-8 编码");
  }
  if (
    !/<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(source) ||
    source.includes("\0")
  )
    fail(400, "请上传完整的 UTF-8 HTML 页面");
  const document = parse(source);
  let vectorShapes = 0;
  let rasterInSvg = false;
  const visit = (node: any, inSvg = false) => {
    const svg = inSvg || node.tagName === "svg";
    if (
      svg &&
      [
        "path",
        "circle",
        "ellipse",
        "rect",
        "polygon",
        "polyline",
        "line",
        "use",
      ].includes(node.tagName)
    )
      vectorShapes++;
    if (svg && ["image", "foreignObject"].includes(node.tagName))
      rasterInSvg = true;
    for (const child of node.childNodes || []) visit(child, svg);
  };
  visit(document);
  if (!vectorShapes)
    fail(400, "HTML 中需要包含真正的内嵌 SVG 图形，请用 SVG 绘制百灵鸟");
  if (rasterInSvg)
    fail(400, "请使用 SVG 矢量图形绘制百灵鸟，不要在 SVG 内嵌图片或 HTML 冒充");
  return source;
}
