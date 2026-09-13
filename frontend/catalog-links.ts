// 仅把目录入口变成站内链接；不根据助手措辞推导业务动作，也不渲染任意 HTML。
export function catalogMessageParts(content: string) {
  const parts: { text: string; href?: string }[] = [];
  const pattern =
    /\[([^\]\r\n]+)\]\((\/catalog(?:\?kind=(?:prebuilt|part|monitor))?)\)/g;
  let start = 0;
  for (const match of content.matchAll(pattern)) {
    if (match.index > start)
      parts.push({ text: content.slice(start, match.index) });
    parts.push({ text: match[1]!, href: match[2]! });
    start = match.index + match[0].length;
  }
  if (start < content.length) parts.push({ text: content.slice(start) });
  return parts;
}
