#!/usr/bin/env node
/**
 * 把 schema.sql 转成 src/schema.js（供 Worker 运行时建表用）。
 *
 * 为什么需要这一步：
 *   Worker 的包由 wrangler 打包，**读不到源码目录里的 .sql 文件**（运行期没有 fs）。
 *   而 Wrangler 的 `[[rules]] type = "Text"` 实测并不会把 .sql 内联进产物 ——
 *   构建结束时产物里反而多出一个独立的 schema.sql 文件，import 进来的是 undefined。
 *   所以生成一份 JS 数组：零构建配置依赖，`wrangler dev` 与 `wrangler deploy` 行为一致。
 *
 * 生成物要提交进仓库：Cloudflare 控制台接 GitHub 自动部署时只跑 `wrangler deploy`，
 * 不会执行本脚本，那时用的就是提交上去的这份。所以本脚本同时提供 `--check`
 * 用来确认两边没漂移。
 *
 * 用法：
 *   node scripts/gen-schema.mjs           # 生成 / 更新 src/schema.js
 *   node scripts/gen-schema.mjs --check   # 只校验是否与 schema.sql 同步（不一致则退出码 1）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "schema.sql");
const OUT = join(ROOT, "src", "schema.js");
const CHECK = process.argv.includes("--check");

/**
 * 归一化一条语句：剥掉行尾空白与此后产生的空行。
 *
 * 注释被丢弃后，原本「注释占的半行」会留下大片空白和连续空行 —— 不影响执行，
 * 但生成物会变成很难读的一坨。压成紧凑多行，正好适合在 JS 里看。
 */
function tidy(s) {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .filter((l) => l.length)
    .join("\n")
    .trim();
}

/**
 * 按 SQL 语法切分语句（不是简单的 `split(";")`）。
 *
 * 必须处理三种会把分号「藏起来」的地方，否则切出来的语句是坏的、而且报错指向莫名：
 *   ① 单引号字符串（含 `''` 转义）—— schema.sql 以后加 DEFAULT 'a;b' 就会踩到
 *   ② `--` 行注释 —— 本文件的注释大量出现，且里面就有分号
 *   ③ 块注释
 * 注释直接从输出里丢弃：建表语句不需要它们，留着只会让 D1 的报错信息变长。
 */
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === "'") {
      buf += c;
      i++;
      while (i < n) {
        buf += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            buf += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (c === ";") {
      const s = tidy(buf);
      if (s) out.push(s);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  const tail = tidy(buf);
  if (tail) out.push(tail);
  return out;
}

/** 解析 `-- schema-version: N`。缺失即报错 —— 版本号是迁移判断的唯一依据，不能默认。 */
function readVersion(sql, file) {
  const m = sql.match(/^--\s*schema-version:\s*(\d+)\s*$/m);
  if (!m) {
    console.error(
      `✗ ${file} 里找不到 \`-- schema-version: N\` 标记。\n` +
        "  这是 Worker 判断「库是否已是最新结构」的唯一依据，必须显式写一行。"
    );
    process.exit(1);
  }
  return Number(m[1]);
}

const raw = readFileSync(SRC, "utf8");
const version = readVersion(raw, "schema.sql");
const stmts = splitStatements(raw);

if (!stmts.length) {
  console.error("✗ schema.sql 里没解析出任何语句");
  process.exit(1);
}

/* 每个语句生成一行，缩进两级；语句内部的换行保留，方便在 schema.js 里直接读 */
const body = stmts.map((s) => `  ${JSON.stringify(s)},`).join("\n");

const comment = `/**
 * ⚠️ 生成文件，请勿手工编辑。
 *
 * 来源：schema.sql（改表结构请改那边，然后跑 \`npm run schema\`）
 * 生成器：scripts/gen-schema.mjs
 *
 * 为什么不在运行时直接读 schema.sql：Worker 的包里没有文件系统，
 * 而 Wrangler 的 module rules 实测不会把 .sql 内联进产物。生成 JS 数组是
 * 零构建配置依赖、且 dev / deploy 行为一致的方案。
 *
 * \`SCHEMA_STMTS\` 已按 SQL 语法切好（跳过注释、正确处理字符串内的分号），
 * 每条都是可单独 \`.run()\` 的完整语句，顺序即依赖顺序（先建表、后建索引）。
 */

export const SCHEMA_VERSION = ${version};

export const SCHEMA_STMTS = [
${body}
];
`;

if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== comment) {
    console.error(
      `✗ src/schema.js 与 schema.sql 不同步（schema.sql 现在是 v${version}，共 ${stmts.length} 条语句）。\n` +
        "  跑 `node scripts/gen-schema.mjs` 重新生成，并把结果一起提交。\n" +
        "  ⚠️ 云平台上直接 `wrangler deploy` 时用就是这份生成物，不同步会导致线上建出旧结构。"
    );
    process.exit(1);
  }
  console.log(`✓ src/schema.js 与 schema.sql 同步（v${version}，${stmts.length} 条语句）`);
  process.exit(0);
}

writeFileSync(OUT, comment);
console.log(
  `✓ 已生成 ${relative(ROOT, OUT)}（v${version}，${stmts.length} 条语句：` +
    `${stmts.filter((s) => /^CREATE\s+TABLE/i.test(s)).length} 表 / ` +
    `${stmts.filter((s) => /^CREATE\s+INDEX/i.test(s)).length} 索引）`
);
