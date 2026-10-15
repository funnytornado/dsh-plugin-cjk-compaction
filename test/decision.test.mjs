import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

/** 构造一个假的 DSH ctx / agent / session，用来验证插件的决策链路（不需要 DSH 运行时）。 */
function harness(options) {
  const events = options.events;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const nodes = events.map((e) => e.seq);
  const calls = [];
  const handlers = new Map();
  let nextCalls = 0;

  const session = {
    surface: { nodes, replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    requestHeader: () => ({ config: { provider: "test", model: "m", maxTokens: options.maxTokens ?? 8192 } }),
  };
  const agent = { session };

  const ctx = {
    logger: { info() {}, warn() {} },
    tokenMeter: {
      measure: () => ({
        totalTokens: options.officialTotal,
        nodes: nodes.map((seq, i) => ({ seq, tokens: options.perNode[i] })),
      }),
    },
    get(name) {
      if (name === "compaction") {
        return {
          compactRegion: async (start, end) => {
            calls.push({ start, end });
            const behavior = options.compactRegion?.[calls.length - 1];
            if (behavior === "boundary") throw new Error("compactRegion: end seq " + end + " is not a balanced boundary (would split a step, or the step is still open)");
            if (behavior === "not-smaller") throw new Error("compactRegion: summary is not smaller than the shadowed content (900 >= 800)");
            return { shadowedSeqs: [start, end] };
          },
        };
      }
      if (name === "llm") {
        return { resolveModelInfo: async () => ({ context: { contextWindow: options.window }, defaultMaxTokens: 8192 }) };
      }
      return undefined;
    },
    on(event, handler) { handlers.set(event, handler); },
  };

  apply(ctx, { ...options.config, enabled: true, debug: false, traceFile: "" });
  const handler = handlers.get("agent/pre-step");
  assert.ok(handler, "插件必须注册 agent/pre-step");

  return {
    calls,
    run: async () => {
      await handler({ agent, signal: undefined }, () => { nextCalls += 1; });
      return nextCalls;
    },
  };
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const chinese = (n) => "中".repeat(n);

test("低于水位：不动手，但必须放行这一步", async () => {
  const h = harness({
    window: 1_000_000,
    officialTotal: 1_000,
    perNode: [100, 900],
    events: [
      { seq: 1, type: "system/message", data: text("system") },
      { seq: 2, type: "user/message", data: text("hello") },
    ],
    config: { watermarkRatio: 0.7, retainRatio: 0.16 },
  });
  const nextCalls = await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(nextCalls, 1);
});

test("同样的内容，中文加权后才越过安全线", async () => {
  const base = {
    window: 100_000,
    officialTotal: 30_100,
    perNode: [100, 10_000, 10_000, 10_000],
    config: { watermarkRatio: 0.35, retainRatio: 0.01, cooldownMs: 0, minGrowthTokens: 0 },
  };
  const plainEvents = [
    { seq: 1, type: "system/message", data: text("system") },
    { seq: 2, type: "user/message", data: text("hello") },
    { seq: 3, type: "assistant/message", data: text("world") },
    { seq: 4, type: "assistant/message", data: text("again") },
  ];

  // 纯英文：adjusted 30100 < watermark 35000，不动作
  const plain = harness({ ...base, events: plainEvents });
  await plain.run();
  assert.equal(plain.calls.length, 0, "纯英文时不应越过水位");

  // 换成中文：extra = 0.55 * 12000 = 6600 → adjusted 36700 > 35000，动手
  const cn = harness({
    ...base,
    events: [
      { seq: 1, type: "system/message", data: text("system") },
      { seq: 2, type: "user/message", data: text(chinese(4_000)) },
      { seq: 3, type: "assistant/message", data: text(chinese(4_000)) },
      { seq: 4, type: "assistant/message", data: text(chinese(4_000)) },
    ],
  });
  await cn.run();
  assert.equal(cn.calls.length, 1, "中文加权后应该越过水位并调用压缩");
});

test("选区从第一个非 system 节点开始，并保留近期尾巴", async () => {
  const events = [
    { seq: 1, type: "system/message", data: text("system") },
    { seq: 2, type: "user/message", data: text("u2") },
    { seq: 3, type: "assistant/message", data: text("a3") },
    { seq: 4, type: "tool/result", data: text("t4") },
    { seq: 5, type: "assistant/message", data: text("a5") },
    { seq: 6, type: "assistant/message", data: text("a6") },
  ];
  const h = harness({
    window: 1_000_000,
    officialTotal: 300_050,
    perNode: [50, 60_000, 60_000, 60_000, 60_000, 60_000],
    events,
    config: { watermarkRatio: 0.1, retainRatio: 0.16, cooldownMs: 0, minGrowthTokens: 0 },
  });
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].start, 2, "system 节点必须被排除");
  assert.ok(h.calls[0].end < 6, "必须保留足够的近期尾巴");
});

test("边界被官方拒绝时，自动回退到更早的边界", async () => {
  const events = [
    { seq: 1, type: "system/message", data: text("system") },
    { seq: 2, type: "user/message", data: text("u2") },
    { seq: 3, type: "assistant/message", data: text("a3") },
    { seq: 4, type: "tool/result", data: text("t4") },
    { seq: 5, type: "assistant/message", data: text("a5") },
    { seq: 6, type: "assistant/message", data: text("a6") },
  ];
  const h = harness({
    window: 1_000_000,
    officialTotal: 300_050,
    perNode: [50, 60_000, 60_000, 60_000, 60_000, 60_000],
    events,
    compactRegion: ["boundary", "ok"],
    config: { watermarkRatio: 0.1, retainRatio: 0.16, cooldownMs: 0, minGrowthTokens: 0 },
  });
  await h.run();
  assert.equal(h.calls.length, 2, "第一次被拒后应尝试第二个边界");
  assert.ok(h.calls[1].end < h.calls[0].end, "第二次的边界必须更靠前");
});

test("摘要不够小这类错误直接放弃，不抛给上层", async () => {
  const events = [
    { seq: 1, type: "system/message", data: text("system") },
    { seq: 2, type: "user/message", data: text("u2") },
    { seq: 3, type: "assistant/message", data: text("a3") },
    { seq: 4, type: "assistant/message", data: text("a4") },
  ];
  const h = harness({
    window: 1_000_000,
    officialTotal: 90_050,
    perNode: [50, 30_000, 30_000, 30_000],
    events,
    compactRegion: ["not-smaller"],
    config: { watermarkRatio: 0.05, retainRatio: 0.01, cooldownMs: 0, minGrowthTokens: 0 },
  });
  const nextCalls = await h.run();
  assert.equal(h.calls.length, 1, "这类错误不该继续试探其它边界");
  assert.equal(nextCalls, 1, "必须放行这一步");
});

test("压过之后进入冷却，不会连环压", async () => {
  const events = [
    { seq: 1, type: "system/message", data: text("system") },
    { seq: 2, type: "user/message", data: text("u2") },
    { seq: 3, type: "assistant/message", data: text("a3") },
    { seq: 4, type: "assistant/message", data: text("a4") },
  ];
  const h = harness({
    window: 1_000_000,
    officialTotal: 90_050,
    perNode: [50, 30_000, 30_000, 30_000],
    events,
    config: { watermarkRatio: 0.05, retainRatio: 0.01, cooldownMs: 300_000, minGrowthTokens: 50_000 },
  });
  await h.run();
  await h.run();
  await h.run();
  assert.equal(h.calls.length, 1, "冷却期内只允许压一次");
});
