# Sub2API 用量钉钉通知

每天 00:01 查询 Sub2API 昨天的用量统计，并发送到钉钉群机器人。

## 配置

```bash
cp .env.example .env
```

然后填写 `.env`：

- `SUB2API_BASE_URL`：你的 Sub2API 地址，例如 `https://sub2api.example.com`
- `SUB2API_AUTH_TYPE`：认证方式。管理员 API Key 填 `admin_api_key`；网页登录 JWT 填 `user_jwt`
- `SUB2API_TOKEN`：对应的 token/key。管理员 API Key 通常形如 `admin-...`
- `DINGTALK_WEBHOOK`：钉钉群自定义机器人 webhook
- `DINGTALK_SECRET`：钉钉机器人加签 secret，未开启加签可留空
- `CUMULATIVE_BASE_ACTUAL_COST`：累计产出的初始基准值，默认 `2551`
- `CUMULATIVE_STATE_FILE`：累计状态文件，默认 `data/cumulative-actual-cost.json`

## 手动测试

```bash
npm run check
npm run report:usage
node scripts/daily-sub2api-usage-to-dingtalk.mjs --dry-run
npm run notify:usage
```

- `npm run report:usage` / `--local-output`：只需要 Sub2API 配置，查询后在本地终端打印报告，不需要钉钉配置，也不会发送钉钉消息。
- `--dry-run`：查询 Sub2API，但不发送钉钉消息，只打印将要发送给钉钉的 JSON payload。周一会包含日报和周榜两条消息。这个模式仍会校验 `DINGTALK_WEBHOOK`。
- `--no-state-write`：只预览累计产出，不写入累计状态文件。
- `--today=YYYY-MM-DD`：测试用，模拟脚本运行当天的日期。比如 `--today=2026-05-25` 会查询
  `2026-05-24` 日报，并触发上周 `2026-05-18` 至 `2026-05-24` 周榜。

## 累计产出

脚本会在报告末尾增加：

```text
- 累计产出金额：$2,551.1 USD
```

累计值计算方式：

```text
CUMULATIVE_BASE_ACTUAL_COST + 每日 total_actual_cost 汇总
```

每日数据按日期保存在 `data/cumulative-actual-cost.json`。同一天重复执行不会重复累加，而是覆盖当天的 `total_actual_cost` 后重新计算总额。

## 用户 Token 排行

管理员模式下，脚本会额外调用：

```text
GET /api/v1/admin/dashboard/user-breakdown?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=3&timezone=Asia/Shanghai
```

脚本会再通过 `/api/v1/admin/user-attributes` 找到 `nickname` 属性，并用
`/api/v1/admin/user-attributes/batch` 批量查询排行用户的昵称。日报里优先展示昵称，
查不到昵称时使用邮箱兜底，同时展示实际扣费。

日报每天发送昨日 `total_tokens` Top 3，并在总金额上展示较前日环比。每周一会额外发送一条独立的周榜消息，按
`REPORT_TIMEZONE` 计算上周自然周周一到周日，默认 `Asia/Shanghai`，统计上周
`total_tokens` Top 10，在上周总金额上展示较前一周环比，并带上上周冠军文案。

## 定时任务

Linux/macOS 使用 crontab：

```cron
1 0 * * * cd /Volumes/workspace/code/private-space/dingtalk-robot && /usr/bin/env node scripts/daily-sub2api-usage-to-dingtalk.mjs >> sub2api-usage.log 2>&1
```

如果服务器时区不是中国时区，建议把系统时区改成 `Asia/Shanghai`，或保留 `.env` 里的 `REPORT_TIMEZONE=Asia/Shanghai`。

## Sub2API 接口

脚本调用：

```text
管理员 API Key:
GET /api/v1/admin/usage/stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&timezone=Asia/Shanghai
x-api-key: <SUB2API_TOKEN>

用户 JWT:
GET /api/v1/usage/stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Authorization: Bearer <SUB2API_TOKEN>
```

每天 00:01 执行时，管理员接口会传 `start_date=昨天&end_date=昨天`；用户接口会传 `start_date=昨天&end_date=今天`。
