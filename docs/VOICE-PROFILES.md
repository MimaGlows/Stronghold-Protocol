# 配音与伪账号配置

设置页面中的“配音语言”独立于界面语言，默认日文，可切换为中文普通话。搜索干员名称后可指定单独配音；这些干员列在下方，“跟随全局”会删除该干员的单独设置。普通与精英形态共用同一个 charId，不同干员 ID 分开设置。更改从下一句生效，播放中的台词保持原样。

配音、干员技能与模组、干员持有名单、5／6费自选编队均归属于完整的“代号#四位代码”，服务器是保存与恢复的来源。本机缓存只恢复同一账号尚未保存的修改；其他账号不会读取这份缓存。音量、画质、快捷键和界面语言按设备保存。账号保存失败会提示，断线后恢复连接会重试。开局及确认本局信息前先等待配置保存，防止新配置未到达服务器时开始游戏。当前对局锁定后的干员配置改动只用于下一局。

首次升级时，本机旧干员配置只会迁入首次完成登录且尚无服务器配置的账号一次；若服务器已有配置，直接恢复。迁移标记保存在 `sp.pref.profilePreferencesMigrated`。同名不同代码是不同档案；正在游玩的账号跨设备登录仍需要在线旧窗口批准接管。

## 素材

运行 `npm run assets` 会同时保留中日两套战斗及结算语音。`--voice-lang=en|kr` 可附加另一语言，不移除中日库；设置界面只提供中日切换。`--voice-all` 仍用于附加游戏不会触发的报到、编队台词，本功能无需启用。

清单使用 `audio.voices.cn`、`audio.voices.jp`；旧 `audio.voice` 保留中文兼容索引。音频按需加载，继续遵守现有解码缓存和语音优先级。单条台词缺失或解码失败会尝试另一语言，同样缺失则不播放，不猜测远程 URL。设置界面提示清单已知的缺失。

本次下载结果：两种语言各 191 名干员、2674 条台词；下载库文件中文约 65.6 MiB、日文约 85.2 MiB。重新生成素材后请以实际清单为准。

## 部署、备份与迁移

Mac 控制服务：`bash scripts/test-local.sh start|stop|restart|status`。访问 `http://localhost:3000`，局域网地址由 `status` 输出；服务日志为 `logs/test-server.log`。

Windows 复制修改后的源码、完整 `data/`、`public/assets/` 和字体，重新安装 Node.js 与依赖，不复制 Mac 的 `.runtime/` 或 `node_modules/`。中日语音目录以及包含两种语音索引的素材清单必须一起迁移。账号档案默认位于 `logs/replays/profiles/`；迁移头像、配置、对局记录及回放时复制完整的 `logs/replays/`，不要只复制源码或覆盖既有账号档案。继续使用现有 Windows 启动与服务脚本，见 DEPLOY.md。Windows 实机验收留待迁移阶段。

## 验证

```bash
export PATH="$PWD/.runtime/node-v24.19.0-darwin-arm64/bin:$PATH"
npm test
npm run lint
npm run typecheck
npm run check:imports
SP_VOICE_E2E=1 node --test test/ui/voice-preferences.e2e.test.js
```

真实浏览器验收需要本机 Chrome，截图保存在 `test/e2e/out/voice/`。音频验收会实际解码中日台词并验证播放所选日文文件。服务器与客户端测试覆盖默认语言、单独设置、缺失回退、异步语音竞争、旧配置迁移、账号隔离、断线修改、跨设备恢复与保存失败。
