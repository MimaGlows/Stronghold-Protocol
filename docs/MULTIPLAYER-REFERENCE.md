# 五／六人规则与许可核对

核对日期：2026-10-14。参考仓库为 YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine，分支 `codex/rhine-upstream-021`，本次读取的提交为 `34d663efdd4a147570ff06081cf8cfaa2d5d22cb`。

来源：[MULTIPLAYER.md](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine/blob/34d663efdd4a147570ff06081cf8cfaa2d5d22cb/docs/MULTIPLAYER.md)、[许可说明](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine/blob/34d663efdd4a147570ff06081cf8cfaa2d5d22cb/NOTICE.md)、[LICENSE](https://github.com/YUYUYUYUYUYUYUTOUA/Stronghold-Protocol-Rhine/blob/34d663efdd4a147570ff06081cf8cfaa2d5d22cb/LICENSE)。作者维护的 README 与 NOTICE 明确将自编代码和文档按 GPL-3.0-or-later 发布，保留 Spine 组合分发附加许可；这构成按许可条件参考、修改和再分发的公开授权，不代表作者对本实验单独背书。分发代码须保留许可、署名及相应声明，二进制/非源码分发按许可提供对应源码。游戏数据、角色、美术、音乐与字体各自权属保持原状，不能将 GPL 当作这些素材的授权。

本实验在既有原版引擎中独立实现多人规则，保留上游 GPL、NOTICE 和第三方声明，并在此注明参考作者；不引入莱茵生命盟约、科研设备、扩展干员/装备、角色阶数与阵营联动。自定参数是本实验另行定义的规则。

| 原版多人部分 | 实验实现与验证 |
| --- | --- |
| 开局按实际真人及AI人数减少核心随机禁用，附加与固定禁用沿用原版 | 五人少1、六人少2，下限0；开局人数固定，掉线或淘汰不重新抽取。必选盟约仍受本实验2核心＋1附加上限约束。 |
| 普通作战各自阵地、最多两名协防者 | 一至六人均保留个人结算与原协防排序，不按人数扩张协防上限。 |
| BOSS按存活席位配对 | 五人2＋2＋1、六人2＋2＋2；减员重新配对，共享一个领袖池。 |
| 六人领袖池加强，五人保持原公式 | 六人按原版至多4名存活玩家的基准再乘2；五人按实际存活人数。其他原版属性不额外强化，自定倍率在其上单独应用。 |
| 五六人悬赏决策扩为9张 | 原6张保留，追加实际I／II／II阶目标，赏金1／2／2；同阶目标被原6张占用时可复用同阶目标，不将高阶敌人改标低阶。中途减员不回退张数。 |
| 六人R10／12／14每名存活者独立信标补给 | 真人及AI相同；不占普通商店库存，重复进入回合不重复发放，满手按原溢出规则处理。 |
| R14奖励信标即时转赠，其他信标下一休整 | 发放回合写入实例标记。R10/R12旧信标在R14使用仍延后；R14奖励在R15以后使用仍即时。保留原精锐形态，并沿用盟约人数优先、平票随机的收件人规则。 |
| 共享干员与装备库存 | 默认供给3保持原版库存。房主调整自定供给等级属于本实验独立配置，不将六人扩容直接当作扩库存。 |

基准规则只依赖开局的实际人数，容量6但只有4人时不会启用六人补偿。途中减员只影响存活人数相关的配对及生命池，不撤销开局人数相关规则。评分v3以这套人数规则作为对应参考基线，再计算自定压力与新增赏金补偿。

本次下载的许可文件校验：

| 文件 | SHA-256 |
| --- | --- |
| LICENSE | 3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986 |
| NOTICE.md | d87eba05ca14a6caafb63a56b3b3c15cc742e9453eabc68e97cb292e12257c62 |
| THIRD-PARTY-NOTICES.md | 9c405e5a41d15b80f8c4c67ea89a8c471beb8490aefdd1e68651583245d07c11 |
| docs/MULTIPLAYER.md | f2655f8e299afa31e0157ed1ba2e2baa7ed04000b767707c912e54afb9f816f3 |

完整下载快照在开发证据目录 `.development/rhine-reference/`；正式交付保留上述来源及校验信息。
