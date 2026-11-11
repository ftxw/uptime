#!/usr/bin/env node
/**
 * 生成 dist/：把 public/ 复制过去，给 JS/CSS 加内容哈希文件名并改写 HTML 引用。
 *
 * 产物依然是纯静态文件 + 零运行时依赖；只是把「部署前」这一步显式化：
 * HTML 用 no-cache 每次回源验证，带哈希的 JS/CSS 用 immutable 长缓存，
 * 于是既不出现「新 HTML + 旧 JS」，也不用每次重新下载没变过的资源。
 * dist/ 已在 .gitignore 里，不入库；npm run dev / deploy 会自动先跑本脚本。
 */
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "public");
const OUT = join(ROOT, "dist");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const map = new Map(); // 源文件名 -> 带哈希文件名
for (const name of readdirSync(SRC).sort()) {
  if (name === "_headers") continue;
  const from = join(SRC, name);
  if (!statSync(from).isFile()) continue;
  if (/\.(?:js|css)$/.test(name)) {
    const buf = readFileSync(from);
    const h = createHash("sha256").update(buf).digest("hex").slice(0, 10);
    const dot = name.lastIndexOf(".");
    const hashed = `${name.slice(0, dot)}.${h}${name.slice(dot)}`;
    writeFileSync(join(OUT, hashed), buf);
    map.set(name, hashed);
  } else {
    copyFileSync(from, join(OUT, name));
  }
}

/** 改写三个页面里的 <script src="/x.js"> 与 <link href="/x.css">。 */
let refs = 0;
for (const name of readdirSync(SRC).filter((n) => n.endsWith(".html"))) {
  const html = readFileSync(join(SRC, name), "utf8");
  const out = html.replace(/(src|href)="\/([A-Za-z0-9._-]+\.(?:js|css))"/g, (m, attr, file) => {
    const target = map.get(file);
    if (!target) return m;
    refs++;
    return `${attr}="/${target}"`;
  });
  writeFileSync(join(OUT, name), out);
}

// 产物里的 JS/CSS 全部带哈希，可以安全地上 immutable；HTML 仍由 /* 的 no-cache 管。
const headers = readFileSync(join(SRC, "_headers"), "utf8").replace(
  /(\/\*\.(?:js|css)\n  Cache-Control: ).*/g,
  "$1public, max-age=31536000, immutable"
);
writeFileSync(join(OUT, "_headers"), headers);

const htmlAll = readdirSync(SRC)
  .filter((n) => n.endsWith(".html"))
  .map((n) => readFileSync(join(SRC, n), "utf8"))
  .join("\n");
const unused = [...map.keys()].filter((f) => !htmlAll.includes(f));
console.log(
  `✓ dist/ 已生成：${map.size} 个带哈希资源，${refs} 处 HTML 引用已改写` +
    (unused.length ? `（源里未被任何页面引用：${unused.join(", ")}）` : "")
);
