#!/usr/bin/env node
/**
 * 部署前准备 D1：确保数据库存在 → 把 database_id 写进 wrangler.toml → 建表。
 *
 * 「克隆仓库 → 一条命令上线」的数据侧准备全在这里：不需要手工 `d1 create`、
 * 不需要复制 uuid、不需要单独跑建表。全程幂等，反复执行不会重复建库。
 *
 * 用法：
 *   node scripts/setup-d1.mjs                    # 准备生产库
 *   node scripts/setup-d1.mjs preview            # 准备预览库
 *   node scripts/setup-d1.mjs production preview # 两个都准备
 *
 * 环境变量：D1_NAME / D1_NAME_PREVIEW / D1_LOCATION
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "wrangler.toml");
const SCHEMA = join(ROOT, "schema.sql");
const LOCATION = process.env.D1_LOCATION || "apac"; // 亚太：离中国大陆最近的 D1 主区域提示

/**
 * 每个部署目标对应 wrangler.toml 里的一段 [[d1_databases]]。
 * 生产与预览必须是**两个库**：共用会让预览上的任何写操作直接落到生产数据上。
 */
const TARGETS = {
  production: {
    section: "[[d1_databases]]",
    name: process.env.D1_NAME || "uptime-db",
  },
  preview: {
    section: "[[env.preview.d1_databases]]",
    name: process.env.D1_NAME_PREVIEW || "uptime-db-preview",
  },
};

/**
 * 优先用项目本地安装的 wrangler（CI 里 npm install 之后就有），跳过下载；
 * 没装才退回 npx。Windows 的本地可执行文件是 .cmd，路径含空格要加引号。
 */
function wranglerBin() {
  const bin = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const local = join(ROOT, "node_modules", ".bin", bin);
  return existsSync(local) ? `"${local}"` : "npx --yes wrangler@latest";
}

/** Windows 上 npx 是 .cmd，必须走 shell 才能解析成可执行文件。 */
function wrangler(args) {
  // 走 shell 就必须自己处理分词：含空格的参数（如 --command=SELECT ...）加双引号。
  // 本项目这类参数里不含双引号，足以安全包裹。
  const cmd = args.map((a) => (/\s/.test(a) && !/^"[\s\S]*"$/.test(a) ? `"${a}"` : a)).join(" ");
  try {
    return execFileSync(`${wranglerBin()} ${cmd}`, {
      cwd: ROOT,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`wrangler ${args.join(" ")} 失败：\n${String(e.stderr || e.message || e).trim()}`);
  }
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** 列出账号下的 D1；拿不到（未登录 / 无权限 / 网络不通）返回 null */
function listD1() {
  try {
    const out = wrangler(["d1", "list", "--json"]);
    const start = out.search(/[[{]/); // 输出前面可能带 wrangler 的提示行
    if (start < 0) return null;
    const j = JSON.parse(out.slice(start));
    return Array.isArray(j) ? j : Array.isArray(j?.result) ? j.result : [];
  } catch (e) {
    console.error(e.message);
    return null;
  }
}

/** 定位 [[d1_databases]] / [[env.preview.d1_databases]] 段的起止行号 */
function findSection(section) {
  const raw = readFileSync(CONFIG, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === section);
  if (start < 0) fail(`wrangler.toml 里找不到 ${section} 段`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { raw, eol, lines, start, end };
}

function readBinding(section) {
  const { lines, start, end } = findSection(section);
  const block = lines.slice(start, end).join("\n");
  return {
    name: (block.match(/database_name\s*=\s*"([^"]*)"/) || [])[1] || "",
    id: (block.match(/database_id\s*=\s*"([^"]*)"/) || [])[1] || "",
  };
}

/**
 * 把 database_name / database_id 写进目标段。
 *
 * 为什么不用 `d1 create --update-config`：实测当配置文件里**已经存在**同名 binding 段时，
 * 它会静默跳过、不写配置 —— 结果是库建好了却没绑定。自己写行为确定。
 */
function writeBinding(section, name, uuid) {
  const { raw, eol, lines, start, end } = findSection(section);
  let hitName = false;
  let hitId = false;
  const replaced = lines.slice(start, end).map((l) => {
    if (/^\s*database_name\s*=/.test(l)) {
      hitName = true;
      return l.replace(/"[^"]*"/, `"${name}"`);
    }
    if (/^\s*database_id\s*=/.test(l)) {
      hitId = true;
      return l.replace(/"[^"]*"/, `"${uuid}"`);
    }
    return l;
  });
  if (!hitName || !hitId) {
    fail(`${section} 段里缺少 database_name / database_id 字段，无法写入绑定`);
  }
  writeFileSync(CONFIG, [...lines.slice(0, start), ...replaced, ...lines.slice(end)].join(eol));
}

/** 执行 schema.sql 建表。语句都是 IF NOT EXISTS，重复执行安全。 */
function runSchema(dbName) {
  wrangler(["d1", "execute", dbName, "--remote", `--file=${SCHEMA}`]);
}

/**
 * 从 CREATE TABLE 的字段体里取出列名。
 *
 * 只取每行首个标识符，跳过注释行与表级约束（PRIMARY KEY / UNIQUE / …）。
 * 够用于「结构是否齐全」的自检，不追求完整 SQL 解析。
 */
function colsFromBody(body) {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"))
    .map((l) => l.split(/\s+/)[0])
    .filter((c) => /^\w+$/.test(c) && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(c));
}

/** 从一条 CREATE TABLE 语句里取出列名 */
function colsFromDdl(ddl) {
  const open = ddl.indexOf("(");
  const close = ddl.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  return colsFromBody(ddl.slice(open + 1, close));
}

/** 从 schema.sql 解析出「表名 → 列名」 */
function parseSchema() {
  const sql = readFileSync(SCHEMA, "utf8");
  const out = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) out.set(m[1], colsFromBody(m[2]));
  return out;
}

/**
 * 读回线上库的实际「表名 → 列名」。
 *
 * 走 sqlite_master 的 sql 字段而非 pragma：D1 禁止访问 pragma_table_info()
 * （实测报 SQLITE_AUTH [7500]），而 sqlite_master 可读，且它保存的建表语句
 * 足够解析出列名。D1 自己的 _cf_ 内部表跳过。
 */
function remoteSchema(dbName) {
  const sql = "SELECT name AS t, sql AS ddl FROM sqlite_master WHERE type = 'table'";
  const out = wrangler(["d1", "execute", dbName, "--remote", "--json", `--command=${sql}`]);
  const start = out.search(/[[{]/);
  if (start < 0) fail(`读取「${dbName}」表结构失败，输出无法解析`);
  const j = JSON.parse(out.slice(start));
  const rows = (Array.isArray(j) ? j[0] : j)?.results || [];
  const have = new Map();
  for (const r of rows) {
    if (!r.t || String(r.t).startsWith("_cf_")) continue;
    have.set(r.t, colsFromDdl(String(r.ddl || "")));
  }
  return have;
}

/**
 * 建表后自检：schema.sql 里定义的表与列必须都在库里。
 *
 * 为什么必须有这一步：`IF NOT EXISTS` 对「已存在但结构较旧」的表什么都不做，
 * 于是改过 schema 之后部署仍能通过，直到运行时才报 no such column。
 * 与其让它在监测链路上炸，不如在部署这一步就停下来。
 */
function verifySchema(dbName) {
  const want = parseSchema();
  if (!want.size) fail(`schema.sql 里没解析出任何 CREATE TABLE，请检查文件格式`);

  const have = remoteSchema(dbName);
  const problems = [];
  for (const [table, cols] of want) {
    const got = have.get(table);
    if (!got) {
      problems.push(`缺表 ${table}`);
      continue;
    }
    const lack = cols.filter((c) => !got.includes(c));
    if (lack.length) problems.push(`${table} 缺列 ${lack.join(", ")}`);
  }
  if (!problems.length) return;

  fail(
    `「${dbName}」的结构与 schema.sql 不一致：\n  ${problems.join("\n  ")}\n\n` +
      `本项目不做增量迁移（schema.sql 全部 IF NOT EXISTS，不会给旧表补列）。\n` +
      `请换一个库名重新建库（D1_NAME=xxx npm run setup），或到控制台删除该库后重跑。`
  );
}

/* ── 主流程 ───────────────────────────────────────────── */

const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));

// 本地开发：只用本机 .wrangler/state 下的 SQLite 副本建表，不碰账号、不需要 uuid
if (asked.includes("local")) {
  console.log("→ 本地 D1 建表（不联网、不需要账号授权）…");
  wrangler(["d1", "execute", TARGETS.production.name, "--local", `--file=${SCHEMA}`]);
  console.log("✓ 完成");
  process.exit(0);
}

const targets = asked.length ? asked : ["production"];
for (const t of targets) {
  if (!TARGETS[t]) fail(`未知目标「${t}」，可选：local / ${Object.keys(TARGETS).join(" / ")}`);
}

const inventory = listD1();
if (inventory === null) {
  // 列不出库 = 没登录 / 没权限 / 网络不通。此时能不能继续，取决于配置里有没有 uuid：
  // 已填过就能离线部署；还空着就必须停下 —— 否则 deploy 会以一个说不清原因的错误失败。
  const missing = targets.filter((t) => !readBinding(TARGETS[t].section).id);
  if (missing.length) {
    fail(
      `无法访问 Cloudflare，且 ${missing.join(" / ")} 的 database_id 还是空的，无法准备 D1。\n` +
        "  请先 `npx wrangler login`；CI 中请注入 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID。"
    );
  }
  console.log(
    "⚠ 无法访问 Cloudflare（未登录或网络不通），已跳过 D1 自动准备；\n" +
      "  目标段的 database_id 已填过，继续按现有绑定部署。"
  );
  process.exit(0);
}

for (const key of targets) {
  const target = TARGETS[key];
  console.log(`\n── ${key}（${target.name}）──`);

  let db = inventory.find((d) => d.name === target.name);
  if (db) {
    console.log(`✓ 复用已存在的 D1（${db.uuid.slice(0, 8)}…）`);
  } else {
    console.log(`→ 未找到，正在创建（区域提示 ${LOCATION}）…`);
    // 不用 --update-config，原因见 writeBinding 注释
    wrangler(["d1", "create", target.name, "--location", LOCATION]);
    // d1 create 不支持 --json，拿不到 uuid，所以重新列一次
    db = (listD1() || []).find((d) => d.name === target.name);
    if (!db) fail(`创建后仍找不到「${target.name}」，请到控制台确认`);
    console.log(`✓ 已创建（${db.uuid.slice(0, 8)}…）`);
  }

  const cfg = readBinding(target.section);
  if (cfg.id === db.uuid && cfg.name === target.name) {
    console.log(`✓ ${target.section} 绑定正确`);
  } else {
    console.log(`→ 更新绑定：${cfg.name || "(空)"} / ${cfg.id || "(空)"} → ${target.name} / ${db.uuid}`);
    writeBinding(target.section, target.name, db.uuid);
    console.log("✓ 已写入 wrangler.toml");
  }

  console.log("→ 执行 schema.sql 建表…");
  runSchema(target.name);

  console.log("→ 校验表结构…");
  verifySchema(target.name);
  console.log(`✓ 建表完成（${parseSchema().size} 张表结构一致）`);
}
