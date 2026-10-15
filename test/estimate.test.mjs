import test from "node:test";
import assert from "node:assert/strict";
import { countCjk, scanSession, selectCandidates, resolveConfig } from "../lib/index.js";

test("countCjk 只数方块字体系字符", () => {
  assert.equal(countCjk("你好世界"), 4);
  assert.equal(countCjk("hello world"), 0);
  assert.equal(countCjk("混合 mixed 文本 123"), 4);
  assert.equal(countCjk("こんにちは"), 5);
  assert.equal(countCjk(""), 0);
  assert.equal(countCjk(null), 0);
});

test("resolveConfig 默认值", () => {
  const c = resolveConfig(undefined);
  assert.equal(c.watermarkRatio, 0.7);
  assert.equal(c.cjkTokensPerChar, 0.8);
  assert.equal(c.retainRatio, 0.16);
  assert.equal(c.dryRun, false);
});

// 造一个最小 session：surface.nodes + eventAt
function fakeSession(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    surface: { nodes: events.map((e) => e.seq), replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
  };
}

test("scanSession 按 CJK 字符数抬高中文节点", () => {
  const s = fakeSession([
    { seq: 1, type: "system/message", data: { content: [{ type: "text", text: "system" }] } },
    { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "这是一段中文" }] } },
  ]);
  const measurement = { totalTokens: 100, nodes: [{ seq: 1, tokens: 10 }, { seq: 2, tokens: 12 }] };
  const extra = 0.8 - 0.25;
  const out = scanSession(s, measurement, extra, new WeakMap());
  assert.equal(out.cjkTotal, 6);
  assert.equal(out.adjusted.get(2), 12 + extra * 6);
});

test("selectCandidates 从尾部保留预算并给出多个候选边界", () => {
  const events = [
    { seq: 1, type: "system/message", data: {} },
    { seq: 2, type: "user/message", data: {} },
    { seq: 3, type: "assistant/message", data: {} },
    { seq: 4, type: "user/message", data: {} },
    { seq: 5, type: "assistant/message", data: {} },
  ];
  const s = fakeSession(events);
  const adjusted = new Map([[1, 10], [2, 100], [3, 100], [4, 100], [5, 100]]);
  const candidates = selectCandidates(s, [1, 2, 3, 4, 5], adjusted, 250, 10);
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].start, 2, "system 节点不参与压缩");
  assert.ok(candidates[0].end < 5, "至少要保留一个尾部节点");
  for (const c of candidates) assert.ok(c.end >= c.start);
});

test("selectCandidates 无内容时返回空", () => {
  const s = fakeSession([{ seq: 1, type: "system/message", data: {} }]);
  assert.deepEqual(selectCandidates(s, [1], new Map(), 10, 5), []);
});
