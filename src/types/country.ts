export interface PopulationData {
  总数: number
  种族比例: Record<string, string>
}

export interface CityData {
  名称: string
  简介: string
  人口比例: Record<string, string>
  经济状况: string
  政治状况: string
}

export interface MilitaryData {
  名称: string
  规模: string
  兵役制度: string
  军种: string[]
}

export interface DefinitionData {
  术语: string
  定义: string
}

export interface PoliticalAllianceData {
  联盟名称: string
  政党: Party[]
}

export interface PoliticalData {
  政党: Party[]
  联盟: PoliticalAllianceData[]
  政治状况: Record<string, string>
}

export interface TechnologyData {
  重工业: string
  轻工业: string
  第三产业: string
  航天工业: string
  信息产业: string
  农业: string
}

export interface EthnicGroupData {
  名称: string
  简介: string
  文化: string
  宗教: string
}
export interface Party {
  名称: string
  简介: string
  主要人物: Record<string, string>//姓名，种族
}

export interface CountryData {
  国家名称: string
  人口: PopulationData
  政治制度: string
  经济状况: string
  城市: CityData[]
  国歌: string
  货币: string
  武装力量: MilitaryData
  武装力量法: string
  宗教信仰: string
  名词定义: DefinitionData[]
  政治: PoliticalData
  科技: TechnologyData
  种族: EthnicGroupData[]
}

export const createEmptyCountryData = (): CountryData => ({
  国家名称: '',
  人口: {
    总数: 0,
    种族比例: {},
  },
  政治制度: '',
  经济状况: '',
  城市: [],
  国歌: '',
  货币: '',
  武装力量: {
    名称: '',
    规模: '',
    兵役制度: '',
    军种: [],
  },
  武装力量法: '',
  宗教信仰: '',
  名词定义: [],
  政治: {
    政党: [],
    联盟: [],
    政治状况: {},
  },
  科技: {
    重工业: '',
    轻工业: '',
    第三产业: '',
    航天工业: '',
    信息产业: '',
    农业: '',
  },
  种族: [],
})

export const emptyCountryDataTemplate: CountryData = createEmptyCountryData()
