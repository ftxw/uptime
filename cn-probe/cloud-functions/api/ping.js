/**
 * GET /api/ping —— 探测臂自检：平台地域 + 出口 IP 归属。
 *
 * ## 为什么必须有这个接口
 * 上一版的教训：同时在 edgeone.json 里配了 `mainlandRegions` 与 `overseasRegions`，
 * 平台于是**按调用方位置做地域路由** —— 而调用方是 CF Worker（在境外），请求被
 * 路由到境外地域，测量数据全部作废，界面却只显示一句自报的城市名，看不出问题。
 * 现在 edgeone.json **只配 regions.mainland**，从根上消除歧义。
 *
 * 但"消除了歧义"还不够 —— 部署完仍然需要能**证明**出口真在境内。所以这里给两个来源：
 *   · platformRegion  平台自报（仅参考）
 *   · egress.country  **出网 IP 的真实归属**（判定依据）
 * 两者矛盾时以 egress 为准，并在 notes 里说清楚。
 *
 * 鉴权与 /api/probe、/api/ssl 完全一致（fail-closed）——
 * 否则「探测臂是否在线、出口在哪个国家」会变成任何人可读的情报。
 */

import { requireAuth, getEgress, verdictOf } from "../lib/core.js";

export async function onRequestGet(context) {
  const denied = requireAuth(context);
  if (denied) return denied;

  const expect = String(context.env.EXPECT_EGRESS_COUNTRY || "CN").toUpperCase();
  const egress = await getEgress();
  const platformRegion = context.server?.region ?? null;
  const verdict = verdictOf(egress, expect);

  const notes = [];
  // 平台自报与实测出口"看起来"矛盾时给明确提示。判据刻意保守：
  // 只在两地明显不同时提示，避免 ap-guangzhou vs 广州 这类命名差异造成误报。
  if (egress.country && platformRegion) {
    const r = String(platformRegion).toLowerCase();
    const overseaWords = ["singapore", "tokyo", "seoul", "hongkong", "taiwan", "japan", "korea"];
    if (egress.country === "CN" && overseaWords.some((w) => r.includes(w))) {
      notes.push(
        `平台自报 ${platformRegion} 看似境外地域，但实测出口归属 ${egress.country} —— ` +
          `请确认 edgeone.json 只配了 regions.mainland；多配 regions.overseas 会触发按调用方位置的地理路由`
      );
    }
  }
  if (verdict === "mismatch") {
    notes.push(`出口归属为 ${egress.country}，与期望的 ${expect} 不符 —— 测量数据不可用于国内站点`);
  }
  if (verdict === "unknown") {
    notes.push("未能判定出口归属（外部查询服务不可达），无法证明出口在期望国家");
  }

  return Response.json({
    ok: true,
    service: "cn-probe",
    platformRegion,
    egress,
    expectCountry: expect,
    egressVerdict: verdict,
    notes,
    ts: new Date().toISOString(),
    requestId: context.server?.requestId ?? null,
  });
}
