const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

// Execute the real cron AND KV/notification helpers without installing the
// legacy frontend toolchain. Only YAML, React and platform IO are substituted.
const root = path.join(__dirname, '..')
const cronSource = readFileSync(
  path.join(root, 'src/functions/cronTrigger.js'),
  'utf8',
)
const helperSource = readFileSync(
  path.join(root, 'src/functions/helpers.js'),
  'utf8',
)
const clone = (value) => JSON.parse(JSON.stringify(value))
const start = Date.parse('2026-10-25T00:00:00Z')

function harness(settings = {}, initialState = null) {
  const config = {
    settings: {
      kvWriteIntervalMinutes: 5,
      collectResponseTimes: false,
      url: 'https://status.example',
      monitorLabelOperational: 'up',
      monitorLabelNotOperational: 'down',
      ...settings,
    },
    monitors: ['a', 'b'].map((id) => ({
      id,
      name: id,
      url: `https://${id}.example`,
    })),
  }
  let persisted = clone(initialState)
  let failPut = false
  let clock = start
  const puts = []
  const attempts = []
  const checks = []
  const notifications = []
  const logs = []
  let reads = 0

  async function tick(minute, outcomes = [200, 200], options = {}) {
    const scheduledTime = start + minute * 60000
    clock = scheduledTime + (options.delay || 0)
    const pending = []
    const context = vm.createContext({
      Date: class extends Date {
        constructor(...args) {
          super(...(args.length ? args : [clock]))
        }
        static now() {
          return clock
        }
      },
      Response,
      FormData,
      console: {
        log: (value) => logs.push(value),
        warn: (value) => logs.push(value),
        error: (value) => logs.push(value),
      },
      SECRET_SLACK_WEBHOOK_URL: 'https://slack.example',
      SECRET_TELEGRAM_API_TOKEN: 'test',
      SECRET_TELEGRAM_CHAT_ID: 'test',
      KV_STATUS_PAGE: {
        async get(key, type) {
          assert.equal(key, 'monitors_data_v1_1')
          assert.equal(type, 'json')
          reads++
          return clone(persisted)
        },
        async put(key, value) {
          assert.equal(key, 'monitors_data_v1_1')
          attempts.push(minute)
          if (failPut) throw new Error('429: KV write limit exceeded')
          persisted = JSON.parse(value)
          puts.push({ minute, state: clone(persisted) })
        },
      },
      async fetch(url, init) {
        if (url === 'https://cloudflare-dns.com/dns-query') {
          if (options.locationError) throw new Error('DNS unavailable')
          return { headers: { get: () => `ray-${options.location || 'TEST'}` } }
        }
        if (url === 'https://slack.example') {
          notifications.push({
            minute,
            channel: 'slack',
            body: JSON.parse(init.body),
          })
          return new Response('ok')
        }
        if (url.startsWith('https://api.telegram.org/')) {
          notifications.push({
            minute,
            channel: 'telegram',
            text: init.body.get('text'),
          })
          return new Response('ok')
        }
        const index = config.monitors.findIndex(
          (monitor) => monitor.url === url,
        )
        assert.notEqual(index, -1, `Unexpected fetch: ${url}`)
        checks.push({ minute, id: config.monitors[index].id })
        clock += (options.latencies || [100, 200])[index]
        if (outcomes[index] === 'reject') throw new Error('Connection refused')
        return { status: outcomes[index], statusText: String(outcomes[index]) }
      },
    })
    // A fresh module graph for EVERY invocation proves no isolate-local state
    // or in-memory batching is required for the persistence policy.
    const yaml = new vm.SyntheticModule(
      ['default'],
      function () {
        this.setExport('default', config)
      },
      { context },
    )
    const react = new vm.SyntheticModule(
      ['useEffect', 'useState'],
      function () {
        this.setExport('useEffect', () => {})
        this.setExport('useState', () => {})
      },
      { context },
    )
    const helpers = new vm.SourceTextModule(helperSource, { context })
    const cron = new vm.SourceTextModule(cronSource, { context })
    await cron.link((specifier) => {
      if (specifier === '../../config.yaml') return yaml
      if (specifier === './helpers') return helpers
      if (specifier === 'react') return react
      throw new Error(`Unexpected import: ${specifier}`)
    })
    await cron.evaluate()
    const event = { waitUntil: (promise) => pending.push(promise) }
    if (!options.manual) event.scheduledTime = scheduledTime
    try {
      await cron.namespace.processCronTrigger(event)
    } finally {
      await Promise.all(pending)
    }
  }
  return {
    config,
    tick,
    puts,
    attempts,
    checks,
    notifications,
    logs,
    state: () => clone(persisted),
    reads: () => reads,
    failWrites: (value) => {
      failPut = value
    },
  }
}

test('24 healthy hours: 1440 checks per monitor and 288 KV puts across cold starts', async () => {
  const h = harness()
  for (let minute = 0; minute < 1440; minute++) {
    await h.tick(minute, [200, 200], { delay: (minute % 7) * 100 })
  }
  assert.equal(h.reads(), 1440)
  assert.equal(h.checks.length, 2880)
  assert.equal(h.puts.length, 288)
  assert.equal(h.notifications.length, 4) // existing initial-status notifications
  assert.deepEqual(
    h.puts.slice(0, 3).map((put) => put.minute),
    [0, 5, 10],
  )
  assert.equal(h.state().lastUpdate.scheduledTime, start + 1435 * 60000)
  assert.deepEqual(h.state().monitors.a.checks, {})
})

test('response history is sampled at persistence, preserving per-location n/ms/average', async () => {
  const h = harness({ collectResponseTimes: true })
  for (let minute = 0; minute < 1440; minute++) {
    await h.tick(minute, [200, 200], { location: minute % 2 ? 'LHR' : 'SJC' })
  }
  assert.equal(h.puts.length, 288)
  const day = h.state().monitors.a.checks['2026-10-25']
  assert.deepEqual(day, {
    fails: 0,
    res: {
      SJC: { n: 144, ms: 14400, a: 100 },
      LHR: { n: 144, ms: 14400, a: 100 },
    },
  })
  assert.equal(h.state().monitors.b.checks['2026-10-25'].res.LHR.a, 200)
})

test('one-minute outage between snapshots immediately persists failure AND recovery', async () => {
  const h = harness({ collectResponseTimes: true })
  await h.tick(0)
  await h.tick(1, [503, 200])
  assert.equal(h.state().lastUpdate.allOperational, false)
  await h.tick(2)
  assert.equal(h.state().lastUpdate.allOperational, true)
  for (let minute = 3; minute <= 7; minute++) await h.tick(minute)
  assert.deepEqual(
    h.puts.map((put) => put.minute),
    [0, 1, 2, 7],
  )
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 1)
  assert.equal(h.state().monitors.a.checks['2026-10-25'].res.TEST.n, 3)
  assert.deepEqual(
    h.notifications
      .filter((n) => n.minute > 0)
      .map((n) => [n.minute, n.channel]),
    [
      [1, 'slack'],
      [1, 'telegram'],
      [2, 'slack'],
      [2, 'telegram'],
    ],
  )
})

test('sustained failure: no per-minute writes or duplicate incidents/notifications', async () => {
  const h = harness()
  await h.tick(0)
  for (let minute = 1; minute <= 20; minute++) await h.tick(minute, [503, 200])
  assert.deepEqual(
    h.puts.map((put) => put.minute),
    [0, 1, 6, 11, 16],
  )
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 1)
  assert.equal(h.notifications.length, 6)
})

test('monitor-level changes persist even when aggregate allOperational is unchanged', async () => {
  const h = harness()
  await h.tick(0, [503, 200])
  await h.tick(1, [200, 503])
  assert.equal(h.puts.length, 2)
  assert.equal(h.state().lastUpdate.allOperational, false)
  assert.equal(h.state().monitors.a.lastCheck.operational, true)
  assert.equal(h.state().monitors.b.lastCheck.operational, false)
  assert.equal(h.notifications.filter((n) => n.minute === 1).length, 4)
})

test('simultaneous monitor changes cause one shared-state put, not one per monitor', async () => {
  const h = harness()
  await h.tick(0)
  await h.tick(1, [503, 503])
  await h.tick(2)
  assert.equal(h.puts.length, 3)
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 1)
  assert.equal(h.state().monitors.b.checks['2026-10-25'].fails, 1)
})

test('network and location failures do not abort remaining monitors or notifications', async () => {
  const h = harness()
  await h.tick(0)
  await h.tick(1, ['reject', 200], { locationError: true })
  assert.equal(h.state().monitors.a.lastCheck.status, 0)
  assert.equal(h.state().monitors.a.lastCheck.operational, false)
  assert.equal(h.state().monitors.b.lastCheck.operational, true)
  assert.equal(h.state().lastUpdate.loc, 'unknown')
  await h.tick(2, ['reject', 200])
  assert.equal(h.puts.length, 2)
  await h.tick(3)
  assert.equal(h.puts.length, 3)
  assert.equal(h.checks.length, 8)
  assert.equal(h.notifications.length, 8)
})

test('failed put is observable, does not advance persisted clock, and retries next check', async () => {
  const h = harness()
  await h.tick(0)
  h.failWrites(true)
  await assert.rejects(h.tick(1, [503, 200]), /429/)
  assert.equal(h.state().lastUpdate.scheduledTime, start)
  assert.equal(h.notifications.filter((n) => n.minute === 1).length, 2)
  assert.ok(h.logs.some((log) => log.includes('"outcome":"failed"')))
  h.failWrites(false)
  await h.tick(2, [503, 200])
  assert.deepEqual(h.attempts, [0, 1, 2])
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 1)
})

test('existing schema/history is retained; missing setting defaults to five minutes', async () => {
  const seed = harness({ collectResponseTimes: true })
  await seed.tick(0)
  const legacy = seed.state()
  delete legacy.lastUpdate.scheduledTime
  legacy.lastUpdate.time = start
  legacy.monitors.a.checks['2026-10-24'] = { fails: 2, res: {} }
  const h = harness(
    { kvWriteIntervalMinutes: undefined, collectResponseTimes: true },
    legacy,
  )
  await h.tick(1)
  assert.equal(h.puts.length, 0)
  await h.tick(5)
  assert.equal(h.puts.length, 1)
  assert.equal(h.notifications.length, 0)
  assert.equal(h.state().monitors.a.checks['2026-10-24'].fails, 2)
  assert.equal(h.state().monitors.a.checks['2026-10-25'].res.TEST.n, 2)
})

test('invalid intervals safely fall back; two-minute override is honored', async () => {
  for (const interval of [0, 1, -1, 2.5, '5', null]) {
    const h = harness({ kvWriteIntervalMinutes: interval })
    for (let minute = 0; minute <= 5; minute++) await h.tick(minute)
    assert.deepEqual(
      h.puts.map((put) => put.minute),
      [0, 5],
    )
  }
  const h = harness({ kvWriteIntervalMinutes: 2 })
  for (let minute = 0; minute <= 5; minute++) await h.tick(minute)
  assert.deepEqual(
    h.puts.map((put) => put.minute),
    [0, 2, 4],
  )
})

test('UTC rollover preserves a short incident on its original day', async () => {
  const h = harness()
  await h.tick(1438)
  await h.tick(1439, [503, 200])
  await h.tick(1440)
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 1)
  assert.equal(h.state().monitors.a.lastCheck.operational, true)
  assert.equal(h.state().lastUpdate.scheduledTime, start + 1440 * 60000)
})

test('manual calls work without scheduledTime; future persisted clocks cannot stall writes', async () => {
  const h = harness()
  await h.tick(10)
  await h.tick(0, [200, 200], { manual: true })
  assert.equal(h.puts.length, 2)
  assert.equal(h.state().lastUpdate.scheduledTime, start)
})

test('flapping is NOT hidden by a quota cap: transitions can still exceed 1000 puts/day', async () => {
  const h = harness()
  for (let minute = 0; minute < 1440; minute++)
    await h.tick(minute, [minute % 2 ? 503 : 200, 200])
  assert.equal(h.puts.length, 1440)
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 720)
})

test('20 short outage/recovery cycles fit the 328-write conservative daily estimate', async () => {
  const h = harness()
  for (let minute = 0; minute < 1440; minute++) {
    const down = minute < 1200 && minute % 60 === 16
    await h.tick(minute, [down ? 503 : 200, 200])
  }
  assert.ok(h.puts.length <= 328, `Expected <=328 puts, got ${h.puts.length}`)
  assert.equal(h.checks.length, 2880)
  assert.equal(h.state().monitors.a.checks['2026-10-25'].fails, 20)
  assert.equal(h.notifications.length, 84) // initial states + 40 transitions, two channels
})
