// 国土相关类型定义
// 坐标以 [x, y] 表示（例如经度/纬度或纹理坐标，按使用场景解析）
export type Coordinate = [number, number]

// 区域：顺时针记录顶点坐标
export interface Area {
  vertices: Coordinate[]
}

// 国土数据：由若干个区域组成
export interface LandData {
  areas: Area[]
}

// 空的国土数据工厂
export const createEmptyLandData = (): LandData => ({ areas: [] })
