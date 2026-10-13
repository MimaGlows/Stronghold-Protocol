# 好友系统与同盟邀请

## 玩家使用

在“选择模拟协议”和“同盟模拟”等待界面，点击屏幕右侧“好友”拉开列表。面板覆盖页面，默认收起；在两页之间保留展开状态，切换虚拟账号后重置。好友和“一同游玩过的玩家”可分别折叠。手机横屏支持滚动与触摸操作。

搜索框分为“代号 # 代码”。填写代号和四位代码时精确查找；只填写代号时按名称包含关系模糊匹配（忽略英文大小写），最多展示 20 个已有档案，可选择其中一个添加。仅填代码或填写不足四位的代码会提示错误，不创建新账号。好友关系是单向的，无需对方批准；上限 200 人。不能添加本人，同名不同代码属于不同玩家。移除好友后，如果对方仍属于最近五场队友，会返回近期列表。完整身份中的 `#代码` 使用灰色小字号。

设置页新增“好友与个人资料”，按完整虚拟账号保存在服务器，跨设备恢复、同账号窗口同步：

- “允许好友观战”和“允许好友加入房间”默认开启。关闭后移除好友列表对应的直接入口，服务端也拒绝绕过 UI 的 `social.spectate/join` 请求；房间码／链接和直接邀请沿用原有校验，人数限制保持有效。已加入的成员不因设置修改被移除。
- “个人资料可见范围”为均不可见、仅好友、好友和最近同游玩家，默认第三项。按**被查看者**的好友名单与最近五场已结算队友判断；单向添加对方不会取得其资料权限。本人仍能查看本人记录。
- 获得资料权限后，点击好友／近期队友的头像或代号打开其游玩记录，可进入原结算和回放页面。访问使用本人会话凭证，每次服务器读取都重新校验；不返回对方记录密钥或分享码，不将其记录写入本人缓存。已持有的分享链接继续有效。权限关闭后，后续读取返回拒绝，界面清除已加载的回放。
- 设置通过 `profile.privacy {preferences:{allowFriendSpectate,allowFriendJoin,profileVisibility}}` 修改，沿用 `profile.preferences` 确认；失败提示并保留本账号待上传配置。`welcome.profilePreferences.socialPrivacy` 恢复服务端值，账号切换取消旧修改与资料请求。

资料接口：`GET /api/social-history?identity=代号%23代码` 返回已结算记录的轻量列表；添加 `&id=对局ID` 读取该列表所属记录，`&summary=1` 仅取摘要。使用 `Authorization: Bearer 本人会话令牌`，未登录返回 401，隐私拒绝返回 403；不提供跨域读取授权。

近期列表取该账号最近五场**已结算的参赛对局**，独立模拟也占一场。排除本人、AI、观战者、重复身份及已经添加的好友；保留退出或掉线队友。尚未结算的游戏不占这五场。旧记录仅使用已保存的完整身份补齐，不按名字猜测代码。

每行展示头像、完整代号和在线状态。正在游玩时展示难度、该玩家自己的策略（未选择时明确标记）、回合及当前生命；最终攻势／隐秘核心阶段使用同队生命。观战者标为“观战中”。列表排序为正在游玩／观战、房间中、在线、离线；近期玩家按最后共同游玩时间排序。连接断开后显示“状态暂不可用”。头像按需读取，状态推送不重复携带图片。

好友在等待房间时可“加入房间”，正在游玩时可“观战”。同盟有 4 个参战席位与 2 个独立观战席位；独立模拟只有 1 个参战席位，同样允许 2 名观战者。AI、掉线保留席位仍占容量；加入失败保留原房间，不自动移除 AI。已经参加其他进行中对局时，请先退出；同账号其他窗口正在参加的对局也受此保护。

同盟等待房间中的参战成员可以邀请在线好友或近期队友。被邀请者确认后才加入；已有等待房间时按钮写明“接受并离开当前同盟”。邀请有效期 2 分钟，同一双方两次邀请间隔至少 30 秒，不预留席位。接受时重新检查容量与邀请者身份；任一窗口接受／拒绝后，该账号所有窗口的弹窗关闭。邀请者离房、房间开局／关闭、超时或服务器重启会使邀请失效。进行中的参赛玩家不会被自动转移。

## Chrome 系统通知

点击好友面板底部“启用邀请通知”才请求浏览器权限。通知偏好按设备保存；同一浏览器的相同邀请使用共享短期标记和 Notification tag 合并。点击通知聚焦网页、打开邀请，不自动加入。也可点击“关闭通知”。

网页必须保持打开且在线，支持后台／最小化通知。本功能没有 Service Worker、离线 Push 或外部消息发送。通知需要 HTTPS 或 localhost 安全上下文；普通局域网 HTTP、拒绝授权或浏览器不支持时，面板说明原因，继续使用游戏内弹窗。操作系统还需允许 Chrome 通知。实现依据 [MDN 通知权限说明](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API) 和 [安全上下文说明](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)。手机浏览器若不支持直接创建通知，保留游戏内邀请。

Windows／macOS 桌面通知人工复核：用两个不同身份登录，接收者启用通知后将 Chrome 最小化；邀请者在同盟等待房间邀请；确认通知显示、点击聚焦、接受才入座。再验证拒绝权限、系统关闭 Chrome 通知和局域网 HTTP。自动化浏览器测试以 Notification API 替身验证权限调用、去重和聚焦逻辑，不能代替操作系统通知中心的人工验收。

## 开发记录 的实现交接

好友关系仍保存于 `logs/replays/profiles/<SHA256>.json`，与头像、配音、干员配置和历史共用账号档案。新增 `friends: [完整身份]`；历史条目新增 `endedAt` 和轻量 `participants: [{name, doctorCode, isBot}]`。继续使用临时文件加原子 rename，不覆盖其他字段。回放过期不删除这些参与者，因此仍能计算近期列表。第一次请求列表时，为最近五场缺少参与者的旧记录从回放存档补齐一次；找不到完整身份的存档保持空列表。

线上状态、订阅、邀请和 30 秒节流保存在内存。服务器重启恢复好友及近期记录，清除未处理邀请。在线状态按完整身份合并所有已登录连接；连接／房间变化即时通知，游戏回合／策略／生命由每秒定时合并推送。每条数据推送携带 `profileKey`，客户端核对当前账号。账号切换立即清除列表、弹窗、头像队列与通知，并取消旧账号未完成的社交请求。同账号其他窗口收到关系变动。

核心文件：

- `shared/social.js`：身份处理、最近五场算法、排序与容量／邀请常量。
- `server/social/service.js`：服务端列表、状态、按需头像、单向关系、加入／观战与邀请处理。
- `server/profiles/store.js`：关系原子持久化、历史参与者保存和旧记录补齐；`onSave` 钩子刷新订阅。
- `server/lobby.js`、`server/net.js`、`server/http/websocket.js`：房间生命周期、游戏公共状态及社交服务接线；独立模拟开放两个观战席位。
- `shared/protocol.js`：`social.*` 入站结构校验。
- `public/js/ui/social.js`、`public/css/social.css`：共用抽屉、全局邀请弹窗、账号隔离与通知。
- `public/js/main.js`、`public/js/net.js`：挂载、网络事件与旧账号请求取消。兼容层仍须首先导入。

协议通过现有 `net.request` 使用 `rid` 的标准 `ok/error` 应答；数据由下列单独消息推送，**不暴露重连令牌、历史访问密钥或战斗私有配置**：

| 客户端消息 | 主要字段 | 数据推送／行为 |
| --- | --- | --- |
| `social.sync` | 无 | `social.state {profileKey,friends,recent}`，恢复有效邀请 |
| `social.search` | `identity`（代号或完整身份） | `social.search {profileKey,query,entries,truncated}`；最多 20 项，完整身份查询保留旧 `entry` 字段兼容 |
| `social.avatar` | `identity` | `social.avatar {profileKey,identity,avatarRevision,avatar}`，限好友或近期队友 |
| `social.add/remove` | `identity` | 保存关系，并刷新同账号列表 |
| `social.join/spectate` | `identity` | 重新解析当前目标房间，复用 Lobby 校验 |
| `social.invite` | `identity` | `social.invite {profileKey,inviteId,from,difficulty,expiresAt,serverNow}` |
| `social.inviteRespond` | `inviteId,accept` | 验证账号、邀请有效性与容量；推送 `social.inviteEnded` |
| 服务端状态变动 | 无客户端请求 | `social.presence {profileKey,entries}`，仅推送订阅列表中变化的账号 |

邀请没有持久化，重启后不可恢复旧邀请。服务器仍是单实例 Node.js + WebSocket；没有新增真正账号认证、互相确认的好友关系、公网入口或离线推送。

## 验证命令

```powershell
npm test
npm run lint
npm run typecheck
npm run check:imports
node tools/i18n.mjs check en --strict
node --test test/social.test.js test/ui/social-sync.test.js
$env:SP_SOCIAL_E2E = '1'
# 必要时指定 Chrome；测试自动识别常见 Windows/macOS/Linux 路径。
# $env:SP_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node --test test/ui/social.e2e.test.js
Remove-Item Env:SP_SOCIAL_E2E
```

浏览器测试使用独立 Chrome context、临时档案和随机本机端口，覆盖实际搜索／添加、邀请、跨窗口关闭、朋友入房、真实单人／同盟开局、观战、断线恢复、账号隔离、横屏布局与 `/healthz`。截图写到 `test/e2e/out/social/`。测试结束后关闭临时服务器，不改变常驻开发实例的运行状态。

本目录现在用于本机开发，不再制作 Windows 包。Windows 线上版本由服务器侧维护；本说明记录本地好友功能与验收结果，不表示已经部署线上。

### 本次验证结果（2026-10-09）

- 完整 `npm test`：5268 项，5240 通过、28 项按环境开关跳过、0 失败。
- 显式启用的 Chrome 联机测试通过，验证实际好友头像加载、单向搜索／添加、好友入房、邀请与多窗口关闭、单人／同盟开局观战、重连、账号隔离及手机横屏。系统通知使用 API 替身，OS 通知中心实机验收仍按上文执行。
- 服务端与客户端专测通过，覆盖 200 人上限、并发最后席位、保存失败、重启恢复、老记录补齐、退出队友保留、纯观战者排除、邀请失效和旧账号响应。
- lint 无错误（现有 134 条警告）；类型检查、导入检查及中英文提示完整性检查通过。导入检查保留原有 `server/sim/nodeData.js` 三条 Node API 边界记录，退出码为 0。
- 上述完整验收结束时，临时测试服务已关闭，Mac 常驻实例保持停止。Windows 实机启动及 Windows/macOS 通知中心验收未在自动化测试中执行。

### 后续启动与好友回归（2026-10-09）

按用户要求启动 Mac 常驻测试实例，监听 `0.0.0.0:3000`；本机地址 `http://localhost:3000/`，当前局域网地址 `http://10.10.21.141:3000/`。启动与回归结束后均确认 `/healthz` 返回 `ok:true`。本次没有制作 Windows 包。

- 好友服务端和客户端专测：10 项全部通过，包括持久化、重启恢复、最近五场、账号隔离、容量竞争、邀请确认和通知降级。
- 独立 Chrome 联机回归连续两次通过，覆盖搜索／添加、头像、邀请与多窗口同步、加入同盟、真实单人／同盟开局观战、重连及手机横屏；测试数据使用临时档案，没有写入用户账号。
- 首次浏览器回归在移动端展开抽屉时超时，原因是合成触摸点击与账号切换后的抽屉动画竞争。测试现等待把手动画结束，再触摸展开并验证展开状态；应用实现未因此更改。修改后的测试文件 eslint 通过。
- 操作系统通知中心的实际投递仍需人工验证；自动化覆盖 Notification API 接入，不代表 Windows/macOS 系统投递验收完成。

在项目目录运行以下命令控制实例（状态中的局域网地址会随网络变化）：

```sh
./.runtime/node-v24.19.0-darwin-arm64/bin/node scripts/test-server.mjs start
./.runtime/node-v24.19.0-darwin-arm64/bin/node scripts/test-server.mjs status
./.runtime/node-v24.19.0-darwin-arm64/bin/node scripts/test-server.mjs stop
```

运行日志：`logs/test-server.log`；回归日志：`logs/social-regression-2026-10-09.log`、`logs/social-browser-2026-10-09.log`、`logs/social-browser-repeat-2026-10-09.log`。

后续按用户要求关闭并重新启动，当前改为只监听 `127.0.0.1:3000`，仅通过 `http://localhost:3000/` 访问，不开放局域网。`scripts/test-server.mjs` 默认绑定本机回环地址；状态文件记录实际监听地址。重启后 `/healthz` 正常，`lsof` 确认仅监听 `127.0.0.1:3000`。

### 好友搜索及标点样式修订（2026-10-09）

关闭按钮改为居中的 SVG，好友与搜索结果的代码改为灰色小字。新增分开的代号、代码框，服务端提供名称模糊搜索，账号身份索引随原子保存更新、启动时恢复；结果仅含展示字段。客户端拒绝代码单独搜索，忽略旧账号／旧查询响应。转盘移除图标下方文字，保留无障碍标签；点赞在转盘、地图和消息中统一使用白色矢量图，地图标识仍显示发送者代号。

验证：11 项好友专测通过；真实 Chrome 好友回归和通讯回归各 1 项通过，含模糊／精确搜索、代码单独输入报错、按钮居中、代码字号颜色、手机横屏及转盘 SVG。类型、修改文件 lint、中英文检查通过；导入检查保留原有 3 条 Node API 边界记录。全量测试 5269 项，5240 通过、28 跳过、1 项回放写入恢复超时；随后独立复核全部 9 项回放存储测试通过，未修改该恢复测试的等待时限。日志位于 `logs/social-search-*.log` 和 `logs/communication-wheel-browser.log`。按用户明确批准重启本机实例以加载服务端查询修改。

### 好友隐私与资料入口验收（2026-10-09）

32 项好友隐私／档案同步／历史读取／回放存储专测全部通过；154 项房间、配音、设置与快捷键相关回归全部通过；显式 Chrome 联机回归通过，包含设置开关和范围保存、好友头像／代号与近期队友资料入口、原结算页面、手机横屏、邀请入房及单人／同盟观战。隐私测试验证单向添加不能授权、目标好友名单与最近五场边界、每次 HTTP 读取校验、无记录密钥或分享码泄露、链接与邀请例外、保存失败、跨窗口确认、账号切换及服务器重启恢复。

按用户反馈进一步缩小资料范围选择框的字体、内边距及选项文字，复核桌面与横屏截图。类型、修改文件 lint、国际化检查通过；导入检查仍只有原有 3 条 Node API 边界记录。测试日志：`logs/social-privacy-tests.log`、`logs/social-privacy-regression.log`、`logs/social-privacy-browser.log`。本轮使用相关回归集合，未再执行整个项目的全量测试。

确认常驻实例无进行中的对局后已重启以加载服务，`/healthz` 正常；仍仅监听 `127.0.0.1:3000`。本轮没有制作 Windows 包。
