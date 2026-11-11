#!/usr/bin/env node
/**
 * 零依赖的提交前自检：全部 JS 语法 + schema 生成物是否同步。
 * 不引入 lint/测试框架，CI 里 `npm run check` 就能挡住「改了 SQL 忘了重新生成」这类问题。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "public", "scripts"];
let failed = 0;
let total = 0;

for (const dir of DIRS) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const name of readdirSync(full).sort()) {
    if (!/\.(?:js|mjs)$/.test(name)) continue;
    const file = join(full, name);
    total++;
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
      failed++;
      console.error(`✗ ${relative(ROOT, file)}：${String(e.stderr || e.message || e).trim()}`);
    }
  }
}
console.log(`✓ 语法检查通过 ${total - failed}/${total} 个文件`);

try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "gen-schema.mjs"), "--check"], {
    stdio: "inherit",
  });
} catch {
  failed++;
}

if (failed) {
  console.error(`✗ 自检未通过（${failed} 项）`);
  process.exit(1);
}
console.log("✓ 自检全部通过");
