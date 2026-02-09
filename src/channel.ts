import { execFileSync } from 'child_process'
import http from 'http'
import path from 'path'
import { device } from 'detox'
import events, {
  CHANNEL_CREATED,
  SET_CURRENT_STORY,
  STORY_RENDERED,
  STORY_THREW_EXCEPTION,
  STORY_UNCHANGED,
} from 'storybook/internal/core-events'
import { WebSocket, WebSocketServer } from 'ws'

const WS_OPEN = 1
const PORT = Number(process.env.STORYBOOK_WS_PORT || 7007)
const DEBUG = process.env.STORYBOOK_CHANNEL_DEBUG === '1'

// Whether to attempt an automatic app relaunch when WS client does not connect in time.
// "0" = disabled, anything else / unset = enabled (default).
const SHOULD_RELAUNCH_ON_WS_TIMEOUT = process.env.STORYBOOK_RELAUNCH_ON_WS_TIMEOUT !== '0'

// Optional: package name for pidof/logcat context in debug dumps.
const ANDROID_PACKAGE_NAME = process.env.STORYBOOK_ANDROID_PACKAGE

const log = (...args: unknown[]) => {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[storybook-detox-channel]', ...args)
  }
}

// --- Debug helpers (Android only) --------------------------------------------

const debugLog = (...args: any[]) => {
  if (!DEBUG) return
  // eslint-disable-next-line no-console
  console.log('[storybook-detox][debug]', ...args)
}

const getAdbPath = () => {
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
  return sdkRoot ? path.join(sdkRoot, 'platform-tools', 'adb') : 'adb'
}

const getSerial = (): string | null => {
  const id = (device as any)?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

const safeExecAdb = (serial: string, args: string[]) => {
  try {
    return execFileSync(getAdbPath(), ['-s', serial, ...args], { encoding: 'utf8' }).trim()
  } catch (e: any) {
    return `FAILED: ${String(e?.stderr || e?.message || e)}`
  }
}

const safeExec = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch (e: any) {
    return `FAILED: ${String(e?.stderr || e?.message || e)}`
  }
}

// Prevent flooding logs when multiple stories fail in a row
let lastDumpTs = 0
const DUMP_THROTTLE_MS = 5000

async function checkMetroStatus(timeoutMs = 1200): Promise<string> {
  return await new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: 8081,
        path: '/status',
        timeout: timeoutMs,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += String(c)))
        res.on('end', () => resolve(`HTTP ${res.statusCode} ${data.slice(0, 200)}`))
      },
    )

    req.on('timeout', () => {
      req.destroy()
      resolve('TIMEOUT')
    })

    req.on('error', (e) => resolve(`ERROR: ${String((e as any)?.message ?? e)}`))
  })
}

function pickLogcatHighlights(logcat: string): string {
  // Keep it very pragmatic: these strings cover 95% of "why didn't it connect?"
  // You can extend via env without changing code.
  const extra = String(process.env.STORYBOOK_LOGCAT_HIGHLIGHTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const needles = [
    'AndroidRuntime',
    'FATAL EXCEPTION',
    'ANR in',
    'OutOfMemoryError',
    'Unable to load script',
    'Could not connect to development server',
    'ReactNativeJS',
    'Hermes',
    'SoLoader',
    'ConnectException',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    '7007',
    '8081',
    '::1',
    ...extra,
  ]

  const lines = (logcat || '').split('\n')
  const matched = lines.filter((l) => needles.some((n) => l.includes(n)))

  // Limit size to avoid blowing up logs
  return matched.slice(-120).join('\n')
}

/**
 * Dumps Android diagnostics to stdout. Best-effort: must never throw.
 * Call it on timeouts / disconnects only.
 */
export async function debugAndroidTimeoutDump(tag: string) {
  if (!DEBUG) return
  if (device.getPlatform?.() !== 'android') return

  const now = Date.now()
  if (now - lastDumpTs < DUMP_THROTTLE_MS) return
  lastDumpTs = now

  const serial = getSerial()
  if (!serial) {
    debugLog(tag, 'no device serial (device.id)')
    return
  }

  const state = safeExecAdb(serial, ['get-state'])
  const reverseList = safeExecAdb(serial, ['reverse', '--list'])
  const pid = ANDROID_PACKAGE_NAME
    ? safeExecAdb(serial, ['shell', 'pidof', ANDROID_PACKAGE_NAME])
    : 'SKIPPED(no STORYBOOK_ANDROID_PACKAGE)'

  // Tail last N lines; still may include noise, but enough to spot crashes/metro issues.
  const logcatTail = safeExecAdb(serial, ['logcat', '-d', '-t', '250'])
  const logcatHighlights = pickLogcatHighlights(logcatTail)

  const metro = await checkMetroStatus(1200)

  debugLog(
    [
      `\n=== ${tag} ===`,
      `serial=${serial} adbState=${state}`,
      `pidof(${ANDROID_PACKAGE_NAME ?? 'N/A'})=${pid}`,
      `metroStatus=${metro}`,
      `adb reverse --list:\n${reverseList || '(empty)'}`,
      `logcat highlights:\n${logcatHighlights || '(none)'}`,
      `logcat tail:\n${logcatTail || '(empty)'}`,
      `=== end ${tag} ===\n`,
    ].join('\n'),
  )
}

/**
 * Lightweight helper if you want reverse list only (kept for compatibility with your current calls).
 */
export function debugReverseState(tag: string) {
  if (!DEBUG) return
  if (device.getPlatform?.() !== 'android') return

  const serial = getSerial()
  if (!serial) {
    debugLog(tag, 'debugReverseState: no device serial (device.id)')
    return
  }

  const out = safeExecAdb(serial, ['reverse', '--list'])
  debugLog(tag, 'adb reverse --list:\n' + out)
}

// --- Channel implementation ---------------------------------------------------

interface Channel {
  server?: WebSocketServer
  client?: {
    identifier?: string
    socket: WebSocket
    connectedAt?: number
  } | null
  pendingStory: PendingStoryRender | null
  routePromise: Promise<void> | null
  serverPromise: Promise<void> | null
}

type PendingStoryRender = {
  storyId: string
  resolve: () => void
  reject: (err: Error) => void
}

type Message = {
  type: events
  from?: string
  args?: any[]
}

// Cannot use module scope variable, require during test execution returns different instance.
// Probably because of transformer.
function getChannel(): Channel {
  ;(globalThis as any).channel = (globalThis as any).channel ?? {
    pendingStory: null,
    routePromise: null,
    serverPromise: null,
  }

  return (globalThis as any).channel
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function withTimeout<T>(label: string, promise: Promise<T>, timeoutInMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(label)), timeoutInMs)

    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
}

function safeJsonParse(buffer: Buffer): Message | null {
  try {
    return JSON.parse(buffer.toString('utf-8')) as Message
  } catch {
    return null
  }
}

// Supports both string storyId and object { storyId: string } payload formats
// to maintain backward compatibility with different Storybook versions.
function extractStoryIdFromMessage(message: Message): string | null {
  const firstArg = message?.args?.[0]

  if (typeof firstArg === 'string') {
    return firstArg
  }

  if (firstArg && typeof firstArg === 'object' && typeof firstArg.storyId === 'string') {
    return firstArg.storyId
  }

  return null
}

function rejectPendingStory(error: Error) {
  const channel = getChannel()
  const pending = channel.pendingStory

  if (!pending) {
    return
  }

  channel.pendingStory = null

  try {
    pending.reject(error)
  } catch {
    // ignore
  }
}

function createPendingRenderPromise(storyId: string): Promise<void> {
  const channel = getChannel()

  // New call supersedes any previous pending request
  if (channel.pendingStory) {
    try {
      channel.pendingStory.reject(new Error(`Superseded pending changeStory("${channel.pendingStory.storyId}")`))
    } catch {
      // ignore
    }
    channel.pendingStory = null
  }

  return new Promise<void>((resolve, reject) => {
    channel.pendingStory = { storyId, resolve, reject }
  })
}

function attachClientSocket(socket: WebSocket) {
  const channel = getChannel()
  const previousSocket = channel.client?.socket

  // When app restarts during tests, a new socket connects.
  // Close the old one to prevent stale sockets and listener accumulation.
  if (previousSocket && previousSocket !== socket) {
    try {
      previousSocket.close()
    } catch {
      // ignore
    }
  }

  const remoteAddress = (socket as any)?._socket?.remoteAddress
  const remotePort = (socket as any)?._socket?.remotePort
  debugLog('ws client connected', { remoteAddress, remotePort })

  channel.client = {
    socket,
    identifier: channel.client?.identifier,
    connectedAt: Date.now(),
  }

  socket.on('message', (buffer: Buffer) => {
    const message = safeJsonParse(buffer)
    if (!message) return

    if (message.type === CHANNEL_CREATED) {
      const from = message.from
      if (typeof from === 'string') {
        const currentClient = getChannel().client
        if (currentClient?.socket === socket) {
          currentClient.identifier = from
        }
      }
      log('CHANNEL_CREATED from:', from)
      return
    }

    if (message.type === STORY_THREW_EXCEPTION) {
      const storyError = message.args?.[0]
      const error = new Error('Story threw exception during render: ' + JSON.stringify(storyError))
      rejectPendingStory(error)
      return
    }

    if (message.type === STORY_RENDERED || message.type === STORY_UNCHANGED) {
      const renderedId = extractStoryIdFromMessage(message)
      if (!renderedId) return

      const channel = getChannel()
      const pending = channel.pendingStory

      if (pending && pending.storyId === renderedId) {
        channel.pendingStory = null
        try {
          pending.resolve()
        } catch {
          // ignore
        }
      }
    }
  })

  socket.on('close', async () => {
    log('client socket closed')

    const channel = getChannel()
    if (channel.client?.socket === socket) {
      channel.client = null
    }

    await debugAndroidTimeoutDump('storybook ws client socket closed')
    rejectPendingStory(new Error('Storybook device socket closed'))
  })

  socket.on('error', async (error: any) => {
    log('client socket error:', error?.message ?? error)

    const channel = getChannel()
    if (channel.client?.socket === socket) {
      channel.client = null
    }

    await debugAndroidTimeoutDump('storybook ws client socket error')
    rejectPendingStory(new Error('Storybook device socket error: ' + (error?.message ?? String(error))))
  })
}

// Idempotent server start: multiple spec files call prepareChannel() in beforeAll,
// but we need exactly one WebSocket server per Jest process to avoid port conflicts.
async function ensureServerStarted() {
  const channel = getChannel()

  if (channel.serverPromise) {
    return channel.serverPromise
  }

  channel.serverPromise = (async () => {
    if (channel.server) return

    const server = new WebSocketServer({ port: PORT })
    channel.server = server

    server.on('connection', (socket: WebSocket) => {
      log('client connected')
      attachClientSocket(socket)
    })

    server.on('error', async (error: any) => {
      log('server error:', error?.message ?? error)
      await debugAndroidTimeoutDump('storybook ws server error')
    })

    log('server started on port', PORT)
  })()

  return channel.serverPromise
}

export async function prepareChannel() {
  await ensureServerStarted()
}

// Idempotent reverse port: repeated reverseTcpPort calls can degrade/stall adb.
// One reverse per Jest process is enough.
export async function routeFromDeviceToServer() {
  const channel = getChannel()

  if (channel.routePromise) {
    return channel.routePromise
  }

  channel.routePromise = (async () => {
    try {
      await device.reverseTcpPort(PORT)
      log('reverseTcpPort ok:', PORT)
    } catch (error: any) {
      // Allow retry on next call if reverse failed (e.g., adb restart needed).
      channel.routePromise = null
      log('reverseTcpPort failed:', error?.message ?? error)
      throw error
    }
  })()

  return channel.routePromise
}

export async function closeChannel() {
  const channel = getChannel()

  try {
    rejectPendingStory(new Error('Channel closed'))
  } catch {
    // ignore
  }

  channel.routePromise = null

  // Best-effort: undo TCP reverse on Android if supported by Detox.
  try {
    if (
      typeof device.getPlatform === 'function' &&
      device.getPlatform() === 'android' &&
      typeof (device as any).unreverseTcpPort === 'function'
    ) {
      await (device as any).unreverseTcpPort(PORT)
      log('unreverseTcpPort ok:', PORT)
    }
  } catch (error: any) {
    log('unreverseTcpPort failed:', error?.message ?? error)
  }

  try {
    channel.client?.socket?.close?.()
  } catch {
    // ignore
  }

  channel.client = null

  if (!channel.server) return

  await new Promise<void>((resolve) => channel.server?.close(() => resolve()))
  channel.server = undefined
  channel.serverPromise = null
}

async function waitForOpenClientSocket(timeoutMs: number): Promise<WebSocket> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const socket = getChannel().client?.socket
    if (socket && (socket as any).readyState === WS_OPEN) {
      return socket
    }
    await sleep(100)
  }

  throw new Error('Storybook running on device should have connected by now')
}

export async function changeStory(storyId: string) {
  await ensureServerStarted()
  await routeFromDeviceToServer()

  const connectTimeoutMs = Number(process.env.STORYBOOK_WS_CONNECT_TIMEOUT_MS || 30_000)
  const changeTimeoutMs = Number(process.env.STORYBOOK_CHANGE_STORY_TIMEOUT_MS || 15_000)

  const fallbackConnectEnv = process.env.STORYBOOK_WS_FALLBACK_CONNECT_TIMEOUT_MS
  const fallbackConnectTimeoutMs = (() => {
    const parsed = fallbackConnectEnv != null ? Number(fallbackConnectEnv) : NaN
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
    return Math.min(connectTimeoutMs, 15_000)
  })()

  let socket: WebSocket

  try {
    socket = await waitForOpenClientSocket(connectTimeoutMs)
  } catch (firstError: any) {
    await debugAndroidTimeoutDump(`changeStory timeout storyId=${storyId}`)

    if (!SHOULD_RELAUNCH_ON_WS_TIMEOUT) {
      throw firstError
    }

    log('No open Storybook WS client within timeout, trying to relaunch app:', firstError?.message ?? firstError)

    await device.launchApp({ newInstance: true })

    // After relaunch, wait again for the client but with a shorter timeout.
    socket = await waitForOpenClientSocket(fallbackConnectTimeoutMs)
  }

  const waitForRender = createPendingRenderPromise(storyId)

  try {
    socket.send(JSON.stringify({ type: SET_CURRENT_STORY, args: [{ storyId }] }))
  } catch (error: any) {
    const channel = getChannel()

    if (channel.pendingStory?.storyId === storyId) {
      try {
        channel.pendingStory.reject(
          new Error('Failed to send SET_CURRENT_STORY: ' + (error?.message ?? String(error))),
        )
      } catch {
        // ignore
      }
      channel.pendingStory = null
    }

    throw error
  }

  try {
    await withTimeout(`App timed out changing stories: ${storyId}`, waitForRender, changeTimeoutMs)
  } finally {
    const channel = getChannel()
    if (channel.pendingStory?.storyId === storyId) {
      channel.pendingStory = null
    }
  }
}
