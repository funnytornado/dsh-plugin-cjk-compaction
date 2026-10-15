# 验收记录

> 环境：Windows，DSH 0.1.7-rc.2（解包于 `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\`），
> 模型 `deepseek-official/deepseek-flash`，上下文窗口 1,000,000，请求预留输出 256,000。
> 日期：2026-10-15。

## 一、自动化测试

```
node test/estimate.test.mjs    5 项通过
node test/decision.test.mjs    6 项通过
```

`decision.test.mjs` 用一个假的 `ctx`（假的 tokenMeter / compaction / llm / session）
驱动 `agent/pre-step` 处理器，**不需要 DSH 运行时**，覆盖：

| 用例 | 断言 |
|---|---|
| 低于水位 | 不调用压缩，且必须放行这一步 |
| 中文加权 | 纯英文不越线；同样内容换成中文后越线并触发 |
| 区间选择 | 从第一个非 system 节点开始，且保留足够的近期尾巴 |
| 边界被拒 | 官方报"不是平衡边界"时，自动回退到更早的边界 |
| 非边界类错误 | 官方报"摘要不比原文小"时直接放弃，不继续试探 |
| 冷却 | 压过一次后进入冷却，不会连环压 |

## 二、真机端到端

### 方法

用一个 **CLI 管理的隔离 profile**（`headless`），不碰 Electron 应用托管的 `desktop`
profile：

```powershell
node scripts/install.mjs --profile headless
```

安装脚本的复验输出：

```
复验：清单无 BOM=true 可解析=true 插件已就位=true 解析链接可用=true
```

然后把测试档配置（把水位压到 1.5%、保留尾巴压到 0.2%、关掉冷却）写进该 profile 的
插件配置，跑一个会连续读大文件的任务，让插件把判定过程写进 `traceFile`。

### 端到端 trace（原始输出节选）

```
applied
no routed target
nodes=8  official=12670 cjk=2829  adjusted=14226 watermark=15000
nodes=11 official=14949 cjk=3062  adjusted=16633 watermark=15000
  range 8..21 rejected: compactRegion: end seq 21 is not a balanced boundary (would split a step, or the step is still open)
  range 8..19 rejected: compactRegion: end seq 19 is not a balanced boundary (would split a step, or the step is still open)
  SUCCESS 8..11
nodes=12 official=23147 cjk=18075 adjusted=33088 watermark=15000
  range 37..44 rejected: end seq 44 is not a balanced boundary
  SUCCESS 37..41
  range 51..61 rejected / 51..59 rejected
  SUCCESS 51..56
  SUCCESS 68..72
  SUCCESS 82..87
  SUCCESS 97..101
  SUCCESS 118..121
  SUCCESS 145..150
```

### 从这段 trace 能读到什么

1. **加权真的生效**：`official=23147 cjk=18075` → `adjusted=33088`。
   18,075 个中文字符 × (0.8 − 0.25) ≈ 9,941 的增量，与设计一致。
2. **决策链路是真的**：官方 `compactRegion` 被真实调用，返回的边界校验错误
   （`would split a step`）被正确捕获并回退。
3. **一次会话里提交了 8 次压缩**（`SUCCESS 8..11` 到 `SUCCESS 145..150`）。
   注意这是**测试档**（冷却 0、增长门槛 0）；生产默认档是冷却 5 分钟 + 增长 5 万，
   频率会低得多。
4. **失败路径也验证过**：另一次运行里官方以
   `summary is not smaller than the shadowed content (937 >= 921)` 拒绝，
   插件接受该判定、放弃本次，没有中断对话。

### 会话日志侧的旁证

用同目录的只读体检脚本扫描会话日志，最新会话中出现 **27 次 `compaction/*`
事件**，证明压缩确实落到了会话持久化层，而不只是插件内部日志。

## 三、没有验证到的部分

- **没有在 Electron 应用托管的 profile（`desktop`）里跑过**。DSH CLI 明确拒绝
  操作这类 profile（`managed exclusively by the Electron application`），
  所以插件在那里的行为是**推断**而非实测。
- **没有做长时间运行的稳定性验证**（例如连续几小时的会话）。
- **生产默认参数下的触发频率没有实测**（只在测试档下观察过）。
- 加权系数 0.8 token/字符来自公开 tokenizer 量级（中文约 0.6–1.7）
  的经验取值，没有在本机用真实 tokenizer 校准。

## 四、测试档配置（复现用）

```yaml
- insert:
    - id: cjk-compaction
      name: dsh-plugin-cjk-compaction
      config:
        enabled: true
        watermarkRatio: 0.015
        cjkTokensPerChar: 0.8
        baseTokensPerChar: 0.25
        retainRatio: 0.002
        cooldownMs: 0
        minGrowthTokens: 0
        maxRangeAttempts: 24
        dryRun: false
        debug: true
        traceFile: <你的路径>
```
