# 蒙德斯科 3D 地图 · 前端托管

角色卡《蒙德斯科》的 3D 城市地图前端。原来嵌在聊天正文里，现在改成**独立悬浮窗**，静态资源全部通过 GitHub + jsDelivr 分发。

## 目录结构

```
index.html                          地图页（Cesium + OpenStreetMap 三维城市视图）
scripts/map-float-window.js         悬浮窗脚本（悬浮球 + 全屏面板 + iframe 宿主）
data-manifest.json                  三维数据分片清单（4 片，共 83,811 个要素）
data-1.json ... data-4.json         三维数据分片，每片 9–13 MB，均在 jsDelivr 单文件上限内
vladivostok-metro-planning.geojson  地铁规划数据 14 KB（地铁层当前关闭，METRO_ENABLED=false）
cesium/                             Cesium 1.116 运行时（Cesium.js / Widgets / Assets / Workers / ThirdParty）
.gitattributes                      禁止 Git 改写行尾与编码，保证 CDN 上字节与本地一致
```

## jsDelivr 地址

```
https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/index.html
https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/scripts/map-float-window.js
```

备用 CDN（jsDelivr 未覆盖到时可换）：

```
https://cdn.statically.io/gh/papa163165/mondstadt-3d-map@main/scripts/map-float-window.js
```

## 在 SillyTavern 里使用

角色卡里只需要放一行加载器存根（和参考卡 `悬浮球状态栏` 的做法一致）：

```js
import 'https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/scripts/map-float-window.js?v=1'
```

脚本会把悬浮球和面板注入到 ST 主窗口（先试 `window.parent`，失败退 `window.top`），正文里**不需要**任何占位符。

## 悬浮窗脚本

- **挂载**：`window.parent` → `window.top` → 自身，全部用 `try/catch` 包住；跨源取不到就退回自身。
- **注入**：纯 DOM。`document.createElement('style')` 插 CSS，所有类名与 id 统一 `mdsk-` 前缀，不用 Shadow DOM、不用 `srcdoc`。
- **悬浮球**：`position: fixed; top: 15%; right: 20px; z-index: 999999`，自己实现鼠标/触摸拖拽（不碰 ST 的 `movingUI`），拖动超过 4px 算拖拽、否则算点击。
- **面板**：`position: fixed` 全屏遮罩，`z-index: 999999999`，`backdrop-filter: blur(14px)`，`100vh` 后跟 `100dvh` 兜底。
- **面板内容**：iframe 指向 `index.html?embed=1`。iframe 只在第一次打开时创建，关闭面板时**保留不销毁**（地图首次加载要几十秒），重开时发 `tw:resize` 让 Cesium 重算画布。
- **持久化**：`localStorage`，键前缀 `mdsk:`，存面板开合（`mdsk:open`）和悬浮球坐标（`mdsk:ballPos`），全部 `try/catch`。
- **加载与错误提示**：打开即显示加载遮罩；iframe `load` 后文案改为"界面已载入，正在加载三维数据"；地图页发来 `tw:ready` 才收遮罩；70 秒没有就绪则疑似超时，先探测一次 URL 状态再给出可读错误和「重试」按钮。

### 公开 API（挂在宿主 window 上）

```js
window.MondstadtMap.open()                       // 打开面板
window.MondstadtMap.close()                      // 关闭面板
window.MondstadtMap.toggle()
window.MondstadtMap.isOpen() / isReady()         // 状态查询
window.MondstadtMap.reload()                     // 重建 iframe
window.MondstadtMap.setCharacters(list)          // 角色标记
window.MondstadtMap.flyTo(lon, lat, height, dur) // 相机飞行
window.MondstadtMap.getCamera(rid)               // 请求相机状态
window.MondstadtMap.findPlace(q, rid, limit)     // 地名基线查询
window.MondstadtMap.lastPick()                   // 最近一次地图取点 {lon,lat}
window.MondstadtMap.getMapUrl()                  // 当前 iframe 地址
window.MondstadtMap.send({type:'tw:xxx', ...})   // 原样透传给 iframe
window.MondstadtMap.on('pick', fn)               // 订阅事件，返回取消函数
```

### 事件（宿主 window 上的 CustomEvent，`detail` 为原始消息）

| 事件 | 触发 |
|---|---|
| `mdsk:ready` | 地图页加载完成 |
| `mdsk:error` | 地图页主动报错或本脚本判定超时/不可访问 |
| `mdsk:pick` | 用户在地图上点击取点 |
| `mdsk:place` | `findPlace` 的应答 |
| `mdsk:camera` | 相机状态应答 |
| `mdsk:open` / `mdsk:close` | 面板开合 |

### postMessage 协议

脚本在宿主 window 上监听，**只接受来源等于当前 iframe 的消息**，且 `type` 必须以 `tw:` 开头。

iframe → 宿主：`tw:ready {version, embed, metro, ok}`、`tw:error {stage, message}`、`tw:pick {lon,lat}`、`tw:place {rid, query, matches}`、`tw:camera {lon,lat,height,heading,pitch}`

宿主 → iframe：`tw:hello`、`tw:setCharacters {list}`、`tw:flyTo {lon,lat,height,duration}`、`tw:getCamera {}`、`tw:findPlace {q, rid, limit}`、`tw:resize`

### 覆盖配置

在宿主页面上先设好再加载脚本即可，无需改仓库：

```js
window.MDSK_MAP_BASE = 'http://localhost:8900/';   // 换地图源（本地调试用）
window.MDSK_MAP_URL  = 'https://…/index.html?embed=1'; // 完全指定地图地址
window.__MONDSTADT_MAP_CONFIG__ = { readyTimeoutMs: 120000 };
```

## 索引页（index.html）

相对原始 `vladivostok-metro-3d.html` 只做了三处改动，都是为了让外层面板能正确显示状态：

1. 新增 `announceError(stage, message)`，加载失败时向父窗口发 `tw:error`。
2. `tw:ready` 增加 `ok` 字段，数据加载失败时为 `false`。
3. 消息处理新增 `tw:resize` 分支，调用 `viewer.resize()`。

资源引用**没有改动**：`cesium/Cesium.js`、`cesium/Widgets/widgets.css`、`data-manifest.json`、`data-*.json` 都是相对路径，jsDelivr 按仓库目录树原样解析；OpenStreetMap 瓦片是外部服务，保持不动。

## 维护须知

- jsDelivr 单文件上限 **20 MB**，仓库总体积不影响单文件抓取。分片每个 12.6 MB 以内，安全。
- `@main` 有缓存，改完 push 后不会立即生效。稳妥做法是每次发布把 `?v=` 递增（脚本里 `CONFIG.version`）。
- 未纳入仓库：`vladivostok-osm2-semantic.geojson`（47 MB，超出 jsDelivr 单文件上限）。它只是分片清单加载失败时的兜底，正常情况下不会用到；如果索引页走到那条兜底路径会明确报错。
