# Windows ChatGPT 交接：卫戍协议自定义修改与迁移

> 交接日期：2026-10-09。请先完整阅读本文件，再修改项目。
> 这是当前定制版的实际行为说明，后续用户要求已经覆盖早期方案中的部分设计。不要从上游重新下载后覆盖本版。

## 1. 项目身份与交付状态

- 上游：https://github.com/sganggs/Stronghold-Protocol
- 上游基线：`c2a2ef778cf728ff29b953b9842b2a39b1e9cbea`，版本号仍为 `0.2.1`。
- 开发分支：`codex/avatar-test`。配音功能完成提交：`f9a3f10`；之后本次迁移增加跨平台回放版本指纹修复及本交接文件。
- 当前 Mac 测试实例已通过管理脚本正常停止，迁移包制作期间不再常驻开服。
- Windows x64 迁移包：源码、完整素材、两种配音、重新安装的纯 JavaScript 生产依赖、官方 Windows Node.js 24.19.0（含 npm）、测试源码及已停止服务器的账号/对局数据快照。
- 没有复制 Mac `.runtime/`、原 `node_modules/`、本机 `.env`、Mac 进程记录或服务环境配置。
- 尚未在 Windows 实机执行启动与验收；交接者需按下面步骤完成。迁移不会恢复服务器内存中的进行中对局。
- 包根 `Stronghold-Protocol-source.bundle` 保存完整可达 Git 历史；`CUSTOM-CHANGES.patch` 保存相对上游基线的全部代码差异；本文件附完整改动文件清单。

## 2. 给 Windows 上 ChatGPT 的直接任务说明

可把下面这段与本文件一起交给 Windows ChatGPT：

> 请接管这份卫戍协议自定义项目。先阅读 `WINDOWS-CHATGPT-HANDOFF.md`，核对包内 `MIGRATION-REPORT.json` 和 `SHA256SUMS.txt`，保留 `app/logs/replays/` 中全部账号及对局数据。使用包内 Windows Node.js 24.19.0，在 Windows 安装/核对依赖，运行环境诊断，启动服务器并验证 `/healthz`、本机及局域网访问。按本文验收头像、伪账号隔离、跨设备恢复及旧窗口同意接管、历史结算/回放/分享、中日配音和账号配置恢复。需要继续开发时恢复 Git bundle，在 `codex/avatar-test` 分支工作；不要用上游原版覆盖修改，也不要将本机默认配置上传覆盖已有伪账号档案。测试完成后报告实际访问地址、启动/停止方式及日志位置。未经用户要求，不增加真正账号系统、密码、跨设备自动登录或公网隧道。

## 3. Windows 启动与迁移

### 3.1 最快启动（无需额外安装 Node）

1. 将整个 ZIP 复制到 Windows 10/11 x64，完整解压到独立目录，例如 `C:\Games\Stronghold-Protocol-Windows-20261009`。不要在 ZIP 内直接运行，也不要覆盖另一份服务器的 `logs/replays/`。
2. 双击包根 `start-windows.cmd` 或 `启动游戏.bat`。它使用包内 Windows `node/node.exe`，调用 `app/scripts/launch.mjs --no-setup`，不重新下载素材。
3. 默认监听 `0.0.0.0:3000`；端口占用时可在命令提示符运行 `start-windows.cmd --port 3001`。Windows 启动脚本不保证自动换端口，以控制台实际地址为准。
4. 本机访问 `http://localhost:3000/`，检查 `http://localhost:3000/healthz`；局域网访问控制台列出的 Windows 主机 IP。若使用 3001，两处地址同时改为 3001。
5. 防火墙如询问，允许所需专用网络连接。外部分享仍需可被对方访问的服务器地址，本版不会建立公网入口。
6. 在开服控制台按 **Ctrl+C** 正常停止并等进程退出。不要用强制关机代替正常停止。

默认便携启动的日志在控制台；原版常驻脚本写入 `app/logs/server.log` 并轮换。迁移包保留诊断入口，维护命令见下面。不要把 Mac 的 `logs/test-server.json` 当作 Windows 进程状态。

### 3.2 Windows 重新安装依赖和环境诊断

在包根打开 PowerShell，执行：

```powershell
$env:Path = (Join-Path $PWD 'node') + ';' + $env:Path
Set-Location app
node --version
npm ci --no-audit --no-fund
node tools/doctor.mjs
node scripts/launch.mjs --no-setup
```

此步骤会在 Windows 按锁文件重新安装全部依赖（含开发测试依赖），不复用 Mac 运行环境。包内生产依赖已在干净暂存目录重新安装，均为跨平台 JavaScript；普通离线开服无需再次安装。不要用 `npm update` 替代 `npm ci`。素材已带齐，只有检查确认缺失才运行 `node tools/setup.mjs --no-local`；不要只下载一套语音后覆盖清单。

### 3.3 常驻与日志

确认前台服可用后，先 Ctrl+C 停止它，再在设置过包内 Node PATH 的 PowerShell 中进入 `app`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop
powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart
```

这是项目已有任务计划程序方案，会请求 Windows 管理员权限，注册 `StrongholdProtocol` 计划任务并写入新的 `scripts/service.env.cmd`，日志在 `app/logs/server.log`。不要同时运行前台实例和常驻实例。安装路径应固定，常驻配置引用实际 `node.exe` 路径；之后移动文件夹需重新安装该任务。详细参数见 `app/docs/DEPLOY.md`。

### 3.4 保留开发历史

便携 `app/` 含完整源码、测试和维护工具，但不含 `.git`。需要继续开发时在包根运行（Windows 需安装 Git）：

```powershell
git clone -b codex/avatar-test .\Stronghold-Protocol-source.bundle .\source
```

将包内 `app/public/assets/`、`app/public/fonts/`、`app/public/vendor/` 复制到新 `source/public/`；如存在，复制 `app/data/local-assets.json`；将 `app/logs/replays/` 整个复制到 `source/logs/replays/`。在 `source` 内用 Windows Node 执行 `npm ci --no-audit --no-fund`。已有源码工作目录需要先备份和比较，不直接覆盖，且不要同时在两个目录开服并写同一档案。

## 4. 数据位置与必须保留的规则

| 内容 | 默认位置 / 规则 |
|---|---|
| 伪账号头像、配置、历史索引 | `app/logs/replays/profiles/<SHA256>.json` |
| 对局回放、结算与分享码 | `app/logs/replays/<UUID>.json.gz` |
| 等待生成的回放输入 | 同目录 `<UUID>.inputs.gz`；保留后启动可继续生成 |
| 素材清单 | `app/data/assets.json`，必须与 `app/public/assets/` 一起复制 |
| 本地棋盘素材（如有） | `public/assets/local/` 与 `data/local-assets.json` 必须成对保留 |
| 设备设置 | 浏览器缓存中的音量、快捷键、画质、界面语言；不会作为账号设置迁移 |

复制的是完整停止后快照，不改写账号名、代码、分享码或访问密钥。账号文件包含压缩头像及对局访问数据，因此这份迁移包供本人迁移；对外分享单局使用游戏内“分享对局”链接。旧链接的分享码不变，但服务器地址改变后链接的主机部分需要替换。历史结算仍可查看；已到 72 小时或已经因版本升级失效的完整回放不会因复制而重新有效。

**最终身份来源是服务器的完整“代号#代码”，不再是浏览器 Cookie。** Cookie/localStorage 只缓存完全相同账号，不得将 A 的头像、对局或待上传配置带到 B。

## 5. 全部功能修改的最终行为

### 5.1 头像

- 最早按要求在标题页做过“博士头像 AVATAR”，后来用户明确删除：**现在标题页仅代号和代码输入，不再有头像入口**。
- 模拟选择页点击本人头像、同盟等待页点击本人座位头像，打开统一选择弹窗。其他玩家和 AI 不可编辑。
- 复用 `AvatarFrame`，保留边框、准备状态、本人标识和 AI 图标。本人头像的提示默认隐藏，鼠标悬停时显示“单击更换图像”。
- 内置头像从素材清单读取，按干员名称搜索，支持普通/精英形态。
- 自上传 PNG/JPEG/WebP，原文件最大 5 MiB、解码最大 3200 万像素；方形裁剪支持拖动和缩放，确认生成 256×256 WebP，最大 24 KiB。原图不保存、不上传。
- 恢复默认先改变预览，保存才生效；取消/Escape 不覆盖已有头像。按钮统一尺寸；横屏手机适配；加载失败回退默认图标。
- 最终版本已删除“导出已保存设置”和“导入设置”，不要重新加回。服务器保存账号头像，Cookie 分片只是同账号缓存；存储/同步失败有提示，当前账号断线重连再试，切换账号取消旧修改。
- `shared/avatar.js` 三种类型：`{kind:'default'}`、`{kind:'operator',charId,e2}`、`{kind:'custom',dataUrl}`。
- 协议沿用 `hello` 可选头像结构、`welcome.avatar`、`profile.avatar`、房间座位头像；显式选择伪账号后以服务器档案为准。服务端只允许修改本人，验证素材标识、WebP 结构/尺寸/大小、频率。
- WebSocket 入站仍为 64 KiB；HTTP 请求头为 80 KiB，以容纳 Cookie 分片保存时两代数据；头像不进入战斗快照。

### 5.2 伪账号与跨设备接管

- 登录是两个框 `【代号】#【四位代码】`。四位 ASCII 数字，保留前导零；留空由服务器随机分配新代码。代号沿用上游 12 个 UTF-16 代码单元限制，不是 24 字符。
- 重名提示但允许登录；完整身份已存在时提示将恢复已有档案。相同名称不同代码属于不同账号，修改其中任意部分即切换账号，新账号默认头像、空记录和默认配置。
- 服务端规范化身份并以 `SHA256(JSON.stringify([name,code]))` 命名档案；JSON 采用临时文件写入后原子重命名。
- 完整身份能从其他设备/浏览器找回仍在服务器运行中的对局，继续使用原 playerId、座位、私有状态、商店和战场。
- 旧窗口仍连接时向旧窗口弹出确认，新窗口等待；必须旧窗口明确同意，获准后旧连接断开。拒绝、取消或 30 秒超时保留原窗口。每座位最多一个请求并有冷却，重连令牌不能绕过在线窗口批准。
- 旧窗口已经断线时依现有重连窗口恢复；已退出座位、已结束对局或超过窗口不能重新占位。服务器重启不恢复正在进行的游戏。
- 这不是密码账号。四位代码是身份标识，不能当作认证密钥。保留用户要求的伪账号逻辑，不擅自升级成注册系统。

### 5.3 游玩记录、结算与分享

- 记录范围为当前伪账号参与的对局，服务器保存最近 200 局索引；不同浏览器登录完整相同身份可恢复。旁观/分享观看不自动记入本人记录。
- 游玩记录展示原结算页。即时游戏结束结算不显示“同盟限制”和“回放”；**从游玩记录进入的历史结算才显示**，按钮布局已修正。
- 每局拥有持久随机分享码（96 位随机量、16 个 URL 安全字符），分享链接 `https://服务器地址/#replay=<分享码>`；无须登录即可看该局结算、限制及有效回放。
- 分享不会暴露本人历史访问密钥、重连令牌或账号档案。分享码可转发，过期后仍可查看结算和明确原因。
- 私有读取 `GET /api/replays/<UUID>` 使用该局 Bearer 密钥；公开只读 `GET /api/shared-replays/<分享码>` 支持 summary/HEAD，无列表枚举接口。
- 不创建公网隧道；localhost 链接仅本机可用，局域网链接仅可访问该主机者可用，外网需要已有可达服务器地址。

### 5.4 回放界面与记录方式

- 回放复用原游戏顶栏、HUD、左侧头像选择、盟约、敌人预览、商店、干员/装备详情、确认本局信息、策略/机变选择及进入休整期等动画，不另造简化战斗页面。
- 顶部旧回放独立标题已删除；原红色退出按钮回到该局历史结算；延迟标签改为“回放”。准备期还原每人的资金、待选干员、部署位、整备区、待出现敌人、生命值、倒计时、盟约、技能/模组配置。
- 左侧原头像组件切换观看玩家，包含 AI 和已淘汰者。只查看，不能向真实服务器提交购买、准备、部署等操作。
- 操作时间线在右侧、进度时间轴在下方，默认展开，支持边缘按钮收起/展开及滑动动画，覆盖画面不缩小地图；减少动态效果设置跳过动画。支持全屏和手机横屏。
- 确认本局信息/选择策略时隐藏底层地图和战斗 HUD，使用不透明原游戏界面。
- 暂停/继续、速度 0.5–8×、前后节点、进度拖动；空格播放切换、左右箭头节点；原顶栏暂停按钮同样可用。
- 阶段动画、单位动画、倒计时以回放时钟为准，暂停/跳转同步冻结或恢复。
- 保存盟约限制、各玩家购买、部署、选择策略/单位等事件与时间。客户端战斗默认以记录的种子/配置及原模拟器生成约 10 Hz 帧；服务端战斗保存实际快照。不是视频录屏，客户端延迟与共享领袖同步可能造成重演时间差。

### 5.5 回放大小与过期

- gzip + 无损快照差分；每局压缩文件硬上限 **100,000,000 字节**，生成中的输入与预览合计也受限。超限保留轻量结算并显示原因，不声称有完整回放。
- 先前 14 回合 4 玩家测试生成 59 个战场、52,068 帧，约 3.47 MB；不是固定大小承诺，实际与阵容及时长相关。
- 结算服务器时间 +72 小时或代码/游戏数据版本更新后过期。悬停、聚焦或触屏长按提示剩余“X天 X小时 X分钟”，基于服务器时间；已过期直接显示“版本更新”“超过72小时”或“存储超限”。
- 每分钟、启动和读取时检查并删除大体积帧/输入，保留结算、限制和索引。
- 内容指纹 `server/replays/version.js` 区别于 `/healthz` 的浏览器 buildTag。普通复制/修改文件时间不算更新。本次统一 Windows/POSIX 路径分隔符，避免同一新版迁移再次误判；**该源码修复本身属于一次版本变更，修复前的旧回放仍依原规则过期，结算保留**。

### 5.6 中日配音

- 设置页新增中文普通话/日文，**默认日文**，不随界面语言变化。
- 搜索干员并单独设语言，选项下方列出已单独设置者的头像、名称、语言及“跟随全局”；切全局保留单独设置。同 charId 普通/精英共用，不同 charId 分开。
- 全部语音入口统一解析：单独设置 → 全局语言 → 单句缺失/解码失败尝试另一语言 → 都没有则不播。设置页显示清单已知缺失。
- 下一句应用更改，当前句继续；保留音量、静音、时机、优先级、并发竞争保护及缓存预算，按需加载。
- `audio.voices.cn` / `.jp` 两套清单，旧 `audio.voice` 保留中文兼容索引。下载器一次保留两库，不相互覆盖；可附加其他语言，但 UI 仅中日。
- 本次每库 191 名干员、2674 条台词；中文约 65.6 MiB、日文约 85.2 MiB。原播放槽位包含战斗和结算，非游戏触发台词仍为可选。

### 5.7 账号配置同步

- 配音语言/单独设置、技能/模组 loadout、持有名单 notOwned、5/6费 DIY 编队全部存服务器完整账号档案。设备音量、快捷键、画质和界面语言仍本地保存。
- `welcome.profilePreferences` / `profilePreferencesInitialized` 恢复配置；客户端 `profile.voice` 保存配音，服务端 `profile.preferences` 发送确认后的配置及账号标识。
- 既有 `room.loadout`、`room.ownership`、`room.diy` 校验后持久化账号；先写成功再修改内存并广播其他同账号窗口，最后成功保存为准。对局锁定沿用现有规则，局中配置用于下一局。
- 登录先恢复服务器再启用上传；新设备不会把默认配置上传覆盖档案。服务器无配置时才进行一次本机旧配置迁移，`sp.pref.profilePreferencesMigrated` 记录归属；之后其他账号不能继承。
- 缓存/待上传修改绑定完整身份，只重试当前账号未确认的部分，其他部分恢复服务器新值。切账号取消旧请求、重试、延迟回调和错误回复，不跨账号写入。
- 开局及确认本局信息等待配置保存；中途切账号取消旧操作，避免旧账号的技能/模组影响新局。
- 保存失败有明确提示，保留当前账号待确认修改；头像和对局历史不会被配置写入覆盖。

## 6. 关键文件导航

| 范围 | 主要入口 |
|---|---|
| 头像结构/校验 | `shared/avatar.js` |
| 头像选择/缓存 | `public/js/ui/avatarPicker.js`、`avatarImage.js`、`avatarProfile.js`、`public/css/avatar.css` |
| 身份输入 | `shared/doctor.js`、`public/js/screens/title.js`、`public/css/screens/title.css` |
| 档案持久化 | `server/profiles/store.js` |
| 登录/接管协议 | `server/net.js`、`shared/protocol.js`、`public/js/net.js`、`public/js/ui/profileTransfer.js` |
| 对局配置保存 | `server/lobby.js`、`public/js/ui/profilePreferences.js`、`loadoutSync.js` |
| 配音设置/解析 | `shared/voice.js`、`public/js/audio.js`、`public/js/ui/settings.js` |
| 两语素材下载 | `tools/fetch-assets.mjs`、`tools/assets/plan.mjs`、`data/assets.json` |
| 记录与持久化 | `server/replays/{recorder,archive,codec,version}.js`、`worker.mjs` |
| 对局记录接入 | `server/match/Match.js`、`server/match/match/`、`server/match/results.js` |
| 回放/历史/限制 | `public/js/replay/{host,hud,history,timeline,restrictions}.js`、`public/css/replay.css` |
| 结算/原界面复用 | `public/js/screens/result.js`、`briefing.js`、`bandDraft.js`、`public/js/ui/matchChrome.js` |
| HTTP 只读接口 | `server/http/routes.js`、`server/index.js` |
| 本机与 Windows 启动 | `scripts/test-local.sh`、`test-server.mjs`、`launch.mjs`、`start-windows.bat`、`install-service-windows.ps1` |
| 进一步功能说明 | `docs/AVATAR-TEST.md`、`REPLAYS.md`、`VOICE-PROFILES.md`、`DEPLOY.md` |

## 7. 已执行验证与 Windows 待验收

迁移前在 Mac 完成：全量测试 5231 项，5205 通过、26 跳过、0 失败（约 127.5 秒）；配音最终真实浏览器用例通过；头像/回放/账号接管浏览器回归已验证。配音实际解码与所选文件播放、中日缺失回退、跨独立浏览器完整配置恢复、同名不同代码隔离、手机横屏和开局验证均覆盖。

lint：0 错误、134 条现有警告。类型检查通过。导入检查默认退出码 0，但仍报告上游 `server/sim/nodeData.js` 的三个 Node 内置导入边界记录（fs/path/url），不能写成“零违规”。i18n 提取无未包裹文本、英文覆盖检查通过。素材打包清单核对无问题，中日各 2674 条。

本次迁移修复另跑 `test/replays/storage.test.js` 和 `test/windows-bundle.test.js`，验证跨平台路径、内容变更过期、存储预算/访问权限/分享以及打包。具体数目与包校验摘要见 `MIGRATION-REPORT.json`；日志在包根 `verification/`。这些是历史验收证据，不代表 Windows 已实际跑过。

在 Windows 开发目录重新安装全部依赖后运行：

```powershell
npm test
npm run lint
npm run typecheck
npm run check:imports
node tools/i18n.mjs check en --strict
$env:SP_AVATAR_E2E='1'; node --test test/ui/avatar.e2e.test.js
$env:SP_REPLAY_E2E='1'; node --test test/replays/browser.e2e.test.js
$env:SP_PROFILE_E2E='1'; node --test test/ui/profile-transfer.e2e.test.js
$env:SP_VOICE_E2E='1'; node --test test/ui/voice-preferences.e2e.test.js
```

浏览器测试需要 Windows Chrome；若脚本未自动发现，先检查该测试的 Chrome 路径探测实现并配置/适配，不能将跳过当作通过。实际验收包括：两个独立浏览器恢复同一伪账号的全部配置；不同账号隔离；在线旧窗口批准/拒绝接管；刷新/重启账号恢复；单人和同盟开局；历史结算入口；暂停/节点/动画/全屏；分享匿名观看/过期原因；中日实际发声、个别覆盖/跟随全局/缺失回退/音量静音；`/healthz` 和局域网连接。

## 8. 维护边界与已知限制

- 所有后续更新在自定义分支合并并验证；不要用上游完整性清单或自动更新包覆盖本版。
- 停服后复制数据。运行中的服务器内存不可随 ZIP 迁移；已持久化结算、档案与生成输入可以迁移。
- 内容版本升级使旧回放失效是用户明确要求，不应通过强行改存档 version 来绕过。
- 只提供本机/局域网部署包，没有执行 Windows 实机、防火墙、公网部署或域名迁移。
- 代码许可与素材声明随包保留，见 LICENSE/NOTICE/THIRD-PARTY-NOTICES。

## 9. 逐次修改记录（相对上游基线）

下面的提交覆盖整个自定义实现过程，最终行为以第 5 节为准；旧提交中的标题头像、导入/导出、仅浏览器缓存等已被后续要求替代。

```text
202f763 Add persistent player avatars and local test deployment
86994a2 Style title avatar selector to match callsign field
7c30adb Persist avatars in cookies and refine portrait controls
621e9d5 Add persistent match history and interactive battle replays
b0660d8 Improve replay preparation HUD and archive controls
650cad7 Reuse game HUD for replays and persist doctor archives
78b4fc7 Add shared match links and split doctor identity inputs
ff22d7a Clarify the existing doctor callsign length limit
c1ad6ce Isolate pseudo-account avatars and match history
eb97f8a Add approved cross-device recovery and replay drawer animations
f9a3f10 Add CN/JP operator voices and account-owned roster preferences
```

本次迁移追加：Windows/POSIX 内容指纹路径统一及回归测试；便携包说明纠正服务器档案位置；新建本文件；制作 Windows Node/npm 便携包、数据快照、Git bundle 和完整补丁。

## 10. 全部修改文件清单

```text
.gitignore
data/assets.json
docs/ASSETS.md
docs/AVATAR-TEST.md
docs/DEPLOY.md
docs/REPLAYS.md
docs/VOICE-PROFILES.md
eslint.config.js
public/css/avatar.css
public/css/devices.css
public/css/replay.css
public/css/screens/game.css
public/css/screens/title.css
public/i18n/en.json
public/index.html
public/js/audio.js
public/js/main.js
public/js/net.js
public/js/render/app.js
public/js/replay/history.js
public/js/replay/host.js
public/js/replay/hud.js
public/js/replay/restrictions.js
public/js/replay/timeline.js
public/js/screens/bandDraft.js
public/js/screens/briefing.js
public/js/screens/lobby.js
public/js/screens/result.js
public/js/screens/room.js
public/js/screens/title.js
public/js/store.js
public/js/ui/avatarImage.js
public/js/ui/avatarPicker.js
public/js/ui/avatarProfile.js
public/js/ui/choiceOverlay.js
public/js/ui/components.js
public/js/ui/fieldHost.js
public/js/ui/gameLogic/settings.js
public/js/ui/hud.js
public/js/ui/loadoutSync.js
public/js/ui/matchChrome.js
public/js/ui/profilePreferences.js
public/js/ui/profileTransfer.js
public/js/ui/settings.js
public/js/ui/shopBar.js
scripts/make-windows-bundle.mjs
scripts/test-local.sh
scripts/test-server.mjs
server/http/config.js
server/http/routes.js
server/http/websocket.js
server/index.js
server/lobby.js
server/match/Match.js
server/match/PlayerState.js
server/match/match/clientCombat.js
server/match/match/combat.js
server/match/match/messaging.js
server/match/match/platform.js
server/match/match/settle.js
server/match/match/views.js
server/match/results.js
server/net.js
server/profiles/store.js
server/replays/archive.js
server/replays/codec.js
server/replays/recorder.js
server/replays/version.js
server/replays/worker.mjs
shared/avatar.js
shared/constants.js
shared/doctor.js
shared/protocol.js
shared/voice.js
test/avatar.test.js
test/client-static.test.js
test/lobby.test.js
test/profile-preferences.test.js
test/profiles.test.js
test/replays/browser.e2e.test.js
test/replays/history.test.js
test/replays/recording.test.js
test/replays/storage.test.js
test/ui/avatar.e2e.test.js
test/ui/gameLogic.test.js
test/ui/profile-preferences-sync.test.js
test/ui/profile-transfer.e2e.test.js
test/ui/voice-preferences.e2e.test.js
test/voice-preferences.test.js
tools/assets/plan.mjs
tools/fetch-assets.mjs
tools/package.mjs
docs/WINDOWS-CHATGPT-HANDOFF.md
```

完整逐行变化见包根 `CUSTOM-CHANGES.patch`；完整提交历史见 `Stronghold-Protocol-source.bundle`。
