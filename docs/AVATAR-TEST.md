# 头像功能测试版

基于 Stronghold Protocol 0.2.1，上游基线 `c2a2ef778cf728ff29b953b9842b2a39b1e9cbea`，开发分支 `codex/avatar-test`。

## Mac 启动、停止与日志

在项目目录执行：

```bash
bash scripts/test-local.sh start
bash scripts/test-local.sh status
bash scripts/test-local.sh stop
bash scripts/test-local.sh restart
```

控制脚本使用 `.runtime/` 中已经安装的 Node.js 24.19.0，不需要系统全局安装。服务器在后台运行，关闭终端不影响开服；默认监听 `0.0.0.0:3000`，3000 被占用时使用 3001。启动和状态输出会列出实际本机及局域网地址。日志在 `logs/test-server.log`，进程记录在 `logs/test-server.json`。电脑休眠或关机后无法访问，再开机需重新执行启动命令。

macOS 若询问是否允许 Node 接收传入连接，请允许。同一 Wi-Fi/局域网的朋友打开主机的局域网地址，在“同盟模拟”使用同盟密钥加入。可用 `/healthz` 检查服务状态。

## 更换头像

主页面头像入口已移除；模拟选择页点击右上角本人头像；同盟等待页点击自己的座位头像。其他玩家和 AI 的头像不提供编辑入口。

- 干员头像：搜索名称，选择普通或精英头像，点击“保存头像”。候选使用当前游戏数据中有名称且具备头像素材的干员。
- 自上传：选择 PNG/JPEG/WebP（原文件不超过 5 MB、解码后不超过 3200 万像素），拖动或使用方向键调整方形裁剪，滑动“缩放”调整大小，点击“保存头像”。保存的是 256×256 WebP，最大 24 KiB；原图不保存、不上传。
- “恢复默认”先改变预览；点击保存才生效。“取消”、Escape 或关闭弹窗不保存修改。无法读取图片、Cookie 保存失败时保留原头像并显示原因。

头像由服务器的伪账号档案保存；Cookie 只缓存与完整“代号#代码”匹配的头像，不作为其他账号的头像来源。自上传图片保存为压缩后的 WebP，不再提供 JSON 导出或导入。刷新、重开、退出房间或服务器重启后，同一伪账号恢复原头像；换浏览器或主机地址后也可输入相同代号和代码恢复。不同代码或不同代号分别保存，房间展示仍用 playerId 关联。Cookie 写入失败会提示，不影响服务器已有档案。

同盟页自己的头像提示默认隐藏，鼠标悬停时显示“单击更换图像”；其他玩家头像不可编辑。头像弹窗的“取消”和“保存头像”使用相同宽高。

头像在 `hello` 指定账号后从服务器档案恢复，`profile.avatar` 同步在线更换，`welcome.avatar` 和 `room.state.seats[].avatar` 返回当前选择。服务端验证类型、素材标识、WebP 结构与尺寸，保持 64 KiB WebSocket 入站限制，并限制头像编辑频率。HTTP 请求头限额为 80 KiB，以容纳保存过程中两代 Cookie 分片；WebSocket 消息大小限制不变。图片只随身份和房间消息传输，不进入对局和战斗快照。不建立独立图片仓库；压缩头像保存在账号 JSON 档案中。

## 迁移到 Windows

1. 复制修改后的源码、`data/`、`public/assets/`、`public/fonts/`；若有本地客户端素材，一并复制 `public/assets/local/` 和 `data/local-assets.json`。无需复制 Mac 的 `.runtime/`、`node_modules/`、`.npm-cache/`、日志或进程记录。
2. Windows 安装 Node.js 24，在项目根目录执行 `npm ci --no-audit --no-fund`。运行 `node tools/setup.mjs --no-local` 核对并补齐素材。
3. 双击 `scripts/start-windows.bat`。需要常驻时使用现有 `scripts/install-service-windows.ps1`，端口、防火墙和服务操作见 `docs/DEPLOY.md`。
4. 同时复制 `logs/replays/` 中的账号档案和对局数据。迁移后使用相同代号和代码恢复头像、配置及对局记录；详见 [VOICE-PROFILES.md](VOICE-PROFILES.md)。

当前修改版请保留源码备份。不要直接覆盖上游更新包：其完整性清单针对上游原版，自定义代码应在此分支合并更新并重新验证。

## 验证

```bash
export PATH="$PWD/.runtime/node-v24.19.0-darwin-arm64/bin:$PATH"
node --test
npm run lint
npm run typecheck
npm run check:imports
SP_AVATAR_E2E=1 node --test test/ui/avatar.e2e.test.js
```

浏览器测试需要本机 Chrome 和已经下载的素材。截图、上传样例与验收记录输出在 `test/e2e/out/avatar/`（Git 忽略）。头像联机测试使用随机本机端口；浏览器验收包含两名同名玩家、上传裁剪、错误文件、Cookie 被禁用、分片回滚、24 KiB 图片恢复、重开浏览器页面、重连、主机隔离、悬停提示、按钮尺寸和手机横屏，以及单人/同盟开局与服务器重启。

`check:imports` 上游检查本来就列出 `server/sim/nodeData.js` 的三个 Node 内置导入记录，默认命令退出码为 0；本功能不新增此类记录。Windows 实机部署和验证待后续迁移时完成。
