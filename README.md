# 中国铁路全景 Railway Panorama

在可缩放的中国铁路网地图上，显示**任意时刻全部旅客列车**的位置：

- **实时**：打开即显示当前时刻（北京时间）所有在途列车，按车种着色，高缩放级别显示运行方向和车次号
- **任意时间点**：拖动时间轴或选择日期时间，查看过去/未来某一时刻的列车分布；支持 1×～3600× 快进播放
- **车次查询与回放**：搜索车次（如 `G1`），查看经停站时刻、当前状态和运行进度，一键**回放全程**（镜头跟随）
- **车站时刻**：点击或搜索车站（支持拼音首字母，如 `bjn`），查看当天经停车次及到发状态
- **站到站查询**：点顶栏「站到站」，或在搜索框输入“北京到上海”。输入城市名查该城市全部车站（与 12306 一致），输入“北京南站”只查这一站；结果可按车型筛选、按发车/到达/历时排序，直达少时自动给出换乘一次的方案（含同城换站）。点车次即可在地图上看它的位置、回放乘车区间。时刻来自已抓取的数据，余票和票价仍以 12306 为准
- **线路车流**：按线路日均通过列车数着色，一眼看出繁忙干线
- 深色/浅色主题、可分享链接（地址栏记录地图位置、时间和选中的车次）、手机可用

整个网站是纯静态页面，内置矢量底图，不依赖任何在线地图服务或 API Key。

> 项目当前附带一份来自 12306 与 OpenStreetMap 的**真实数据快照**，可直接运行。数据日期范围与更新时间以 `web/data/meta.json` 为准。
> 列车位置按时刻表推算；更新快照或生成演示数据的方法见下文，全程无需安装任何依赖。

---

## 快速开始

需要 **Node.js 18 或更高版本**（`node -v` 查看）。

```bash
cd railway-panorama
npm start
```

浏览器打开 <http://localhost:8080>。

> 不能直接双击 `web/index.html` 打开（浏览器会阻止读取本地数据文件），请用 `npm start` 或任意静态服务器。

---

## 生成真实数据

数据来自两个公开来源：

| 数据 | 来源 | 脚本 | 耗时（参考） |
|---|---|---|---|
| 铁路线、车站坐标 | OpenStreetMap（Overpass API） | `npm run fetch:osm` | 30 分钟–2 小时（取决于 Overpass 服务器负载） |
| 车站表、车次、经停时刻 | 中国铁路 12306 公开查询接口 | `npm run fetch:12306` | 7 天数据约 2–5 小时（每天 1.4 万多个车次；受 12306 限流影响，可随时 Ctrl+C 中断、续传） |
| 路网构建、车站匹配、径路计算 | 本地处理 | `npm run build` | 1–5 分钟 |

```bash
npm run diagnose       # 先自检：能否访问 12306 和 Overpass、返回格式是否正常
npm run fetch:osm      # 下载全国铁路线（分块下载，失败会自动细分重试）
npm run fetch:12306    # 从今天起 7 天的全部车次和经停时刻（可以和 fetch:osm 在两个终端里同时跑）
npm run build          # 生成 web/data/*.json
npm start
```

所有抓取脚本都**支持断点续传**：中途中断或失败后，重新运行同一条命令即可从断点继续，已下载的部分不会重复请求。

`fetch:12306` 抓经停时刻时会先抓今天开行的车次，所以不必等它全部跑完：随时可以另开一个终端运行 `npm run build && npm start` 预览（还没抓到时刻的车次暂不显示），之后再 build 一次即可更新。

### 常用参数

```bash
# 12306
npm run fetch:12306 -- --days 3                     # 只抓 3 天
npm run fetch:12306 -- --start 2026-10-01 --days 7  # 指定起始日期
npm run fetch:12306 -- --interval 1000              # 更慢、更稳（最小请求间隔，默认 400ms，最快约 2.5 次/秒；被限流时会自动放慢）
npm run fetch:12306 -- --sample 50                  # 只抓 50 个车次，先试跑
npm run fetch:12306 -- --steps list                 # 只做某几步：stations,list,timetable
npm run fetch:12306 -- --refresh-list               # 重新枚举已抓过日期的车次

# OpenStreetMap
npm run fetch:osm -- --overpass https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter   # 只用指定的服务器（diagnose 会列出哪些可用）
npm run fetch:osm -- --verbose                      # 显示每次重试、切换服务器的细节
npm run fetch:osm -- --only stations                # 只下载车站
npm run fetch:osm -- --force                        # 忽略已下载的分块，全部重下

# 构建
npm run build -- --max-dates 14                     # 最多使用最近 14 天的车次列表（默认）
npm run check                                       # 用前端同一套代码自检每个车次在各站的位置
node scripts/tools/check-osm.mjs                    # 只检查 OSM 路网：连通性、线路等级、主要干线里程（不需要 12306 数据）
```

### 更新数据

列车时刻会随调图、临客等变化。建议每周（或调图后）重新运行：

```bash
npm run update:data
```

经停时刻按 `train_no` 缓存，时刻不变的车次不会重复抓取，更新通常只需几分钟。铁路线变化较慢，偶尔 `npm run fetch:osm -- --force` 即可。

`update:data` 从北京时间当天起抓取 7 天车次，使用 1000ms 最小请求间隔，确认每日车次列表完整后再构建并运行数据自检。抓取失败或列表不完整时停止更新，保留网站原有快照。原始缓存保留在 `data/raw/`，不会提交到 Git。若新出现的车次较多，补抓经停时刻可能需要更久；失败后可重跑续传。更新完成后提交 `web/data/` 并推送即可发布新快照。

### 构建报告

`npm run build` 会生成 `data/build-report.json`，列出：

- 在 OpenStreetMap 中**找不到的车站**（按日均车次排序）—— 这些车站的位置按运行时刻沿线推算，网页上标注“推算”
- **可疑区间**：沿铁路网的径路比直线距离长很多，通常是 OSM 里线路缺失或没有连通
- **改为直线的区间**（implausible）：沿路网绕行过远、按时刻根本跑不完（多半是 OSM 缺了新线或连接线），网页上这段按直线移动
- **不连通区间**：两站在路网中不相连（如琼州海峡轮渡、OSM 中断开的支线）
- 时刻表中的异常数据

如果某个重要车站没匹配上，多半是 OSM 中该站名称不同（例如改名），可以在 OpenStreetMap 上补充 `name` / `old_name` 标签后重新下载。

按分块下载时会顺带下载到邻国（印度、俄罗斯、蒙古、朝鲜、越南等）边境附近的铁路，它们参与路网计算，但不会画到网站上；有车次经过的境外线路（如中老铁路老挝段）除外。

---

## 部署

`web/` 目录就是完整的网站，可以原样放到任何静态服务器上：Nginx、阿里云 OSS / 腾讯云 COS、GitHub Pages、Vercel、Netlify 等。
建议开启 gzip/brotli 压缩（JSON 数据压缩后约为原来的 1/4）。

### Git 与 GitHub Pages

项目使用 `main` 分支管理，`.gitignore` 排除原始数据、构建报告、本地截图、日志和环境变量文件。`.github/workflows/pages.yml` 会在 `main` 的网站文件更新时或手动触发时，校验数据并发布 `web/`，不需要在 GitHub 上抓取或重新构建铁路数据。

首次托管：

1. 在 GitHub 创建空仓库（使用免费 Pages 时创建公开仓库）。
2. 将本地项目推送到该仓库：

   ```bash
   git remote add origin https://github.com/<账号>/<仓库名>.git
   git push -u origin main
   ```

3. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
4. 在 **Actions → Deploy GitHub Pages** 手动运行一次，等部署成功后从 Pages 设置页打开网站。后续更新推送到 `main` 会自动部署。

工作流只上传 `web/`，站点资源和字形使用相对地址，支持 `https://<账号>.github.io/<仓库名>/` 子目录。配置依据 [GitHub Pages 官方工作流文档](https://docs.github.com/zh/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

Nginx 示例：

```nginx
server {
  listen 80;
  root /path/to/railway-panorama/web;
  gzip on;
  gzip_types application/json text/javascript text/css application/x-protobuf;
  location /data/ { add_header Cache-Control "no-cache"; }
}
```

---

## 工作原理

1. **路网**：把 OSM 中 `railway=rail`（不含站线、专用线、岔线）的线路在道岔/交汇点处断开，构建拓扑图；合并属性相同的碎片、简化几何（5 米容差），并自动补上 30 米以内的断头缺口。线路按 `highspeed`、`maxspeed`、`usage` 等标签分为高速、快速/城际、普速干线、支线等。
2. **车站匹配**：12306 站名与 OSM 车站名（去掉“站”字等后缀，并参考 `old_name`、`alt_name`）匹配；同名车站用车次中相邻车站的位置消歧；地铁站会被排除。
3. **径路**：每两个相邻停站之间在路网上做多源多汇 A* 搜索。车站吸附到附近多条线路上，高速动车组偏好高速线路，普速列车偏好普速线路，搜索上限参考两站间的运行时间。
4. **缺失车站**：OSM 中找不到的车站，先按运行时刻比例在径路上推算位置，再取各车次推算值的中位数。
5. **列车位置**：前端按图定时刻计算：停站期间停在车站；区间运行按“加速—匀速—减速”的速度曲线沿径路插值，并给出方向和估算速度。

因此网页显示的是**按时刻表推算的位置**，不是实时 GPS，晚点和临时停运不会反映出来。

### 数据文件（`web/data/`）

| 文件 | 内容 |
|---|---|
| `meta.json` | 数据日期范围、生成时间、统计 |
| `network.json` | 路网：每条边的等级、线名、日均车流、差分编码坐标（1e-5 度） |
| `stations.json` | 车站：名称、电报码、拼音、城市、坐标、定位方式、日均停靠车次 |
| `trains.json` | 车次：train_no、车次号、车种、开行日期、各站（车站、到、发、里程、径路区段） |
| `paths.json` | 径路区段：边序列（差分压缩编码） |
| `basemap/` | 内置底图（省界、国界、南海断续线、陆地、河湖、城市名） |

---

## 目录结构

```
railway-panorama/
├── web/                      # 网站（纯静态）
│   ├── index.html
│   ├── css/app.css
│   ├── js/
│   │   ├── main.js           # 界面与交互
│   │   ├── model.js          # 数据解码、时间换算、列车位置计算（无 DOM，可在 Node 中测试）
│   │   ├── map.js            # 底图样式与图层
│   │   ├── trains.js         # 列车图层（deck.gl）
│   │   └── data.js           # 数据加载
│   ├── vendor/               # MapLibre GL JS 5.24、deck.gl 9.4（本地化，无需 CDN）
│   ├── fonts/                # 地图标注字形（中文使用系统字体渲染）
│   └── data/                 # 网站数据（由 npm run build 生成）
├── scripts/
│   ├── fetch-osm.mjs         # 下载 OSM 铁路线与车站
│   ├── fetch-12306.mjs       # 抓取 12306 车站、车次、经停时刻
│   ├── build.mjs             # 数据处理
│   ├── build/                # 路网构建、车站匹配、径路计算
│   ├── diagnose.mjs          # 网络与接口自检
│   ├── serve.mjs             # 本地静态服务器（gzip）
│   ├── demo.mjs              # 一键生成演示数据
│   ├── mock/                 # 模拟 12306 / Overpass 接口与模拟数据生成器（用于离线测试整条流程）
│   ├── tools/                # 数据自检、底图生成
│   └── lib/                  # HTTP（限速/重试/Cookie）、几何、解析等工具
└── data/                     # 原始数据与构建报告（不需要提交到版本库）
```

全部脚本只用 Node.js 内置模块，**不需要 `npm install`**（`scripts/tools/build-basemap.mjs` 除外，它只在重新生成底图时才需要，底图已随项目提供）。

---

## 演示数据与离线测试

`npm run demo` 会：生成一个“模拟世界” → 启动本地模拟接口（URL 和返回格式与 12306 / Overpass 一致，并随机注入故障）→ 用真实的抓取脚本抓取 → 构建。整个过程约 1 分钟，可以用来验证整条数据流程。

模拟数据的车站名称和大致坐标取自公开数据集，车次号及始发终到取自历史车次表；线路走向、停站、时刻和开行规律为程序生成，**不代表真实运行情况**。

---

## 常见问题

**`npm run diagnose` 显示 12306 失败**
可能是网络无法访问、临时限流（等十几分钟再试）或需要代理。Node.js 的 `fetch` 默认不读取代理环境变量；Node 24+ 可以这样使用代理：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm run fetch:12306
```

**抓取 12306 时提示“连续失败 N 次，可能被限流”或大量“返回的不是 JSON”**
请求太快被 12306 临时限制了。脚本会自动处理：先暂停（1 分钟起，反复触发时加倍，最长 10 分钟），之后放慢请求，并记住被限流时的速度，以后不再超过它；持续正常一段时间后才会小心地加快。
进度行里的“这一轮约 N 次/秒”是实际速度。如果一直在暂停，可以按 Ctrl+C 停掉（进度会保存），过半小时再运行；或者手动放慢：`--interval 1500`。请合理使用，避免给 12306 造成压力。

**Overpass 很慢、超时或返回 504**
公共 Overpass 服务器负载高时经常返回 504，脚本会在同一台服务器上稍等再试、连不上的服务器自动停用 20 分钟，大的分块会自动拆小。进度行里有百分比和预计剩余时间。
`npm run diagnose` 会逐个测试各台 Overpass 服务器并给出可用列表，用 `--overpass` 只指定可用的几台会更快。
如果看到 406 Not Acceptable：这是 Overpass 拒绝了没有标识的请求，本项目的脚本都已带上专用的 User-Agent；自己写脚本访问时也要设置。

**构建时内存不足**
`npm run build` 默认给 Node 分配 6GB 堆内存；如果机器内存较小，可以运行 `node --max-old-space-size=4096 scripts/build.mjs`。

**某些车次不在地图上**
这些车次的停站在路网中能定位的少于 2 个（例如境外站、新开通车站尚未在 OSM 中标注）。车次仍可搜索，面板中会说明原因。

---

## 许可与致谢

- 铁路线与车站位置：© [OpenStreetMap](https://www.openstreetmap.org/copyright) 贡献者，以 ODbL 1.0 授权。网页已显示署名，公开发布时请保留。
- 车次与时刻：中国铁路 12306 公开查询接口。请遵守 12306 的使用条款，仅用于个人学习研究，不要用于商业用途或高频抓取。
- [MapLibre GL JS](https://maplibre.org/)（BSD-3-Clause）、[deck.gl](https://deck.gl/)（MIT）
- 地图字形：Noto Sans（SIL Open Font License，见 `web/fonts/OFL.txt`），来自 protomaps/basemaps-assets
- 底图：[cn-atlas](https://github.com/BarbarossaWang/cn-atlas)（省级/地级行政区划）、[Natural Earth](https://www.naturalearthdata.com/)（公有领域）、南海断续线（geojson.cn，来源：民政部全国行政区划信息查询平台）
- 演示数据种子：车站坐标来自公开数据集（listenzcc/China-rail-way-stations-data、epcm/TrainVis），仅用于生成演示数据
