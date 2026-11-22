import { describe, expect, it } from 'vitest'

import { extractJsonFromText } from '../ai-json'

const polishChange = [
  {
    国家名称: '波兰共和国',
    描述: '1947年议会选举中工人党主导的民主联盟以80.07%得票获胜，西方指其舞弊；工人党借此确立一党主导体制，镇压反对派与农民党，国内秩序趋稳但社会分裂加深，与美英关系恶化而苏联阵营内地位上升。',
    国家指标: {
      政治稳定: 23,
      经济发展: -2,
      国际影响: 30,
    },
    政治制度改变:
      '人民民主共和国，工人党主导的民主联盟在议会选举中获胜，一党主导体制确立，制宪议会将起草新宪法',
    校验: '政稳+5（政权控制加强但舞弊削弱合法性）、经济+3（政权稳定利于国有化与三年计划）、国际影响-2（西方谴责），幅度均在10点内，与原值18/-5/32衔接合理',
  },
]

describe('extractJsonFromText', () => {
  it('解析带嵌套 国家指标 的裸数组（本次报错场景）', () => {
    const text = JSON.stringify(polishChange, null, 2)
    const extracted = extractJsonFromText(text)

    expect(extracted).not.toBeNull()
    expect(JSON.parse(extracted as string)).toEqual(polishChange)
    expect(JSON.parse(extracted as string)[0].国家指标.政治稳定).toBe(23)
  })

  it('解析代码块，并忽略前后的说明文字', () => {
    const text = `好的，变更如下：\n\n\`\`\`json\n${JSON.stringify(polishChange)}\n\`\`\`\n\n请确认。`
    const extracted = extractJsonFromText(text)

    expect(extracted).not.toBeNull()
    expect(JSON.parse(extracted as string)).toEqual(polishChange)
  })

  it('解析正文中夹带的 JSON，并跳过前面无效的花括号', () => {
    const text = `示例不是 JSON：{不是 JSON}。结果是：${JSON.stringify(polishChange)}。结束。`
    const extracted = extractJsonFromText(text)

    expect(extracted).not.toBeNull()
    expect(JSON.parse(extracted as string)).toEqual(polishChange)
  })

  it('字符串里的括号和转义引号不会提前截断', () => {
    const payload = [
      {
        国家名称: '波兰共和国',
        描述: '他说：{"a": 1}，以及 "引号" 与反斜杠 \\。',
        国家指标: { 政治稳定: 23, 经济发展: -2, 国际影响: 30 },
      },
    ]
    const text = `说明如下：${JSON.stringify(payload)}`
    const extracted = extractJsonFromText(text)

    expect(extracted).not.toBeNull()
    expect(JSON.parse(extracted as string)).toEqual(payload)
  })

  it('没有完整 JSON 时返回 null', () => {
    expect(extractJsonFromText('这是一段普通叙述，没有变更。')).toBeNull()
    expect(extractJsonFromText('')).toBeNull()
    expect(extractJsonFromText('[{"国家名称":"波兰共和国"')).toBeNull()
  })
})
