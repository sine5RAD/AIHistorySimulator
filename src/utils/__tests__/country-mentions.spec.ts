import { describe, expect, it } from 'vitest'

import { matchCountryNamesInText } from '../country-mentions'

describe('matchCountryNamesInText', () => {
  it('匹配单个和多个国家名', () => {
    expect(matchCountryNamesInText('请分析中国', ['中国', '美国'])).toEqual(['中国'])
    expect(matchCountryNamesInText('中国和美国发生冲突', ['中国', '美国', '法国'])).toEqual([
      '中国',
      '美国',
    ])
    expect(matchCountryNamesInText('没有提到任何国家', ['中国', '美国'])).toEqual([])
  })

  it('长名优先，避免短名重复命中', () => {
    expect(
      matchCountryNamesInText('刚果民主共和国发生政变', ['刚果共和国', '刚果民主共和国']),
    ).toEqual(['刚果民主共和国'])
  })

  it('英文国名不区分大小写', () => {
    expect(matchCountryNamesInText('USA and china', ['USA', 'China'])).toEqual(['China', 'USA'])
  })

  it('忽略空白和单字名称', () => {
    expect(matchCountryNamesInText('中国', [' 中国 ', '', '中'])).toEqual(['中国'])
    expect(matchCountryNamesInText('', ['中国'])).toEqual([])
  })
})
