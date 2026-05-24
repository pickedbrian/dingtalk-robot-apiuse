import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

loadDotEnv();

const localOutput = process.argv.includes("--local-output");
const dryRun = process.argv.includes("--dry-run");
const noStateWrite = process.argv.includes("--no-state-write");
const todayDateOverride = readArgValue("--today") || readArgValue("--report-date");
const userBreakdownCandidateLimit = 200;
const excludedRankingEmails = new Set(["sinomisadmin@sub2api.local"]);

process.once("SIGINT", () => hardExit(130));
process.once("SIGTERM", () => hardExit(143));

let config;

try {
  config = readConfig();
  const { startDate, endDate } = getYesterdayRange(config.timeZone, todayDateOverride);
  const todayDate = endDate;
  const previousWeekRange = getPreviousWeekRange(todayDate);
  const previousDayRange = getPreviousDayRange(startDate);
  const stats = await fetchSub2ApiUsageStats(startDate, endDate);
  const previousDayStats = await fetchSub2ApiUsageStats(
    previousDayRange.startDate,
    previousDayRange.endDate,
  );
  const dailyTopUsers = await fetchTopUserTokenConsumers(startDate, startDate, 5);
  const cumulative = updateCumulativeActualCost(startDate, toNumber(stats.total_actual_cost));
  const reportText = buildReportText(stats, startDate, cumulative, dailyTopUsers, previousDayStats);
  const message = buildDingtalkMessage(reportText, buildReportTitle(startDate));
  const weeklyMessage = isMonday(todayDate)
    ? await buildWeeklyRankingMessage(previousWeekRange)
    : null;

  if (localOutput) {
    await writeStdout(`${reportText}\n`);
    if (weeklyMessage) {
      await writeStdout(`\n${weeklyMessage.markdown.text}\n`);
    }
  } else if (dryRun) {
    await writeStdout(`${JSON.stringify(compactMessages([message, weeklyMessage]), null, 2)}\n`);
  } else {
    await sendDingtalkMessage(message);
    if (weeklyMessage) {
      await sendDingtalkMessage(weeklyMessage);
    }
    await writeStdout(`Sent Sub2API usage report for ${startDate}.\n`);
  }
  hardExit(0);
} catch (error) {
  await writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
  hardExit(1);
}

function writeStdout(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function writeStderr(text) {
  return new Promise((resolve, reject) => {
    process.stderr.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function hardExit(code) {
  process.exitCode = code;
  process.exit(code);
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
    title: process.env.REPORT_TITLE || "昨日用量",
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

function readArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function getYesterdayRange(timeZone, todayDate) {
  if (todayDate) {
    const today = parseDateString(todayDate);
    const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
    return {
      startDate: formatUtcDate(addUtcDays(todayUtc, -1)),
      endDate: formatUtcDate(todayUtc),
    };
  }

  const todayNoonUtc = dateAtTimeZoneNoon(new Date(), timeZone);
  const yesterdayNoonUtc = new Date(todayNoonUtc.getTime() - 24 * 60 * 60 * 1000);

  return {
    startDate: formatDateInTimeZone(yesterdayNoonUtc, timeZone),
    endDate: formatDateInTimeZone(todayNoonUtc, timeZone),
  };
}

function getPreviousWeekRange(todayDate) {
  const date = parseDateString(todayDate);
  const today = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const dayOfWeek = today.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisWeekMonday = addUtcDays(today, -daysSinceMonday);

  return {
    startDate: formatUtcDate(addUtcDays(thisWeekMonday, -7)),
    endDate: formatUtcDate(addUtcDays(thisWeekMonday, -1)),
  };
}

function getPreviousDayRange(reportDate) {
  const date = parseDateString(reportDate);
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day));

  return {
    startDate: formatUtcDate(addUtcDays(day, -1)),
    endDate: formatUtcDate(addUtcDays(day, -1)),
  };
}

function getPreviousRange(range) {
  const start = parseDateString(range.startDate);
  const end = parseDateString(range.endDate);
  const startDate = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const endDate = new Date(Date.UTC(end.year, end.month - 1, end.day));
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;

  return {
    startDate: formatUtcDate(addUtcDays(startDate, -days)),
    endDate: formatUtcDate(addUtcDays(endDate, -days)),
  };
}

function parseDateString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date: ${value}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function isMonday(dateValue) {
  const date = parseDateString(dateValue);
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() === 1;
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

async function fetchTopUserTokenConsumers(startDate, endDate, limit) {
  const users = await fetchUserTokenConsumers(startDate, endDate, limit);
  return withUserNicknames(users);
}

async function fetchUserTokenConsumers(startDate, endDate, limit) {
  const url = new URL(`${config.sub2apiBaseUrl}/api/v1/admin/dashboard/user-breakdown`);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("timezone", config.timeZone);
  url.searchParams.set("limit", String(Math.max(limit, userBreakdownCandidateLimit)));

  const response = await fetch(url, {
    headers: buildSub2ApiAuthHeaders(),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await readJsonResponse(response, "Sub2API user breakdown");
  if (!response.ok || body.code !== 0) {
    throw new Error(
      `Sub2API user breakdown request failed: HTTP ${response.status}, code=${body.code}, message=${body.message || ""}`,
    );
  }

  const users = Array.isArray(body.data?.users) ? body.data.users : [];
  const topUsers = users
    .map((user) => ({
      userId: user.user_id,
      email: typeof user.email === "string" ? user.email : "",
      requests: toNumber(user.requests),
      totalTokens: toNumber(user.total_tokens),
      actualCost: toNumber(user.actual_cost),
    }))
    .filter((user) => !excludedRankingEmails.has(user.email.toLowerCase()))
    .filter((user) => user.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);

  return topUsers;
}

async function fetchUserBreakdownSummary(startDate, endDate) {
  const users = await fetchUserTokenConsumers(startDate, endDate, 200);
  return users.reduce(
    (summary, user) => ({
      totalActualCost: summary.totalActualCost + user.actualCost,
      totalTokens: summary.totalTokens + user.totalTokens,
    }),
    { totalActualCost: 0, totalTokens: 0 },
  );
}

async function withUserNicknames(users) {
  if (users.length === 0) {
    return users;
  }

  const nicknames = await fetchUserNicknames(users.map((user) => user.userId));
  if (nicknames.size === 0) {
    return users;
  }

  return users.map((user) => ({
    ...user,
    nickname: nicknames.get(String(user.userId)) || "",
  }));
}

async function fetchUserNicknames(userIds) {
  try {
    const nicknameAttributeId = await fetchNicknameAttributeId();
    if (nicknameAttributeId == null) {
      return new Map();
    }

    const attributes = await fetchBatchUserAttributes(userIds);
    const nicknames = new Map();
    for (const [userId, values] of Object.entries(attributes)) {
      const nickname = values?.[String(nicknameAttributeId)];
      if (typeof nickname === "string" && nickname.trim()) {
        nicknames.set(userId, nickname.trim());
      }
    }
    return nicknames;
  } catch {
    return new Map();
  }
}

async function fetchNicknameAttributeId() {
  const url = new URL(`${config.sub2apiBaseUrl}/api/v1/admin/user-attributes`);
  url.searchParams.set("enabled", "true");
  url.searchParams.set("timezone", config.timeZone);

  const response = await fetch(url, {
    headers: buildSub2ApiAuthHeaders(),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await readJsonResponse(response, "Sub2API user attributes");
  if (!response.ok || body.code !== 0) {
    throw new Error(
      `Sub2API user attributes request failed: HTTP ${response.status}, code=${body.code}, message=${body.message || ""}`,
    );
  }

  const attributes = Array.isArray(body.data) ? body.data : [];
  return attributes.find((attribute) => attribute?.key === "nickname")?.id ?? null;
}

async function fetchBatchUserAttributes(userIds) {
  const url = new URL(`${config.sub2apiBaseUrl}/api/v1/admin/user-attributes/batch`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...buildSub2ApiAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_ids: userIds }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const body = await readJsonResponse(response, "Sub2API batch user attributes");
  if (!response.ok || body.code !== 0) {
    throw new Error(
      `Sub2API batch user attributes request failed: HTTP ${response.status}, code=${body.code}, message=${body.message || ""}`,
    );
  }

  return body.data?.attributes && typeof body.data.attributes === "object"
    ? body.data.attributes
    : {};
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

function buildReportText(stats, reportDate, cumulative, dailyTopUsers, previousDayStats) {
  const requests = toNumber(stats.total_requests);
  const inputTokens = toNumber(stats.total_input_tokens);
  const outputTokens = toNumber(stats.total_output_tokens);
  const cacheTokens = toNumber(stats.total_cache_tokens);
  const totalTokens = toNumber(stats.total_tokens);
  const actualCost = toNumber(stats.total_actual_cost);
  const previousActualCost = toNumber(previousDayStats.total_actual_cost);
  const averageDurationMs = toNumber(stats.average_duration_ms);
  const title = buildReportTitle(reportDate);

  return [
    `### 📊 ${title}`,
    "",
    `统计日期：${reportDate}`,
    "",
    `- 💰 使用金额：${formatUsd(actualCost)}（较前日 ${formatChange(actualCost, previousActualCost)}）`,
    `- ⏱️ 平均耗时：${formatDuration(averageDurationMs)}`,
    `- 🔁 请求数：${formatCompactNumber(requests, "次")}`,
    `- 📥 输入 Tokens：${formatCompactNumber(inputTokens, "tokens")}`,
    `- 📤 输出 Tokens：${formatCompactNumber(outputTokens, "tokens")}`,
    `- 🧊 缓存 Tokens：${formatCompactNumber(cacheTokens, "tokens")}`,
    `- 🧮 总 Tokens：${formatCompactNumber(totalTokens, "tokens")}`,
    ``,
    `**🏅 昨日 Token 消耗 Top 5**`,
    ...formatTopUsers(dailyTopUsers),

    ``,
    `------`,
    
    `- 累计已使用：${formatUsd(cumulative.totalActualCost)}`,
    ``,
  ].join("\n");
}

async function buildWeeklyRankingMessage(weekRange) {
  const previousWeekRange = getPreviousRange(weekRange);
  const weeklySummary = await fetchUserBreakdownSummary(weekRange.startDate, weekRange.endDate);
  const previousWeeklySummary = await fetchUserBreakdownSummary(
    previousWeekRange.startDate,
    previousWeekRange.endDate,
  );
  const weeklyTopUsers = await fetchTopUserTokenConsumers(weekRange.startDate, weekRange.endDate, 10);
  const text = buildWeeklyRankingText(
    weekRange,
    weeklyTopUsers,
    weeklySummary,
    previousWeeklySummary,
  );
  return buildDingtalkMessage(text, buildWeeklyRankingTitle(weekRange));
}

function buildWeeklyRankingText(weekRange, weeklyTopUsers, weeklySummary, previousWeeklySummary) {
  const title = buildWeeklyRankingTitle(weekRange);
  const weeklyActualCost = toNumber(weeklySummary.totalActualCost);
  const previousWeeklyActualCost = toNumber(previousWeeklySummary.totalActualCost);
  const champion = weeklyTopUsers[0];
  const championLine = champion
    ? `🏆 ${formatUserLabel(champion)} 获得了上周的 Token 消耗冠军，共消耗 ${formatCompactNumber(champion.totalTokens, "tokens")}，${formatUsd(champion.actualCost)}。`
    : "上周暂无用户消耗数据。";

  return [
    `### 🏆 ${title}`,
    "",
    `统计周期：${weekRange.startDate} 至 ${weekRange.endDate}`,
    `- 💰 上周总金额：${formatUsd(weeklyActualCost)}（环比 ${formatChange(weeklyActualCost, previousWeeklyActualCost)}）`,
    "",
    championLine,
    "",
    `**🏅 上周 Token 消耗 Top 10**`,
    ...formatTopUsers(weeklyTopUsers),
    "",
  ].join("\n");
}

function buildWeeklyRankingTitle(weekRange) {
  return `上周 Token 消耗排行`;
}

function formatTopUsers(topUsers) {
  if (!Array.isArray(topUsers) || topUsers.length === 0) {
    return ["- 暂无用户消耗数据"];
  }

  return topUsers.map((user, index) => {
    const userLabel = formatUserLabel(user);
    return `${index + 1}. ${userLabel}：${formatCompactNumber(user.totalTokens, "tokens")}（${formatUsd(user.actualCost)}）`;
  });
}

function formatUserLabel(user) {
  if (user.nickname) {
    return user.nickname;
  }

  if (user.email) {
    return user.email;
  }

  if (user.userId != null && user.userId !== "") {
    return `用户 #${user.userId}`;
  }

  return "未知用户";
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
  return `${config.title}`;
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

function compactMessages(messages) {
  return messages.filter(Boolean);
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

function formatChange(current, previous) {
  if (previous === 0) {
    return current === 0 ? "持平" : "无前期数据";
  }

  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.0005) {
    return "持平";
  }

  const sign = change > 0 ? "+" : "";
  const emoji = formatChangeEmoji(change);
  const prefix = emoji ? `${emoji} ` : "";
  return `${prefix}${sign}${formatDecimal(change * 100, 1)}%`;
}

function formatChangeEmoji(change) {
  if (change <= 0) {
    return "";
  }

  const abs = Math.abs(change);
  return abs >= 0.5 ? "🚀" : abs >= 0.2 ? "📈" : "⬆️";
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
