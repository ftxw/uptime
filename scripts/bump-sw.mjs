/**
 * 在部署前把 Service Worker 的版本号重写为「public/ 内容的哈希」。
 *
 * 为什么需要：SW 是**缓存优先**，只要缓存名不变，回访用户就会一直拿到旧文件，
 * 表现为「部署了新代码但界面没变」。原先靠人工把 VERSION +1，漏一次就中招。
 * 改成按 public/ 下所有文件的「路径 + 内容」算哈希后：
 * 任一待测文件改动 → 哈希变 → SHELL 缓存名变 → activate 时旧缓存被整个删掉。
 * 从机制上消除"忘了 bump"这一类故障。
 *
 * 为什么不用 git commit hash：部署不一定发生在 commit 之后，工作区脏时更不可靠；
 * 而文件内容哈希直接对应"浏览器要缓存的那批字节"，语义精确。
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(root, "public");
const swPath = join(publicDir, "sw.js");

/** sw.js 自身不计（它的 VERSION 行会被本脚本重写，纳入会自我循环）；_headers 是响应头配置，不影响缓存内容 */
const SKIP = new Set(["sw.js", "_headers"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(publicDir)
  .filter((p) => !SKIP.has(relative(publicDir, p).split(/[\\/]/).pop()))
  .sort();

const h = createHash("sha256");
for (const p of files) {
  const rel = relative(publicDir, p).split(/[\\/]/).join("/");
  h.update(rel);
  h.update("\0");
  h.update(readFileSync(p));
  h.update("\0");
}
const version = `v-${h.digest("hex").slice(0, 12)}`;

const src = readFileSync(swPath, "utf8");
const RE_VERSION = /const VERSION = "[^"]*";/;
if (!RE_VERSION.test(src)) {
  console.error('bump-sw: 没匹配到 const VERSION = "..."  ，请检查 sw.js 是否被改动');
  process.exit(1);
}
// ⚠️ 不能靠 "replace 后字符串是否变化" 来判断成功：
//    内容没变时算出的版本当然也不变，replace 前后完全相同 —— 那正是**幂等正常**的情形。
const next = src.replace(RE_VERSION, `const VERSION = "${version}";`);
writeFileSync(swPath, next);

console.log(`bump-sw: ${files.length} 个文件 -> VERSION = ${version}`);
