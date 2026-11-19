# 世界地图数据

`world-map` 页面读取本目录下的地图数据，读不到时退回公网地址。数据由
`scripts/build-map-data.mjs` 生成，不需要手写。

## 目录结构

```
public/geo/
├── world.geojson            全球国界（每个要素一个国家，层级 country）
└── admin2/
    ├── index.json           下级行政区目录，页面靠它决定加载谁
    ├── CHN.geojson          中国地级市（367 个单元）
    ├── HKG.geojson          香港各区
    ├── MAC.geojson          澳门各区
    └── <ISO>.geojson        其他国家的下级行政区（层级由规划表决定）
```

## 统一细化程度

不同国家的 ADM2 含义差异极大：荷兰的 ADM2 是 344 个市镇（平均 121 km²），
德国的 ADM2 是 38 个行政专区（平均 9,380 km²）。如果直接混用，地图上会出现
一小片「碎片」贴着大片「色块」的情况。

所以这里用**平均单元面积**作为统一标准：

- 基准取中国地级市的平均面积：**≈ 26,000 km²/单元**（9.5M km² ÷ 367），
  也就是「一个省切成几块」的密度；
- 候选窗口为 `[基准/5, 基准×4.2]`，即约 5,200 ~ 109,000 km²；
- 每个国家在 ADM1/ADM2/ADM3/ADM4 里挑平均单元面积最接近基准的一级；
- 只有换级能带来明显改善时才换，单元数少于 5 个的层级不采用（国家本身很小除外）；
- 微型国家（整个国家还没一个目标单元大）直接用明显更粗的层级；
- 面积小于 100,000 km² 的国家直接用最粗的一级（ADM1），不再按面积匹配；
- 生成后会校验分块对国土的覆盖率：低于 80%（漏掉海外岛屿/湖泊）或高于 150%（重叠、含海域）
  的层级会被拒绝并保留原数据。

有些国家可以手动指定层级，不受上述规则约束。手动指定写在
[`scripts/map-granularity-pins.json`](../../scripts/map-granularity-pins.json) 里，例如：

```json
{
  "RUS": 1,
  "CHN": 2,
  "USA": 1
}
```

表示俄罗斯用 ADM1（83 个联邦主体）、中国用 DataV 的地级市（367 个），美国用 ADM1（56 个州），
即使它们偏离基准面积。删掉对应条目后再跑 `pnpm map:plan` 就会回到自动规划的结果。

规划结果写在 [`scripts/map-granularity.json`](../../scripts/map-granularity.json)，当前分布：

| 层级 | 国家数 | 例子 |
| --- | --- | --- |
| ADM1 | 148 | 德国 16 州、法国 13 大区、西班牙 19 自治区、波兰 16 省、俄罗斯 83 联邦主体、美国 56 州、印度 36 邦 |
| ADM2 | 34 | 中国 367 地级市、意大利 20 大区、加拿大 76 普查区、澳大利亚 547 个地方政府区、巴西 5,570 个市镇 |

总共 11,639 个单元、约 43 MB。115/182 个国家的平均单元面积落在基准的 0.2~5 倍区间内；
个别国家受数据本身限制无法落进窗口（例如英国只有 4 个构成国或 216 个郡两档、
巴西只有 27 个州或 5,570 个市镇两档），会保留现状并标记 `inBand: false`。

## 数据来源与许可

| 文件 | 来源 | 许可 | 说明 |
| --- | --- | --- | --- |
| `world.geojson` | [Natural Earth 50m admin_0](https://www.naturalearthdata.com/) | 公有领域 | 242 个国家，比原先的 110m 数据精细约 10 倍 |
| `admin2/CHN.geojson` | [阿里云 DataV areas_v3](https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json) | 免费、无需 key，但未标注开源许可 | 367 个地级市（`--china-level=county` 可切到 2,848 个区县） |
| `admin2/HKG.geojson`、`MAC.geojson` | 同上 | 同上 | 港澳各区 |
| `admin2/<ISO>.geojson` | [geoBoundaries gbOpen](https://www.geoboundaries.org/) | CC BY 4.0，**需要署名** | 层级见规划表，含义随国家而异 |

页面右下角已经标注了这三份数据来源，部署时请保留；商用场景请先确认 DataV 的授权情况。

## 怎么生成

```bash
pnpm map:data         # 国界 + 中国区县 + 港澳（约两分钟）
pnpm map:plan         # 重新计算各国该用哪一级，写入 scripts/map-granularity.json
pnpm map:granularity  # 按规划表下载并重建需要换级的国家（几分钟，可中断重跑）
pnpm map:audit        # 体检：层级、覆盖率、单元面积是否合理
pnpm map:data:all     # 兜底：把还没下载过的国家全部按 ADM2 抓下来
```

`pnpm map:audit` 会输出平均单元面积分布，并列出偏细/偏粗的国家；有硬错误时以非零码退出。

也可以直接调用脚本：

```bash
node scripts/build-map-data.mjs --world
node scripts/build-map-data.mjs --china --china-level=county
node scripts/build-map-data.mjs --granularity --only=JPN,KOR
node scripts/build-map-data.mjs --force
node scripts/build-map-data.mjs --index-only
```

脚本默认跳过已存在的文件，中断后重跑会接着下载；下载失败或覆盖率不足的国家会被
跳过并保留原数据，`admin2/index.json` 只收录真正生成成功的分块。

## 数据格式

必须是 GeoJSON `FeatureCollection`，每个要素是一个行政区：

- `geometry`：`Polygon` / `MultiPolygon`（`GeometryCollection` 也支持）
- `id`：国家用 ISO3（如 `CHN`），中国用 adcode（如 `440104`），其他国家用 `shapeID`
- `properties.name`：展示名称
- `properties.level`：`adm1` / `adm2` / `adm3`，页面据此判断层级
- `properties.parent`：上级名称
- 文件顶层 `canonical`：层级名（如 `Department`、`区县`），会显示在信息面板里

坐标已经做过 4 位小数量化与 Douglas-Peucker 简化（默认容差 0.003°，约 330 米），
中国区县使用 0.004°。

## 体积与提交

数据总量约 43 MB，因此 `.gitignore` 默认忽略了生成出来的 `world.geojson` 与
`admin2/`。如果部署环境不能联网生成，请先在本地跑脚本，再把数据一起打包或上传到
静态服务器。
