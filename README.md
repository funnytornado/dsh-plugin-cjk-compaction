# dsh-plugin-cjk-compaction

给 DeepSeek Harness (DSH) 用的**中文感知上下文压力护栏**。

DSH 内建的 token 估算是固定 **4 字符/token**（即 0.25 token/字符）。中文实际大约
**0.6–1.7 token/字符**，也就是说中文内容被系统性低估 **2.4–6.8 倍**。后果是压缩
触发得太晚：估算器认为"才 40 万 token"，真实输入可能已经顶到窗口，直到 provider
报 `CONTEXT_WINDOW_EXCEEDED` 才被动补救。

本插件在每一步派发前用按字符集加权的估算重新衡量上下文；加权值越过安全线时，
自己挑一个**合法的可压区间**，调用官方 `ctx.compaction.compactRegion` 强制压缩一次。

## 安装

### 前置：两个必须同时满足的条件

DSH 的插件挂载有一个**很容易踩的坑**，本项目在真机上踩过：

1. **profile 的 `package.json` 里要登记依赖，并加入 `dsh.profile.bundles`**；
2. **包必须能从 `$DSH_HOME/profiles/node_modules` 解析到**——只放在
   `$DSH_HOME/profiles/<profile>/node_modules` 里**不够**。官方包全部以 junction
   形式挂在 `profiles/node_modules/@deepseek-ai/` 下，第三方插件同理需要一个
   可解析的入口。

另外：**挂载失败是静默的**。cordis 的挂载错误只进 DSH 内部 logger，不出现在
CLI 输出里。所以"配置里能看到条目"不等于"插件真的被加载"——请按下面的
「验证」一节实测。

### 方式一：安全安装脚本（推荐）

```powershell
node scripts/install.mjs --profile <profile 名>
```

它会：校验目标 profile 清单（无 BOM 且能 `JSON.parse`）→ 备份 → 写入依赖与
bundle 条目 → 复制插件 → 在 `profiles/node_modules` 建解析链接 → 逐项复验。
全程用 Node 写文件，**不会产生 BOM**。

> 注意：被 Electron 应用独占管理的 profile（例如 `desktop`）CLI 会拒绝操作
> （报 `profile "..." is managed exclusively by the Electron application`）。
> 这类 profile 请用应用自带的插件管理入口，或改用 CLI 管理得到的 profile。

### 方式二：手工安装

1. 把本包放到 `$DSH_HOME/profiles/<profile>/dsh-plugin-cjk-compaction`；
2. 在该 profile 的 `package.json` 里加入依赖
   `"dsh-plugin-cjk-compaction": "link:<上面的绝对路径>"`，并把
   `"dsh-plugin-cjk-compaction"` 追加到 `dsh.profile.bundles`；
3. 在 `$DSH_HOME/profiles/node_modules/` 下建一个同名 junction 指向它；
4. **改完必须做校验**：`JSON.parse` 通过、且文件前三个字节不是 `EF BB BF`。
   profile 清单带 BOM 会让 DSH 启动直接失败（`readProfileManifest` 抛错）。

重启 DSH 后生效。

## 配置

配置写在插件自己的 `cordis.patch.yml`（作为 bundle patch 层），或按 DSH 的
patch 规则覆盖：

```yaml
- insert:
    - id: cjk-compaction
      name: dsh-plugin-cjk-compaction
      config:
        enabled: true
        watermarkRatio: 0.7
        cjkTokensPerChar: 0.8
        baseTokensPerChar: 0.25
        retainRatio: 0.16
        cooldownMs: 300000
        minGrowthTokens: 50000
        maxRangeAttempts: 24
        dryRun: false
        debug: false
        traceFile: ""
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `watermarkRatio` | `0.7` | 加权估算达到窗口的这个比例就动手 |
| `cjkTokensPerChar` | `0.8` | 中日韩字符按多少 token/字符重估 |
| `baseTokensPerChar` | `0.25` | DSH 内建估算的基准，用于计算增量 |
| `retainRatio` | `0.16` | 压缩后逐字保留的近期尾巴比例（按 `窗口 − 输出预留` 计） |
| `cooldownMs` | `300000` | 两次强制压缩之间的冷却 |
| `minGrowthTokens` | `50000` | 压完之后必须再长这么多，才允许压下一次 |
| `maxRangeAttempts` | `24` | 官方边界校验不过时，往前退几个边界重试 |
| `dryRun` | `false` | 只记录不压缩，用于首次观察 |
| `debug` | `false` | 把判定过程写到 stderr |
| `traceFile` | 空 | 填路径则把每次判定追加写入该文件（排查用） |

## 行为与安全保证

- **绝不中断对话**：所有异常都被捕获，只写日志，然后照常放行这一步。
- **不硬来**：官方边界校验（"会不会切断一个 step / 工具调用对"）不通过时，自动
  尝试更早的边界；全部不通过就放弃本次。
- **接受官方的质量判定**：官方引擎若认为"摘要不比被压内容小"，本插件直接放弃本次。
- **不连环压**：冷却时间 + 增长门槛双重限制。
- **不做全局替换**：不改 `ctx.tokenMeter`，只旁路自己算，因此不影响界面上的
  token 数字与统计投影。

## 验证

```bash
node test/estimate.test.mjs   # 5 项：字符集计数、配置解析、扫描与区间选择
node test/decision.test.mjs   # 6 项：决策链路（假 ctx，不需要 DSH 运行时）
```

`decision.test.mjs` 覆盖：低于水位不动作、中文加权后才越线、选区间保留尾巴且
排除 system 头、边界被拒自动回退、非边界类错误直接放弃、冷却生效。

真机端到端验收记录（含 trace 原始输出与复现步骤）见
[docs/acceptance.md](docs/acceptance.md)。

## 已知限制

- 只覆盖"中文多、加权估算被抬高"的场景。纯英文内容下不介入，由 DSH 官方阈值先行。
- 依赖官方 `CompactionEngine.compactRegion` 的公开接口；若官方改了接口或边界
  语义，插件会退化为"只告警不压缩"，不会破坏会话。
- 没有任何自动化测试跑在真实 DSH 运行时里。`docs/acceptance.md` 里的端到端
  结论来自一次隔离 profile 的手工验证。

## 卸载

1. 从 profile 的 `package.json` 删掉依赖行与 bundles 条目（保持合法 JSON、无 BOM）；
2. 删掉 `profiles/<profile>/dsh-plugin-cjk-compaction` 与
   `profiles/node_modules/dsh-plugin-cjk-compaction`；
3. 重启 DSH。

## License

MIT
