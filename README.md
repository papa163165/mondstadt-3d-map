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
tools/serve.py                      本地预览用静态服务器（带 CORS 头，见下文）
.gitattributes                      禁止 Git 改写行尾与编码，保证 CDN 上字节与本地一致
```

## 地址

```
悬浮窗脚本   https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/scripts/map-float-window.js?v=2
地图页       https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/index.html?embed=1&v=2
```

备用 CDN（jsDelivr 出问题时整体替换域名即可）：

```
https://cdn.statically.io/gh/papa163165/mondstadt-3d-map@main/scripts/map-float-window.js
```

## ⚠️ 关键约束：CDN 不把 .html 当网页下发

jsDelivr 出于防钓鱼策略，会把仓库里的 `.html` 文件以 **`text/plain`** 下发（实测 `content-type: text/plain; charset=utf-8`）。
后果：**`<iframe src="……/index.html">` 只会把 HTML 源码当纯文本显示**，页面不会被解析，Cesium 永远不会启动。
`cdn.statically.io` 同样如此；`raw.githubusercontent.com` 也是 `text/plain`。

所以悬浮窗**不能**直接把 iframe 指向地图页 URL，实际做法是：

1. `fetch()` 把 `index.html` 的**文本**取回来；
2. 在 `<head>` 后注入 `<base href="CDN 根目录/">`，让页内的相对引用（`cesium/Cesium.js`、`data-*.json`）仍然指向 CDN；
3. 再注入 `<script>window.__MDSK_EMBED__=true;window.__MDSK_PARAMS__="<原查询串>";</script>`
   （Blob URL 没有 query，`location.search` 会丢，所以把原查询串另外传进去）；
4. 用 `new Blob([...], {type:'text/html'})` + `URL.createObjectURL()` 得到 Blob URL，赋给 iframe。

副作用与要求：

- 地图宿主**必须允许跨域读取**（返回 `Access-Control-Allow-Origin`）。jsDelivr 返回 `*`，没问题；
  但 `python -m http.server` **不带**这个头，所以本地不能用它当地图源，请用 `tools/serve.py`。
- 因为 Blob 继承创建者页面的源，iframe 通常与宿主同源；但脚本不依赖这一点。

## 在 SillyTavern 里使用

角色卡里只需要放一行加载器存根（和参考卡 `悬浮球状态栏` 的做法一致）：

```js
import 'https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/scripts/map-float-window.js?v=2'
```

脚本会把悬浮球和面板注入到 ST 主窗口（先试 `window.parent`，失败退 `window.top`），正文里**不需要**任何占位符。

## 悬浮窗脚本

- **挂载**：`window.parent` → `window.top` → 自身，全部用 `try/catch` 包住；跨源取不到就退回自身。
- **注入**：纯 DOM。`document.createElement('style')` 插 CSS，所有类名与 id 统一 `mdsk-` 前缀，不用 Shadow DOM、不用 `srcdoc`。
- **悬浮球**：`position: fixed; top: 15%; right: 20px; z-index: 999999`，自己实现鼠标/触摸拖拽（不碰 ST 的 `movingUI`），拖动超过 4px 算拖拽、否则算点击。
- **面板**：`position: fixed` 全屏遮罩，`z-index: 999999999`，`backdrop-filter: blur(14px)`，`100vh` 后跟 `100dvh` 兜底。
- **面板内容**：iframe 装 Blob 化后的地图页（见上一节）。iframe 只在第一次打开时创建，关闭面板时**保留不销毁**（地图首次加载要几十秒），重开时发 `tw:resize` 让 Cesium 重算画布。
- **持久化**：`localStorage`，键前缀 `mdsk:`，存面板开合（`mdsk:open`）和悬浮球坐标（`mdsk:ballPos`），全部 `try/catch`。
- **加载与错误提示**：打开即显示加载遮罩；iframe `load` 后文案改为"界面已载入，正在加载三维数据"；地图页发来 `tw:ready` 才收遮罩；70 秒没有就绪则疑似超时，先探测一次 URL 状态再给出可读错误和「重试」按钮。
- **消息监听装在两个窗口上**：脚本常运行在「酒馆助手脚本 iframe」里，而地图页对 `tw:getCamera` / `tw:findPlace` 的应答是按 `postMessage` 的 source 回包的——从脚本 iframe 发出去的消息，应答会回到脚本 iframe 而不是宿主页。所以 `HOST` 和自身 `window` 都要监听，否则应答丢失。
- **不发出误导性承诺**：脚本只做前端展示与转发，不代替角色卡/世界书的逻辑。

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
window.MondstadtMap.getMapUrl()                  // 地图页源地址
window.MondstadtMap.debug()                      // 内部状态（排查用）
window.MondstadtMap.send({type:'tw:xxx', ...})   // 原样透传给 iframe
window.MondstadtMap.on('pick', fn)               // 订阅事件，返回取消函数
```

### 事件（宿主 window 上的 CustomEvent，`detail` 为原始消息）

| 事件 | 触发 |
|---|---|
| `mdsk:ready` | 地图页加载完成 |
| `mdsk:error` | 地图页主动报错或本脚本判定超时/取文档失败 |
| `mdsk:pick` | 用户在地图上点击取点 |
| `mdsk:place` | `findPlace` 的应答 |
| `mdsk:camera` | 相机状态应答 |
| `mdsk:open` / `mdsk:close` | 面板开合 |

### postMessage 协议

脚本在宿主 window（必要时还有自身 window）上监听，**只接受来源等于当前 iframe 的消息**，且 `type` 必须以 `tw:` 开头。

iframe → 宿主：`tw:ready {version, embed, metro, ok}`、`tw:error {stage, message}`、`tw:pick {lon,lat}`、`tw:place {rid, query, matches}`、`tw:camera {rid?, lon,lat,height,heading,pitch}`

宿主 → iframe：`tw:hello`、`tw:setCharacters {list}`、`tw:flyTo {lon,lat,height,duration}`、`tw:getCamera {rid}`、`tw:findPlace {q, rid, limit}`、`tw:resize`

### 覆盖配置

在宿主页面上先设好再加载脚本即可，无需改仓库：

```js
window.MDSK_MAP_BASE = 'http://127.0.0.1:8900/';   // 换地图源（本地调试用，需带 CORS 头）
window.MDSK_MAP_URL  = 'https://…/index.html?embed=1'; // 完全指定地图地址
window.__MONDSTADT_MAP_CONFIG__ = { readyTimeoutMs: 120000 };
```

## 索引页（index.html）

相对原始 `vladivostok-metro-3d.html` 只做了五处改动，都是为了让外层面板能正确显示状态与正确装载：

1. 新增 `announceError(stage, message)`，加载失败时向父窗口发 `tw:error`。
2. `tw:ready` 增加 `ok` 字段，数据加载失败时为 `false`；版本号升到 `1.3`。
3. 消息处理新增 `tw:resize` 分支，调用 `viewer.resize()`（面板重新显示后重算画布尺寸）。
4. `EMBED_MODE` 除 `?embed=1` 外，还接受注入的 `window.__MDSK_EMBED__`，并把「处在 iframe 里」本身也视为嵌入模式（Blob URL 没有 query，原来只认 `location.search` 会失效）。
5. `tw:getCamera` / `tw:findPlace` 的应答对象**改为发给 `window.parent`** 而不是 `ev.source`（应答必须回到宿主页，见上文「消息监听装在两个窗口上」），并补上 `rid`。

资源引用**没有改动**：`cesium/Cesium.js`、`cesium/Widgets/widgets.css`、`data-manifest.json`、`data-*.json` 都是相对路径，靠注入的 `<base>` 解析到 CDN；OpenStreetMap 瓦片是外部服务，保持不动。

## 本地预览

```bash
python tools/serve.py --port 8900          # 服务仓库根目录，带 Access-Control-Allow-Origin: *
```

然后浏览器打开 `http://127.0.0.1:8900/index.html` 看地图本身。
注意：直接用 `python -m http.server` 会因为缺 CORS 头导致悬浮窗取不到地图页。

## 维护须知

- jsDelivr 单文件上限 **20 MB**，仓库总体积不影响单文件抓取。分片每个 12.6 MB 以内，安全。
- 仓库总体积约 64 MB，**超过 jsDelivr 的 50 MB 目录列表上限**，所以 `https://cdn.jsdelivr.net/gh/papa163165/mondstadt-3d-map@main/` 会返回 403。具体文件地址不受影响，正常 200。
- `@main` 有缓存，改完 push 后不会立即生效。稳妥做法是每次发布把 `?v=` 递增（脚本里 `CONFIG.version`，索引页里 `announceReady` 的 `version`）。
- 未纳入仓库：`vladivostok-osm2-semantic.geojson`（47 MB，超出 jsDelivr 单文件上限）。它只是分片清单加载失败时的兜底，正常情况下不会用到；如果索引页走到那条兜底路径会明确报错。
