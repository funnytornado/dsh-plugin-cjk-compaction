#!/usr/bin/env node
// 安全安装脚本：把本插件登记进指定的 DSH profile。
//
//   node scripts/install.mjs --profile <名字> [--dry-run]
//
// 之所以写成脚本，是因为手工改 profile 清单有两个坑：
//   1. 用 PowerShell 的文本 cmdlet 写 JSON 会带上 UTF-8 BOM，DSH 启动时
//      readProfileManifest 的 JSON.parse 会直接抛错，应用起不来；
//   2. 插件必须能从 profiles/node_modules 解析到，只放 profile 自己的
//      node_modules 里 DSH 不会加载它（而且失败是静默的）。
// 本脚本全程用 Node 写文件，并在每次写入后做 JSON 解析 + BOM 校验。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "dsh-plugin-cjk-compaction";
const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};
const PROFILE = argOf("profile", null);
const DRY = argv.includes("--dry-run");
const DSH_HOME = argOf("home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));

const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const parses = (text) => { try { JSON.parse(text); return true; } catch { return false; } };

function die(message) {
  console.error("install: " + message);
  process.exit(1);
}

if (!PROFILE) die("缺少 --profile <名字>（例如 --profile tui）");

const profileDir = path.join(DSH_HOME, "profiles", PROFILE);
const manifestPath = path.join(profileDir, "package.json");
if (!fs.existsSync(manifestPath)) die("找不到 profile 清单：" + manifestPath);

const raw = fs.readFileSync(manifestPath);
if (hasBom(raw)) die("profile 清单已经带 BOM，先修掉再装：" + manifestPath);
const text = raw.toString("utf8");
if (!parses(text)) die("profile 清单不是合法 JSON：" + manifestPath);

let next = text;
if (!text.includes(PLUGIN)) {
  const target = "link:" + path.join(profileDir, PLUGIN).replace(/\\/g, "/");
  const depAnchor = /("dependencies"\s*:\s*\{\s*\r?\n)(\s*)"/;
  const emptyDep = /"dependencies"\s*:\s*\{\s*\}/;
  const m = next.match(depAnchor);
  if (m) {
    const depLine = m[2] + '"' + PLUGIN + '": "' + target + '",\r\n' + m[2] + '"';
    next = next.replace(depAnchor, m[1] + depLine);
  } else if (emptyDep.test(next)) {
    next = next.replace(emptyDep, () => '"dependencies": {\r\n    "' + PLUGIN + '": "' + target + '"\r\n  }');
  } else {
    die("在清单里找不到 dependencies 块");
  }

  const bAnchor = /("bundles"\s*:\s*\[\s*\r?\n)([\s\S]*?)(\r?\n\s*\])/;
  const b = next.match(bAnchor);
  if (!b) die("在清单里找不到 dsh.profile.bundles 数组");
  const body = b[2].replace(/\s+$/, "");
  const indents = body.match(/\r?\n(\s*)"/g) || [];
  const indent = indents.length ? indents[indents.length - 1].replace(/[\r\n"]/g, "") : "    ";
  next = next.replace(bAnchor, b[1] + body + ",\r\n" + indent + '"' + PLUGIN + '"' + b[3]);
}
if (!parses(next)) die("改写后的清单不是合法 JSON，已放弃写入");
const parsed = JSON.parse(next);
if (!parsed.dependencies?.[PLUGIN] || !parsed.dsh?.profile?.bundles?.includes(PLUGIN)) {
  die("改写后清单里没有同时出现依赖与 bundle 条目，已放弃写入");
}

const pluginDir = path.join(profileDir, PLUGIN);
const linkDir = path.join(DSH_HOME, "profiles", "node_modules", PLUGIN);

console.log("profile  : " + profileDir);
console.log("清单     : " + manifestPath + (next === text ? "（已包含插件，跳过改写）" : "（将写入依赖 + bundle）"));
console.log("插件目录 : " + pluginDir);
console.log("解析链接 : " + linkDir);
if (DRY) { console.log("dry-run：没有做任何改动"); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
fs.writeFileSync(manifestPath + ".bak-" + stamp, text, "utf8");
fs.writeFileSync(manifestPath, next, "utf8");

fs.rmSync(pluginDir, { recursive: true, force: true });
fs.cpSync(PKG_ROOT, pluginDir, {
  recursive: true,
  filter: (src) => !/node_modules|\\.git(\\|$)/.test(src),
});

fs.mkdirSync(path.dirname(linkDir), { recursive: true });
fs.rmSync(linkDir, { recursive: true, force: true });
fs.symlinkSync(pluginDir, linkDir, process.platform === "win32" ? "junction" : "dir");

// 复验
const outBuf = fs.readFileSync(manifestPath);
const outText = outBuf.toString("utf8");
const ok =
  !hasBom(outBuf) &&
  parses(outText) &&
  outText.includes(PLUGIN) &&
  fs.existsSync(path.join(pluginDir, "lib", "index.js")) &&
  fs.existsSync(path.join(linkDir, "lib", "index.js"));

console.log("");
console.log("复验：清单无 BOM=" + !hasBom(outBuf) + " 可解析=" + parses(outText) + " 插件已就位=" + fs.existsSync(path.join(pluginDir, "lib", "index.js")) + " 解析链接可用=" + fs.existsSync(path.join(linkDir, "lib", "index.js")));
console.log(ok ? "安装完成，重启 DSH 后生效。" : "安装结果异常，请检查上面的路径。");
process.exit(ok ? 0 : 1);
