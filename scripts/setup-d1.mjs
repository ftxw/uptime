#!/usr/bin/env node
/**
 * 部署前准备 D1：确保数据库存在 → 绑定写进 wrangler.toml → 建表。
 *
 * 这一步让「首次部署」不需要任何手工操作：
 *   1. 列出账号下的 D1，找同名库
 *   2. 没有就创建（--update-config 会自动把 database_id 写回 wrangler.toml，即自动绑定）
 *   3. 已有则确保 wrangler.toml 里的 database_id 与实际一致（例如换账号后配置过期）
 *   4. 执行 schema.sql 建表（语句都是 IF NOT EXISTS，重复执行安全）
 *
 * 全程幂等：每次部署都跑一遍也不会重复建库、不会丢数据。
 *
 * 用法：node scripts/setup-d1.mjs
 * 环境变量（可选）：D1_NAME / D1_LOCATION
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "wrangler.toml");
const SCHEMA = join(ROOT, "schema.sql");
const DB_NAME = process.env.D1_NAME || "site-monitor-db";
const BINDING = "DB";
const LOCATION = process.env.D1_LOCATION || "apac"; // 亚太：离中国大陆最近的 D1 主区域提示

/**
 * 优先用项目本地安装的 wrangler（CI 里 npm install 之后就有），
 * 这样不必每次联网下载；没装才退回 npx。
 * Windows 的本地可执行文件是 .cmd，且路径含空格要加引号。
 */
function wranglerBin() {
  const local = join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
  return existsSync(local) ? `"${local}"` : "npx --yes wrangler@latest";
}

/** 调用 wrangler。Windows 上 npx 是 .cmd，必须用 shell 才能解析。 */
function wrangler(args, tolerateError = false) {
  try {
    return execFileSync(`${wranglerBin()} ${args.join(" ")}`, {
      cwd: ROOT,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    if (tolerateError) return "";
    const err = String(e.stderr || e.message || e).trim();
    throw new Error(`wrangler ${args.join(" ")} 失败：\n${err}`);
  }
}

/** 列出 D1；拿不到（未登录 / 无权限 / 网络问题）返回 null，由调用方决定降级 */
function listD1() {
  try {
    const out = wrangler(["d1", "list", "--json"]);
    // 输出前面可能带 wrangler 的提示行，从第一个 JSON 起始符开始截取
    const start = out.search(/[[{]/);
    if (start < 0) return null;
    const j = JSON.parse(out.slice(start));
    return Array.isArray(j) ? j : Array.isArray(j?.result) ? j.result : [];
  } catch (e) {
    console.error(e.message);
    return null;
  }
}

function createD1() {
  // ⚠️ 不用 --update-config：实测当 wrangler.toml 里已存在同名 binding 段时，
  //    它**不会**更新配置（静默跳过），导致建了库却没绑定。
  //    这里只负责建库，配置一律由 writeD1Config() 自己写，行为确定。
  wrangler(["d1", "create", DB_NAME, "--location", LOCATION]);
}

/** 写入 [[d1_databases]] 段：database_name 与 database_id */
function writeD1Config(name, uuid) {
  const toml = readFileSync(CONFIG, "utf8");
  const m = toml.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|\n*$)/);
  if (!m) {
    console.error("✗ wrangler.toml 里找不到 [[d1_databases]] 段");
    process.exit(1);
  }
  const block = m[0];
  const updated = block
    .replace(/database_name\s*=\s*"[^"]*"/, `database_name = "${name}"`)
    .replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${uuid}"`);
  if (updated === block) {
    console.error("✗ [[d1_databases]] 段里缺少 database_name / database_id 字段");
    process.exit(1);
  }
  writeFileSync(CONFIG, toml.replace(block, updated));
}

/** 读当前配置，用于判断是否需要改写 */
function readD1Config() {
  const toml = readFileSync(CONFIG, "utf8");
  const m = toml.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|\n*$)/);
  if (!m) return { name: "", id: "" };
  return {
    name: (m[0].match(/database_name\s*=\s*"([^"]*)"/) || [])[1] || "",
    id: (m[0].match(/database_id\s*=\s*"([^"]*)"/) || [])[1] || "",
  };
}

function runSchema() {
  wrangler(["d1", "execute", DB_NAME, "--remote", "--file=./schema.sql"]);
}

/* ── 主流程 ───────────────────────────────────────────── */

const first = listD1();
if (first === null) {
  // 列不出库：通常是本地没登录。不阻断部署 —— wrangler deploy 自己会报同样的错。
  console.log(
    "⚠ 无法访问 Cloudflare（未登录或网络不通），跳过 D1 自动准备。\n" +
      "  若在 CI 中运行，请确认已注入 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID。"
  );
  process.exit(0);
}

let db = first.find((d) => d.name === DB_NAME);

if (!db) {
  console.log(`→ 未找到 D1「${DB_NAME}」，正在创建（区域提示 ${LOCATION}）…`);
  createD1();
  // d1 create 不支持 --json，拿不到 uuid，所以重新列一次
  db = (listD1() || []).find((d) => d.name === DB_NAME);
  if (!db) {
    console.error(`✗ 创建后仍找不到「${DB_NAME}」，请到控制台确认`);
    process.exit(1);
  }
  console.log(`✓ 已创建（${db.uuid.slice(0, 8)}…）`);
}

// 创建与复用都走这里：确保 wrangler.toml 的绑定与实际库一致
const cfg = readD1Config();
if (cfg.id === db.uuid && cfg.name === DB_NAME) {
  console.log(`✓ D1「${DB_NAME}」绑定正确（${db.uuid.slice(0, 8)}…）`);
} else {
  console.log(
    `→ 更新绑定：${cfg.name || "(空)"} / ${cfg.id || "(空)"} → ${DB_NAME} / ${db.uuid}`
  );
  writeD1Config(DB_NAME, db.uuid);
  console.log(`✓ 已写入 wrangler.toml（binding = ${BINDING}）`);
}

console.log("→ 执行 schema.sql 建表（IF NOT EXISTS，重复执行安全）…");
runSchema();
console.log("✓ 建表完成");
