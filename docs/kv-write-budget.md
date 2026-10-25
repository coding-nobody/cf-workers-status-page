# KV write budget and rollout verification

## What changes

The Cron expression remains `* * * * *`: each configured monitor is still
checked every minute. `settings.kvWriteIntervalMinutes` defaults to 5 (integer
at least 2). Stable checks write one shared snapshot only when that interval has
elapsed since the last persisted check. Invalid settings fall back to 5.

Any monitor's operational status change, including its first result, bypasses
the interval. Failure and recovery both persist immediately and use the
existing Slack/Telegram notification paths. Several changes in one invocation
still produce just one KV put. A continued failure is not a new incident.
Fetch rejections are recorded as non-operational with status 0; a failed location
lookup uses `unknown`, so these failures do not abort the remaining monitors.

The same `monitors_data_v1_1` key and existing history format are retained.
`lastUpdate.scheduledTime` is additive; old records fall back to `lastUpdate.time`.
The UI says `updated` because it shows the last persisted check, not the latest
unpersisted check. Normal page data can lag by five minutes plus existing KV
propagation and page caching delays. Scheduling uses `event.scheduledTime`, so
minor execution-time jitter does not turn a five-minute interval into six.

No per-invocation cache, extra counter key, new binding, or storage migration is
introduced. The policy re-reads persisted state on every invocation and works
across cold starts.

## Response-time history

The existing `collectResponseTimes` switch is honored (it remains false in the
repository configuration). If enabled, `checks[day].res[location]` retains the
existing `n`, `ms`, and `a` aggregates. Only the checks included in a successful
snapshot contribute samples. Normal operation therefore retains about 288
samples per monitor per day; successful monitors can also contribute samples
when another monitor changes status. Existing samples are not discarded.

This is sampled history, **not a lossless aggregation of all 1,440 checks**.
Skipped healthy samples are intentionally not buffered in ephemeral Worker
memory. Averages describe the retained samples and are not time-weighted or
guaranteed unbiased; incident-triggered extra snapshots affect sampling density.
Failure incident counts still update immediately on a detected down transition.

## Expected writes and limits

For one enabled Cron, serialized successful invocations and fresh KV reads:

| Workload                                           | Expected KV puts per UTC day            |
| -------------------------------------------------- | --------------------------------------- |
| Original code, healthy                             | 1,440                                   |
| Patched code, healthy, five-minute interval        | 288                                     |
| Patched code with response-time collection enabled | Same 288 baseline                       |
| Extra invocations with one or more status changes  | At most one additional put each         |
| 20 independent down/recovery cycles                | Conservative estimate <=328             |
| A monitor changes status every minute              | 1,440; the free limit is still exceeded |

For planning use `288 + T + O`, where `T` is the number of invocations containing
status transitions outside the normal snapshot schedule, and `O` covers other
account writes, initialization/reconfiguration, retries, duplicate invocations,
and deployments. Transitions reset the snapshot interval, so this is a
conservative planning estimate rather than an exact accounting identity.
The stable baseline leaves 712 writes of headroom against the account's 1,000
free writes/day. A two-minute override has a 720-write baseline instead.

This is **not a hard account-wide quota limiter**. No KV-based counter can safely
enforce an atomic account-wide budget across Workers. Suppressing incident writes
after a local cap would sacrifice the short-outage requirement. If flapping or
other writers consume the headroom, an independently reviewed durable event
store/serialized coordinator or a paid allowance is needed. This PR does not
silently add either or change billing.

KV is eventually consistent and not transactional. Stale reads, concurrent
writers, overlapping schedules, or a failed put can still duplicate alerts,
overwrite history, or miss a recovery relative to a stale snapshot. These are
existing architecture limits, not solved by throttling. Immediate transition
writes avoid deliberately dropping short incidents between periodic snapshots;
they are not an exactly-once or lossless-history guarantee. A failure shorter
than the one-minute polling cadence may also remain unobserved. The existing
fetch path has no explicit timeout, so an unusually slow request can delay the
batch; that behavior is unchanged by this patch.

Notifications are queued before the put, so a put error does not gate the alert
attempt. Notification delivery is still best-effort, with the original webhook
behavior. Failed writes log `event=kv-persistence`, `outcome=failed` and rethrow;
the next check retries against persisted state. A transient incident entirely
inside a KV outage cannot be durably recovered by this patch. Successful and
skipped writes log `written` and `skipped`; successful/failed writes also log
`reason=status-change` or `interval`.

## Local validation (no Cloudflare credentials or production access)

With Node.js 18 or newer:

```sh
npm test
git diff --check
```

The tests execute the real Cron and KV/notification helpers with mocked network,
KV and clock APIs and a fresh module graph on every invocation. They simulate
24 hours with and without response sampling; short outages and recoveries;
sustained outages; independent/simultaneous monitor transitions; network/location
failures; put failures and retry; old records; invalid configuration; UTC
midnight; manual invocation; and flapping that exceeds the budget. They do not
model Cloudflare's distributed consistency or prove actual webhook delivery.

The legacy frontend build can be checked separately with the existing lockfile:

```sh
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts
NODE_ENV=production NODE_OPTIONS=--openssl-legacy-provider npx --yes yarn@1.22.22 build
```

The OpenSSL option is for running the repository's Webpack 4 toolchain on modern
Node, not a Worker runtime setting. For separate frontend and Worker JavaScript
compilation (the Worker build needs the frontend manifest first):

```sh
NODE_ENV=production NODE_OPTIONS=--openssl-legacy-provider node_modules/.bin/webpack --config node_modules/flareact/configs/webpack.client.config.js --out ./out --mode production
NODE_ENV=production NODE_OPTIONS=--openssl-legacy-provider node_modules/.bin/webpack --config node_modules/flareact/webpack.js --mode production --output-path "$PWD/dist"
```

Validation on 2026-10-25 with Node 24.22.1: all 14 regression tests passed;
Prettier and `git diff --check` passed; both JavaScript compilations above passed.
The complete `yarn build` failed at its CSS step with PostCSS's
`Package subpath './lib/node' is not defined by "exports"` error. The identical
failure was reproduced on unmodified main (`1439b67`) with the same locked
dependencies. This pre-existing toolchain incompatibility was not changed in
the KV fix; a full production build is therefore **not** claimed to pass.

Do not run `deploy`, `publish`, or a repository
dispatch as part of validation. The existing GitHub workflow deploys on pushes
to `main` and on `repository_dispatch`; a separate branch/PR does not match those
triggers, but merging into `main` would trigger deployment if Actions/secrets are
enabled. Check any separately configured Cloudflare Builds triggers as well.

## Verify the real production writer before rollout

1. In the correct Cloudflare account, open **Workers & Pages**, select the Worker
   serving the actual status-page route/custom domain, then **Deployments**.
   Record the active deployment and version ID(s), creation time, source, and
   traffic allocation. An uploaded version is not necessarily active. Match a
   build's Git commit when present; for a dashboard/manual deployment inspect the
   active bundle read-only. Look for the monitor key and the unconditional put
   versus `kvWriteIntervalMinutes` / `kv-persistence` markers. Do not infer a
   deployed version from GitHub `main` or a repository timestamp.
2. Inspect **Bindings** (or **Settings > Bindings**) and record the exact namespace
   ID mapped to `KV_STATUS_PAGE`. Check the correct production/environment suffix,
   other active versions' bindings, and the configured **Cron Triggers** under
   Settings. Confirm there is one once-per-minute schedule, and check for duplicate
   Workers/old deployments with their own schedules. Do not edit or resave anything.
3. Open **Workers KV**, select that namespace, then **Metrics**. Compare write
   operations over a complete UTC day, not just a rolling 24-hour graph. Repeat
   for every namespace with writes in the account and reconcile with account
   usage. KV limits reset at **00:00 UTC / 08:00 Asia/Shanghai**. Dashboard/API/CLI
   writes and deployments that upload static assets can also consume writes.
4. Namespace metrics alone are not proof of a specific Worker or code path.
   Map all Workers' bindings to namespace IDs and inspect their scheduled/request
   logs. Check CI, REST clients, maintenance jobs and manual edits too. After an
   approved deployment, filter Worker logs on `kv-persistence` and compare
   `written`, `skipped`, and `failed` with namespace write metrics. The new log
   concerns only this Cron's snapshot writes, not all account operations. Account
   for log sampling/retention and metrics delay before comparing counts.
5. Validate later in an isolated staging Worker with its own namespace and test
   notification destinations: keep checks at one minute, inject a down result on
   minute 1 and recover on minute 2 between regular snapshots, and verify both
   transitions, notifications and retained incident count. Observe real stale-read
   behavior. Do not use a version URL bound to production storage for this test.
   No staging or production deployment is part of this PR.
6. Once rollout is separately approved, observe a complete UTC day: about 288
   stable Cron snapshot writes, roughly 1,440 checks per monitor, immediate
   transition writes, no 429s, and sufficient remaining account-wide headroom.
   If values disagree, identify the additional writer before claiming resolution.
   Rolling back to the original bundle restores the 1,440/day risk.

Official references:

- [KV pricing and daily reset](https://developers.cloudflare.com/kv/platform/pricing/)
- [KV metrics by namespace](https://developers.cloudflare.com/kv/observability/metrics-analytics/)
- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Concurrent KV writes](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
