# 定制版更新记录

MimaGlows 定制版各 Release 的变化。上游游戏本身的变化见 [CHANGELOG.md](../CHANGELOG.md)。整合包和校验文件在 [Releases](https://github.com/MimaGlows/Stronghold-Protocol/releases) 下载。

所有定制版整合包都是 Windows 完整包：包含 Windows x64 Node.js 24.19.0、生产依赖、全部素材和中日配音，解压后双击 `启动游戏.cmd`，访问 <http://127.0.0.1:3000/>；换端口用 `启动游戏.cmd --port 3001`。

整合包**不含**任何玩家数据，包括账号、好友、统计、回放、处罚、密钥和本机控制配置。从旧版升级时，请按以下步骤操作：

1. 等待对局结束；
2. 正常停服；
3. 完整备份旧安装的 `logs/`；
4. 再迁移数据。

不要用其他实例或旧快照的数据覆盖现有玩家数据。

## v0.2.6-mimaglows-unified.2（2026-10-15）

- **基础**：上游 v0.2.6（`488db49`）与既有定制分支合并；源码 `e49d9a1`，浏览器构建 `c66772a33e55`。
- **修复**：
  - BOSS 和敌人生命值缩放；
  - 自订难度的保存；
  - 匹配隐私；
  - 回放与记录的脱敏；
  - 暗战弹窗的信息泄露；
  - 若干布局和点击区域问题。
- 规则与兼容约定见 [REPAIR-20261015.md](REPAIR-20261015.md) 和 [UNIFIED-026-DELIVERY.md](UNIFIED-026-DELIVERY.md)。
- **文件**：`Stronghold-Protocol-Windows-v0.2.6-mimaglows-unified.2.zip`，校验值见同页的 `SHA256SUMS.txt`。
- **验证**：
  - Node 测试 6721 项：6677 项通过，44 项按条件跳过，0 项失败；
  - 真实 Chrome 关键流程通过。
- **已知限制**：
  - 四个极端六人房间超出 CPU 延迟门槛；
  - 手机真机和 Windows 系统通知没有验证。

## v0.2.5-mimaglows.2（2026-10-13）

- **基础**：上游 v0.2.5；源码 `94fc322`。
- **补位关闭时自动续排**：房主关闭匹配补位后，已补位的玩家被移出，返回大厅并自动重新排队，原队伍、预选和排队时长都保留。
- **邀请可以跨房间和队列**：所有难度的等待房间和匹配队列都可以接受邀请并切换。
- **文件**：`Stronghold-Protocol-Windows-v0.2.5-mimaglows.2.zip`，SHA-256 `b8b92bfa2ee3f50562e6236bb480f56f9e8e43a24210bbb04b8b94cb4a9e2049`。
- 2026-10-14 的 CI 修复（`aabb492`）只改了测试，没有改游戏代码。

## v0.2.5-mimaglows.1（2026-10-13）

- **基础**：上游 v0.2.5；源码 `5fab051`。
- **新增**：
  - 好友组队匹配；
  - 普通房间的匹配补位（房主预选优先）；
  - 邀请改进；
  - 回放扫描改为只读 Worker。
- 规则见 [MATCHMAKING.md](MATCHMAKING.md) 和 [UPGRADE-025.md](UPGRADE-025.md)。

## v0.2.4-mimaglows.1（2026-10-12）

- **基础**：上游 v0.2.4；源码 `da7f8e8`（分支 `codex/windows-v0.2.4-custom`）。
- **首个公开的 Windows 定制版**，包含：
  - 虚拟账号与头像、账号配置与隐私同步、接管审批；
  - 服务器统计与对局详情、匿名回放分享；
  - 中日配音偏好；
  - 好友、标点与无线电。
- **文件**：`Stronghold-Protocol-Windows-v0.2.4-mimaglows.1.zip`（约 571 MB），SHA-256 `2501fee0f0d0c332a40bf732c98fd0701ed2e1734bfbcf5d600aa977a2685ab0`。
- **验证**：解压后 19110 个文件的 SHA-256 全部一致；122 项定制测试和 287 个 Golden 场景通过。
