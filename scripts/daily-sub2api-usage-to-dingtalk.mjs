import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

loadDotEnv();

const localOutput = process.argv.includes("--local-output");
const dryRun = process.argv.includes("--dry-run");
const noStateWrite = process.argv.includes("--no-state-write");

let config;

try {
  config = readConfig();
  const { startDate, endDate } = getYesterdayRange(config.timeZone);
  const stats = await fetchSub2ApiUsageStats(startDate, endDate);
  const cumulative = updateCumulativeActualCost(startDate, toNumber(stats.total_actual_cost));
  const reportText = buildReportText(stats, startDate, cumulative);
  const message = buildDingtalkMessage(reportText, buildReportTitle(startDate));

  if (localOutput) {
    console.log(reportText);
  } else if (dryRun) {
    console.log(JSON.stringify(message, null, 2));
  } else {
    await sendDingtalkMessage(message);
    console.log(`Sent Sub2API usage report for ${startDate}.`);
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readConfig() {
  const authType = process.env.SUB2API_AUTH_TYPE || inferSub2ApiAuthType(requiredEnv("SUB2API_TOKEN"));
  if (!["user_jwt", "admin_api_key"].includes(authType)) {
    throw new Error("SUB2API_AUTH_TYPE must be user_jwt or admin_api_key");
  }

  return {
    sub2apiBaseUrl: requiredEnv("SUB2API_BASE_URL").replace(/\/+$/, ""),
    sub2apiToken: requiredEnv("SUB2API_TOKEN"),
    sub2apiAuthType: authType,
    dingtalkWebhook: localOutput ? process.env.DINGTALK_WEBHOOK || "" : requiredEnv("DINGTALK_WEBHOOK"),
    dingtalkSecret: process.env.DINGTALK_SECRET || "",
    timeZone: process.env.REPORT_TIMEZONE || "Asia/Shanghai",
    title: process.env.REPORT_TITLE || "Sub2API 昨日用量",
    cumulativeBaseActualCost: parseEnvNumber("CUMULATIVE_BASE_ACTUAL_COST", 2551),
    cumulativeStateFile: process.env.CUMULATIVE_STATE_FILE || "data/cumulative-actual-cost.json",
    requestTimeoutMs: parseEnvNumber("REQUEST_TIMEOUT_MS", 30_000),
  };
}

function inferSub2ApiAuthType(token) {
  return token.startsWith("admin-") ? "admin_api_key" : "user_jwt";
}

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseEnvNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }

  return value;
}

function getYesterdayRange(timeZone) {
  const todayNoonUtc = dateAtTimeZoneNoon(new Date(), timeZone);
  const yesterdayNoonUtc = new Date(todayNoonUtc.getTime() - 24 * 60 * 60 * 1000);

  return {
    startDate: formatDateInTimeZone(yesterdayNoonUtc, timeZone),
    endDate: formatDateInTimeZone(todayNoonUtc, timeZone),
  };
}

function dateAtTimeZoneNoon(date, timeZone) {
  const parts = getDateParts(date, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
}

function formatDateInTimeZone(date, timeZone) {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

async function fetchSub2ApiUsageStats(startDate, endDate) {
  const isAdminApiKey = config.sub2apiAuthType === "admin_api_key";
  const url = new URL(
    `${config.sub2apiBaseUrl}${isAdminApiKey ? "/api/v1/admin/usage/stats" : "/api/v1/usage/stats"}`,
  );
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", isAdminApiKey ? startDate : endDate);
  url.searchParams.set("timezone", config.timeZone);

  const response = await fetch(url, {
    headers: buildSub2ApiAuthHeaders(),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await readJsonResponse(response, "Sub2API usage stats");
  if (!response.ok || body.code !== 0) {
    throw new Error(
      `Sub2API request failed: HTTP ${response.status}, code=${body.code}, message=${body.message || ""}`,
    );
  }

  return body.data || {};
}

function buildSub2ApiAuthHeaders() {
  const headers = {
    Accept: "application/json",
  };

  if (config.sub2apiAuthType === "admin_api_key") {
    headers["x-api-key"] = config.sub2apiToken;
  } else {
    headers.Authorization = `Bearer ${config.sub2apiToken}`;
  }

  return headers;
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

function buildReportText(stats, reportDate, cumulative) {
  const requests = toNumber(stats.total_requests);
  const inputTokens = toNumber(stats.total_input_tokens);
  const outputTokens = toNumber(stats.total_output_tokens);
  const cacheTokens = toNumber(stats.total_cache_tokens);
  const totalTokens = toNumber(stats.total_tokens);
  const actualCost = toNumber(stats.total_actual_cost);
  const averageDurationMs = toNumber(stats.average_duration_ms);
  const title = buildReportTitle(reportDate);

  return [
    `### ${title}`,
    "",
    `统计日期：${reportDate}`,
    "",
    `- 使用额度：${formatUsd(actualCost)}`,
    `- 平均耗时：${formatDuration(averageDurationMs)}`,
    `- 请求数：${formatCompactNumber(requests, "次")}`,
    `- 输入 Tokens：${formatCompactNumber(inputTokens, "tokens")}`,
    `- 输出 Tokens：${formatCompactNumber(outputTokens, "tokens")}`,
    `- 缓存 Tokens：${formatCompactNumber(cacheTokens, "tokens")}`,
    `- 总 Tokens：${formatCompactNumber(totalTokens, "tokens")}`,

    ``,
    `------`,
    ``,
    
    `- 累计已使用：${formatUsd(cumulative.totalActualCost)}`,
  ].join("\n");
}

function updateCumulativeActualCost(reportDate, actualCost) {
  const state = readCumulativeState();
  state.dailyActualCosts[reportDate] = actualCost;

  const historyTotal = Object.values(state.dailyActualCosts).reduce(
    (sum, value) => sum + toNumber(value),
    0,
  );
  state.totalActualCost = state.baseActualCost + historyTotal;
  state.updatedAt = new Date().toISOString();

  if (!noStateWrite) {
    writeCumulativeState(state);
  }
  return state;
}

function readCumulativeState() {
  const statePath = resolveStateFilePath();
  if (!fs.existsSync(statePath)) {
    return createInitialCumulativeState();
  }

  const raw = fs.readFileSync(statePath, "utf8");
  try {
    const state = JSON.parse(raw);
    return normalizeCumulativeState(state);
  } catch {
    throw new Error(`Invalid cumulative state JSON: ${statePath}`);
  }
}

function createInitialCumulativeState() {
  return normalizeCumulativeState({
    baseActualCost: config.cumulativeBaseActualCost,
    dailyActualCosts: {},
  });
}

function normalizeCumulativeState(state) {
  const dailyActualCosts =
    state && typeof state.dailyActualCosts === "object" && !Array.isArray(state.dailyActualCosts)
      ? state.dailyActualCosts
      : {};

  const normalizedDailyCosts = {};
  for (const [date, value] of Object.entries(dailyActualCosts)) {
    normalizedDailyCosts[date] = toNumber(value);
  }

  const baseActualCost = Number.isFinite(Number(state?.baseActualCost))
    ? Number(state.baseActualCost)
    : config.cumulativeBaseActualCost;
  const historyTotal = Object.values(normalizedDailyCosts).reduce((sum, value) => sum + value, 0);

  return {
    baseActualCost,
    dailyActualCosts: normalizedDailyCosts,
    totalActualCost: baseActualCost + historyTotal,
    updatedAt: state?.updatedAt || null,
  };
}

function writeCumulativeState(state) {
  const statePath = resolveStateFilePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${statePath}.tmp`, statePath);
}

function resolveStateFilePath() {
  return path.resolve(process.cwd(), config.cumulativeStateFile);
}

function buildReportTitle(reportDate) {
  return `${config.title}（${reportDate}）`;
}

function buildDingtalkMessage(text, title) {
  return {
    msgtype: "markdown",
    markdown: {
      title,
      text,
    },
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatCompactNumber(value, unit) {
  const abs = Math.abs(value);
  const scales = [
    { threshold: 1_000_000_000, suffix: "B", divisor: 1_000_000_000 },
    { threshold: 1_000_000, suffix: "M", divisor: 1_000_000 },
    { threshold: 1_000, suffix: "K", divisor: 1_000 },
  ];

  const scale = scales.find((item) => abs >= item.threshold);
  if (!scale) {
    return `${formatDecimal(value, 1)} ${unit}`;
  }

  return `${formatDecimal(value / scale.divisor, 1)} ${scale.suffix} ${unit}`;
}

function formatUsd(value) {
  return `$${formatDecimal(value, 1)} USD`;
}

function formatDuration(valueMs) {
  if (Math.abs(valueMs) < 1_000) {
    return `${formatDecimal(valueMs, 1)} ms`;
  }

  return `${formatDecimal(valueMs / 1_000, 1)} s`;
}

function formatDecimal(value, digits) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

async function sendDingtalkMessage(message) {
  const response = await fetch(buildDingtalkWebhookUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await readJsonResponse(response, "DingTalk webhook");
  if (!response.ok || body.errcode !== 0) {
    throw new Error(
      `DingTalk request failed: HTTP ${response.status}, errcode=${body.errcode}, errmsg=${body.errmsg || ""}`,
    );
  }
}

function buildDingtalkWebhookUrl() {
  if (!config.dingtalkSecret) {
    return config.dingtalkWebhook;
  }

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${config.dingtalkSecret}`;
  const sign = encodeURIComponent(
    crypto.createHmac("sha256", config.dingtalkSecret).update(stringToSign).digest("base64"),
  );
  const separator = config.dingtalkWebhook.includes("?") ? "&" : "?";

  return `${config.dingtalkWebhook}${separator}timestamp=${timestamp}&sign=${sign}`;
}
