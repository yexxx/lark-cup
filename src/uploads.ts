export type UploadKind = "html" | "cover";
export function validateUploadFile(file: File, kind: UploadKind) {
  if (kind === "html") {
    if (!/\.html?$/i.test(file.name))
      throw new Error("请选择 .html 或 .htm 文件");
    if (file.size > 5 * 1024 * 1024) throw new Error("HTML 不能超过 5MB");
  } else {
    if (
      !/image\/(jpeg|png|webp)/i.test(file.type) &&
      !/\.(jpe?g|png|webp)$/i.test(file.name)
    )
      throw new Error("封面支持 JPEG、PNG、WebP 图片");
    if (file.size > 2 * 1024 * 1024) throw new Error("封面不能超过 2MB");
  }
}
export function htmlFile(source: string) {
  if (
    !/<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(source) ||
    source.includes("\0")
  )
    throw new Error("请粘贴完整的 HTML 页面源码");
  const file = new File([source], "粘贴的作品.html", { type: "text/html" });
  validateUploadFile(file, "html");
  return file;
}
export function pastedFile(
  data: Pick<DataTransfer, "files" | "getData">,
  kind: UploadKind,
) {
  if (data.files.length > 1) throw new Error("每次请粘贴一个文件");
  if (data.files.length === 1) {
    const file = data.files[0];
    validateUploadFile(file, kind);
    return file;
  }
  if (kind === "html") {
    const source = data.getData("text/plain") || data.getData("text/html");
    if (source) return htmlFile(source);
  }
  throw new Error(
    kind === "html"
      ? "请粘贴 HTML 源码或 HTML 文件，也可点击选择文件"
      : "请粘贴截图或图片；浏览器无法读取的文件可点击选择",
  );
}
