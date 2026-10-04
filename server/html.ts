import { parse, defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";
import { fail } from "./domain.js";
/** Structural and complexity checks complement review and the preview sandbox. */
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
  const depth = new WeakMap<object, number>();
  let elements = 0;
  const checkDepth = (parent: object, child: object) => {
    const n = (depth.get(parent) || 0) + 1;
    if (n > 256) fail(400, "HTML 层级过深，最多支持 256 层");
    depth.set(child, n);
  };
  const document = parse<DefaultTreeAdapterMap>(source, {
    treeAdapter: {
      ...defaultTreeAdapter,
      createElement(...args) {
        if (++elements > 100000)
          fail(400, "HTML 元素过多，最多支持 100000 个元素");
        return defaultTreeAdapter.createElement(...args);
      },
      appendChild(parent, child) {
        checkDepth(parent, child);
        defaultTreeAdapter.appendChild(parent, child);
      },
      insertBefore(parent, child, reference) {
        checkDepth(parent, child);
        defaultTreeAdapter.insertBefore(parent, child, reference);
      },
      setTemplateContent(template, content) {
        checkDepth(template, content);
        defaultTreeAdapter.setTemplateContent(template, content);
      },
    },
  });
  let vectorShapes = 0;
  let rasterInSvg = false;
  const pending: { node: any; inSvg: boolean; depth: number }[] = [
    { node: document, inSvg: false, depth: 0 },
  ];
  while (pending.length) {
    const { node, inSvg, depth: level } = pending.pop()!;
    if (level > 256) fail(400, "HTML 层级过深，最多支持 256 层");
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
    for (const child of node.childNodes || [])
      pending.push({ node: child, inSvg: svg, depth: level + 1 });
    if (node.content)
      pending.push({ node: node.content, inSvg: svg, depth: level + 1 });
  }
  if (!vectorShapes)
    fail(400, "HTML 中需要包含真正的内嵌 SVG 图形，请用 SVG 绘制百灵鸟");
  if (rasterInSvg)
    fail(400, "请使用 SVG 矢量图形绘制百灵鸟，不要在 SVG 内嵌图片或 HTML 冒充");
  return source;
}
