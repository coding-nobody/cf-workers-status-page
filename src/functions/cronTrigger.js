import config from '../../config.yaml'

import {
  notifySlack,
  notifyTelegram,
  getCheckLocation,
  getKVMonitors,
  setKVMonitors,
} from './helpers'

export async function processCronTrigger(event) {
  const checkTime = Number.isFinite(event.scheduledTime)
    ? event.scheduledTime
    : Date.now()
  const checkDay = new Date(checkTime).toISOString().split('T')[0]
  // A location lookup failure must not prevent health checks or notifications.
  let checkLocation = 'unknown'
  try {
    checkLocation = await getCheckLocation()
  } catch (error) {
    console.warn('Unable to determine check location')
  }

  // Get monitors state from KV
  let monitorsState = await getKVMonitors()

  // Create empty state objects if not exists in KV storage yet
  if (!monitorsState) {
    monitorsState = { lastUpdate: {}, monitors: {} }
  }

  // Only the last successfully persisted check controls the next snapshot.
  // Do not use isolate memory: scheduled invocations may run in a new isolate.
  const configuredInterval = config.settings.kvWriteIntervalMinutes
  const intervalMinutes =
    Number.isInteger(configuredInterval) && configuredInterval >= 2
      ? configuredInterval
      : 5
  const lastPersistedCheck =
    monitorsState.lastUpdate.scheduledTime || monitorsState.lastUpdate.time
  const snapshotDue =
    !Number.isFinite(lastPersistedCheck) ||
    checkTime < lastPersistedCheck ||
    checkTime - lastPersistedCheck >= intervalMinutes * 60 * 1000
  let statusChanged = false

  // Reset default all monitors state to true
  monitorsState.lastUpdate.allOperational = true

  for (const monitor of config.monitors) {
    // Create default monitor state if does not exist yet
    if (typeof monitorsState.monitors[monitor.id] === 'undefined') {
      monitorsState.monitors[monitor.id] = {
        firstCheck: checkDay,
        lastCheck: {},
        checks: {},
      }
    }

    console.log(`Checking ${monitor.name} ...`)

    // Fetch the monitors URL
    const init = {
      method: monitor.method || 'GET',
      redirect: monitor.followRedirect ? 'follow' : 'manual',
      headers: {
        'User-Agent': config.settings.user_agent || 'cf-worker-status-page',
      },
    }

    // Perform a check and measure time
    const requestStartTime = Date.now()
    let checkResponse
    try {
      checkResponse = await fetch(monitor.url, init)
    } catch (error) {
      // A rejected fetch is a failed check, not a reason to abandon the batch.
      checkResponse = { status: 0, statusText: 'Network error' }
    }
    const requestTime = Math.round(Date.now() - requestStartTime)

    // Determine whether operational and status changed
    const monitorOperational =
      checkResponse.status === (monitor.expectStatus || 200)
    const monitorStatusChanged =
      monitorsState.monitors[monitor.id].lastCheck.operational !==
      monitorOperational
    statusChanged = statusChanged || monitorStatusChanged

    // Save monitor's last check response status
    monitorsState.monitors[monitor.id].lastCheck = {
      status: checkResponse.status,
      statusText: checkResponse.statusText,
      operational: monitorOperational,
    }

    // Send Slack message on monitor change
    if (
      monitorStatusChanged &&
      typeof SECRET_SLACK_WEBHOOK_URL !== 'undefined' &&
      SECRET_SLACK_WEBHOOK_URL !== 'default-gh-action-secret'
    ) {
      event.waitUntil(notifySlack(monitor, monitorOperational))
    }

    // Send Telegram message on monitor change
    if (
      monitorStatusChanged &&
      typeof SECRET_TELEGRAM_API_TOKEN !== 'undefined' &&
      SECRET_TELEGRAM_API_TOKEN !== 'default-gh-action-secret' &&
      typeof SECRET_TELEGRAM_CHAT_ID !== 'undefined' &&
      SECRET_TELEGRAM_CHAT_ID !== 'default-gh-action-secret'
    ) {
      event.waitUntil(notifyTelegram(monitor, monitorOperational))
    }

    // make sure checkDay exists in checks in cases when needed
    if (
      (config.settings.collectResponseTimes || !monitorOperational) &&
      !monitorsState.monitors[monitor.id].checks.hasOwnProperty(checkDay)
    ) {
      monitorsState.monitors[monitor.id].checks[checkDay] = {
        fails: 0,
        res: {},
      }
    }

    if (config.settings.collectResponseTimes && monitorOperational) {
      // make sure location exists in current checkDay
      if (
        !monitorsState.monitors[monitor.id].checks[checkDay].res.hasOwnProperty(
          checkLocation,
        )
      ) {
        monitorsState.monitors[monitor.id].checks[checkDay].res[
          checkLocation
        ] = {
          n: 0,
          ms: 0,
          a: 0,
        }
      }

      // increment number of checks and sum of ms
      const no = ++monitorsState.monitors[monitor.id].checks[checkDay].res[
        checkLocation
      ].n
      const ms = (monitorsState.monitors[monitor.id].checks[checkDay].res[
        checkLocation
      ].ms += requestTime)

      // save new average ms
      monitorsState.monitors[monitor.id].checks[checkDay].res[
        checkLocation
      ].a = Math.round(ms / no)
    } else if (!monitorOperational) {
      // Save allOperational to false
      monitorsState.lastUpdate.allOperational = false

      // Increment failed checks, only on status change (maybe call it .incidents instead?)
      if (monitorStatusChanged) {
        monitorsState.monitors[monitor.id].checks[checkDay].fails++
      }
    }
  }

  // Keep minute-level checks and alerts, but persist stable state less often.
  // A failure AND its recovery each bypass the interval, even between snapshots.
  // Response-time history contains samples from persisted checks only; nothing
  // is buffered in memory or claimed to survive a cold start without a KV write.
  const reason = statusChanged ? 'status-change' : 'interval'
  if (statusChanged || snapshotDue) {
    monitorsState.lastUpdate.time = Date.now()
    monitorsState.lastUpdate.scheduledTime = checkTime
    monitorsState.lastUpdate.loc = checkLocation
    try {
      await setKVMonitors(monitorsState)
      console.log(
        JSON.stringify({ event: 'kv-persistence', outcome: 'written', reason }),
      )
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'kv-persistence', outcome: 'failed', reason }),
      )
      throw error
    }
  } else {
    console.log(JSON.stringify({ event: 'kv-persistence', outcome: 'skipped' }))
  }

  return new Response('OK')
}
