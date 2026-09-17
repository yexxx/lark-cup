/** Match the server's inclusive activity windows. */
export function activityWindow(
  start: string,
  end: string,
  now: number,
): string {
  if (now < new Date(start).getTime()) return "未开始";
  if (now > new Date(end).getTime()) return "已结束";
  return "进行中";
}
