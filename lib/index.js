// dsh-plugin-cjk-compaction — host half (v1.0.0)
//
// 在每一步派发前，用按字符集加权的估算重新衡量上下文；加权值超过安全线时，
// 自己挑一个边界，调用 compaction.compactRegion 强制压缩一次。
// 任何失败都只记日志，绝不影响对话本身。

import fs from "node:fs";

const LOG_PREFIX = "[cjk-compaction]";

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/gu;

export function countCjk(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const re = new RegExp(CJK_RE.source, "gu");
  let n = 0;
  while (re.exec(text) !== null) {
    n += 1;
    if (n > 20000000) break;
  }
  return n;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

export function eventText(session, seq) {
  let ev;
  try {
    ev = session.eventAt(seq);
  } catch {
    return "";
  }
  if (ev === undefined || ev === null) return "";
  return safeJson(ev.data);
}

export function scanSession(session, measurement, extraPerCjkChar, cacheMap) {
  const surface = session.surface ?? {};
  const nodes = Array.isArray(surface.nodes) ? surface.nodes : [];
  const generation = surface.replaceGeneration ?? 0;
  let cache = cacheMap.get(session);
  if (cache === undefined || cache.generation !== generation) {
    cache = { generation, cjk: new Map() };
    cacheMap.set(session, cache);
  }
  const measured = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
  const adjusted = new Map();
  let cjkTotal = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const seq = nodes[i];
    let cjk = cache.cjk.get(seq);
    if (cjk === undefined) {
      cjk = countCjk(eventText(session, seq));
      cache.cjk.set(seq, cjk);
    }
    cjkTotal += cjk;
    const base = measured[i]?.tokens ?? 0;
    adjusted.set(seq, base + extraPerCjkChar * cjk);
  }
  return { nodes, adjusted, cjkTotal };
}

export function selectCandidates(session, nodes, adjusted, retainTokens, maxAttempts) {
  const total = nodes.length;
  if (total < 2) return [];
  let headType;
  try {
    headType = session.eventAt(nodes[0])?.type;
  } catch {
    headType = undefined;
  }
  const firstIdx = headType === "system/message" ? 1 : 0;
  if (total - firstIdx < 2) return [];

  let accumulated = 0;
  let keepFrom = total;
  for (let i = total - 1; i >= firstIdx; i -= 1) {
    accumulated += adjusted.get(nodes[i]) ?? 0;
    keepFrom = i;
    if (accumulated >= retainTokens) break;
  }

  const out = [];
  for (let endIdx = keepFrom - 1; endIdx >= firstIdx && out.length < maxAttempts; endIdx -= 1) {
    out.push({ start: nodes[firstIdx], end: nodes[endIdx] });
  }
  return out;
}

export function resolveConfig(config) {
  return {
    enabled: config?.enabled !== false,
    watermarkRatio: Number(config?.watermarkRatio ?? 0.7),
    cjkTokensPerChar: Number(config?.cjkTokensPerChar ?? 0.8),
    baseTokensPerChar: Number(config?.baseTokensPerChar ?? 0.25),
    retainRatio: Number(config?.retainRatio ?? 0.16),
    cooldownMs: Number(config?.cooldownMs ?? 300000),
    minGrowthTokens: Number(config?.minGrowthTokens ?? 50000),
    maxRangeAttempts: Number(config?.maxRangeAttempts ?? 24),
    dryRun: config?.dryRun === true,
    debug: config?.debug === true,
    traceFile: typeof config?.traceFile === "string" && config.traceFile.length > 0 ? config.traceFile : "",
  };
}

export const name = "cjk-compaction";
export const inject = ["tokenMeter"];

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  const caches = new WeakMap();
  const state = new Map();
  const logger = ctx.logger ?? console;
  const log = (level, message) => {
    const fn = typeof logger[level] === "function" ? logger[level].bind(logger) : logger.log?.bind(logger);
    if (typeof fn === "function") fn(LOG_PREFIX + " " + message);
  };
  const dbg = (message) => {
    if (cfg.traceFile.length > 0) {
      try {
        fs.appendFileSync(cfg.traceFile, new Date().toISOString() + " " + message + "\n");
      } catch {
        /* ignore */
      }
    }
    if (!cfg.debug) return;
    try {
      console.error(LOG_PREFIX + " [debug] " + message);
    } catch {
      /* ignore */
    }
  };
  const service = (n) => {
    try {
      return ctx.get(n);
    } catch {
      return undefined;
    }
  };

  const extra = Math.max(0, cfg.cjkTokensPerChar - cfg.baseTokensPerChar);

  async function guard(agent, signal) {
    if (!cfg.enabled) return;
    if (signal?.aborted) { dbg("aborted"); return; }
    const session = agent?.session;
    if (session === undefined) { dbg("no session"); return; }
    const compaction = service("compaction");
    if (compaction === undefined || typeof compaction.compactRegion !== "function") {
      dbg("no compaction service");
      return;
    }
    const target = session.requestHeader?.()?.config;
    if (target === undefined || !target.provider || !target.model) { dbg("no routed target"); return; }

    const llm = service("llm");
    let window;
    try {
      const info = await llm?.resolveModelInfo?.(target.provider, target.model, signal);
      window = info?.context?.contextWindow;
    } catch (error) {
      dbg("resolveModelInfo failed: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    if (!Number.isFinite(window) || window <= 0) { dbg("no context window for " + target.provider + "/" + target.model); return; }

    const measurement = ctx.tokenMeter.measure(session);
    const { nodes, adjusted, cjkTotal } = scanSession(session, measurement, extra, caches);
    const adjustedTotal = Math.round(measurement.totalTokens + extra * cjkTotal);
    const watermark = Math.floor(window * cfg.watermarkRatio);
    dbg("nodes=" + nodes.length + " official=" + measurement.totalTokens + " cjk=" + cjkTotal
      + " adjusted=" + adjustedTotal + " watermark=" + watermark);
    if (adjustedTotal < watermark) return;

    const st = state.get(agent) ?? { lastAt: 0, lastAdjusted: 0 };
    const now = Date.now();
    if (now - st.lastAt < cfg.cooldownMs) { dbg("cooldown"); return; }
    if (st.lastAdjusted > 0 && adjustedTotal < st.lastAdjusted + cfg.minGrowthTokens) { dbg("no growth"); return; }

    const budget = window - (Number(target.maxTokens) || 0);
    const retainTokens = Math.max(1, Math.floor(budget * cfg.retainRatio));
    const candidates = selectCandidates(session, nodes, adjusted, retainTokens, cfg.maxRangeAttempts);
    if (candidates.length === 0) {
      log("warn", "over watermark (" + adjustedTotal + " >= " + watermark + ") but no compactable range");
      dbg("retainTokens=" + retainTokens + " nodes=" + nodes.length);
      return;
    }

    if (cfg.dryRun) {
      log("info", "dryRun: would compact " + candidates[0].start + ".." + candidates[0].end
        + " (adjusted " + adjustedTotal + " >= " + watermark + ")");
      return;
    }

    for (const candidate of candidates) {
      try {
        const result = await compaction.compactRegion(candidate.start, candidate.end, agent, signal);
        if (result === null || result === undefined) { dbg("range " + candidate.start + ".." + candidate.end + " returned null"); continue; }
        const after = ctx.tokenMeter.measure(session);
        const rescanned = scanSession(session, after, extra, caches);
        st.lastAt = now;
        st.lastAdjusted = Math.round(after.totalTokens + extra * rescanned.cjkTotal);
        state.set(agent, st);
        log("info", "forced compaction " + candidate.start + ".." + candidate.end
          + ": " + adjustedTotal + " -> " + st.lastAdjusted + " (window " + window + ")");
        dbg("SUCCESS " + candidate.start + ".." + candidate.end);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dbg("range " + candidate.start + ".." + candidate.end + " rejected: " + message);
        if (/balanced boundary|surface region/i.test(message)) continue;
        log("warn", "forced compaction failed: " + message);
        return;
      }
    }
    log("warn", "over watermark (" + adjustedTotal + " >= " + watermark + ") but no boundary passed validation");
  }

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    try {
      await guard(agent, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dbg("guard threw: " + message);
      log("warn", "guard failed, continuing the step: " + message);
    }
    return next();
  });

  log("info", "v1.0.0 loaded: watermark " + cfg.watermarkRatio + ", cjk " + cfg.cjkTokensPerChar
    + " tok/char, dryRun=" + cfg.dryRun + ", debug=" + cfg.debug);
  dbg("applied");
}