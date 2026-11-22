/**
 * 从一段文本里找出提到的国家名，供事件驱动页按需附加详细档案。
 *
 * 规则：
 * - NFKC 归一化，避免全角/半角差异；
 * - 长名优先，命中后从文本里挖掉，避免「刚果民主共和国」同时命中「刚果」；
 * - 不区分大小写，兼容英文/拉丁国名；
 * - 少于 2 个字符的名字不参与，避免单字误命中。
 */
export function matchCountryNamesInText(text: string, countryNames: readonly string[]): string[] {
  if (!text.trim()) {
    return []
  }

  const candidates = Array.from(
    new Set(countryNames.map((name) => name.trim()).filter((name) => name.length >= 2)),
  ).sort((a, b) => b.length - a.length)

  let remaining = text.normalize('NFKC').toLowerCase()
  const matched: string[] = []

  for (const name of candidates) {
    const needle = name.normalize('NFKC').toLowerCase()

    if (!remaining.includes(needle)) {
      continue
    }

    matched.push(name)
    remaining = remaining.split(needle).join('\u0000')
  }

  return matched
}
