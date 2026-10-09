#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tools as commonTools, toolMethods as commonToolMethods } from './tools.mjs'

const SERVER_NAME = 'quickdesign-mastergo'
const SERVER_VERSION = '0.1.5'
const PROTOCOL_VERSION = 'quickdesign.bridge.v1'
const PRIMARY_BIND_HOST = '127.0.0.1'
const BRIDGE_BIND_HOSTS = ['127.0.0.1', '::1']
const BRIDGE_PORT = Number.parseInt(process.env.QUICKDESIGN_BRIDGE_PORT || '50679', 10)
// When the base port is already taken by another session's MCP process, fall back to the
// next free port within this range so multiple agents can coexist instead of failing hard.
const BRIDGE_PORT_RANGE = Math.max(1, Number.parseInt(process.env.QUICKDESIGN_BRIDGE_PORT_RANGE || '8', 10))
const MAX_WS_PAYLOAD = 2 * 1024 * 1024

// Ports are resolved at runtime; boundPort is the port this process actually listens on.
let boundPort = null
let portAttemptIndex = 0
const REQUEST_TIMEOUT_MS = 170_000
// Status must stay a fast first call: probe context with a short budget and degrade instead of hanging.
const STATUS_CONTEXT_TIMEOUT_MS = Number.parseInt(process.env.QUICKDESIGN_STATUS_CONTEXT_TIMEOUT_MS || '3000', 10)

const log = (...parts) => process.stderr.write(`[quickdesign-mastergo] ${parts.join(' ')}\n`)

class BridgeError extends Error {
  constructor(code, message, data = undefined) {
    super(message)
    this.code = code
    this.data = data
  }
}

class QuickDesignConnection {
  socket = null
  info = null
  buffer = Buffer.alloc(0)
  pending = new Map()
  bridgeError = null

  status() {
    return {
      connected: Boolean(this.socket && this.info),
      bridge: {
        host: 'localhost',
        port: boundPort ?? BRIDGE_PORT,
        protocol: PROTOCOL_VERSION,
        version: SERVER_VERSION,
        error: this.bridgeError,
      },
      plugin: this.info,
      actionRequired: this.socket && this.info
        ? null
        : 'Open the target MasterGo document and run the QuickDesign plugin. It will connect automatically.',
    }
  }

  attach(socket) {
    if (this.socket && this.socket !== socket) {
      try { this.socket.end() } catch { /* ignore stale connection */ }
    }
    this.socket = socket
    this.info = null
    this.buffer = Buffer.alloc(0)
    socket.on('data', chunk => this.onData(chunk))
    socket.on('close', () => this.detach(socket, 'connection closed'))
    socket.on('error', error => this.detach(socket, error.message))
  }

  detach(socket, reason) {
    if (this.socket !== socket) return
    this.socket = null
    this.info = null
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new BridgeError('NOT_CONNECTED', `QuickDesign disconnected: ${reason}`))
    }
    this.pending.clear()
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const decoded = decodeWebSocketFrame(this.buffer)
      if (!decoded) return
      this.buffer = this.buffer.subarray(decoded.consumed)
      if (decoded.opcode === 0x8) {
        this.socket?.end()
        return
      }
      if (decoded.opcode === 0x9) {
        this.socket?.write(encodeWebSocketFrame(decoded.payload, 0xA))
        continue
      }
      if (decoded.opcode !== 0x1) continue
      let message
      try {
        message = JSON.parse(decoded.payload.toString('utf8'))
      } catch {
        this.send({ type: 'error', code: 'INVALID_JSON', message: 'Bridge messages must be valid JSON.' })
        continue
      }
      this.onMessage(message)
    }
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'hello') {
      if (message.protocol !== PROTOCOL_VERSION) {
        this.send({ type: 'hello_error', code: 'PROTOCOL_MISMATCH', expected: PROTOCOL_VERSION })
        return
      }
      this.info = {
        protocol: message.protocol,
        pluginVersion: String(message.pluginVersion || 'unknown'),
        documentId: String(message.documentId || ''),
        page: message.page || null,
        capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
        connectedAt: new Date().toISOString(),
      }
      this.send({ type: 'hello_ack', protocol: PROTOCOL_VERSION, sessionId: this.info.documentId })
      log(`connected document=${this.info.documentId || 'unknown'}`)
      return
    }
    if (message.type === 'event' && message.event === 'context_changed' && this.info) {
      this.info = { ...this.info, page: message.page || this.info.page }
      return
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new BridgeError(message.error?.code || 'HOST_ERROR', message.error?.message || 'QuickDesign operation failed', message.error?.data))
  }

  send(message) {
    if (!this.socket || this.socket.destroyed) throw new BridgeError('NOT_CONNECTED', 'QuickDesign is not connected.')
    this.socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(message), 'utf8')))
  }

  call(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.socket || !this.info) {
      throw new BridgeError('NOT_CONNECTED', 'QuickDesign is not connected. Open the target MasterGo document and run QuickDesign.')
    }
    const id = cryptoRandomId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('TIMEOUT', `${method} timed out after ${timeoutMs} ms.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({
        type: 'request',
        id,
        sessionId: this.info.documentId,
        method,
        params,
        idempotencyKey: id,
      })
    })
  }
}

const connection = new QuickDesignConnection()

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function acceptKey(key) {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

function encodeWebSocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = [0x80 | opcode]
  if (body.length < 126) head.push(body.length)
  else if (body.length < 65536) head.push(126, (body.length >> 8) & 0xff, body.length & 0xff)
  else {
    const length = BigInt(body.length)
    head.push(127)
    for (let shift = 56n; shift >= 0n; shift -= 8n) head.push(Number((length >> shift) & 0xffn))
  }
  return Buffer.concat([Buffer.from(head), body])
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const value = buffer.readBigUInt64BE(2)
    if (value > BigInt(MAX_WS_PAYLOAD)) throw new BridgeError('PAYLOAD_TOO_LARGE', 'WebSocket payload exceeds limit.')
    length = Number(value)
    offset = 10
  }
  if (length > MAX_WS_PAYLOAD) throw new BridgeError('PAYLOAD_TOO_LARGE', 'WebSocket payload exceeds limit.')
  const maskBytes = masked ? 4 : 0
  if (buffer.length < offset + maskBytes + length) return null
  const mask = masked ? buffer.subarray(offset, offset + 4) : null
  offset += maskBytes
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  return { opcode, payload, consumed: offset + length }
}

function handleUpgrade(request, socket) {
  const remote = request.socket.remoteAddress || ''
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote.endsWith(':127.0.0.1')
  if (!isLoopback || request.url !== '/quickdesign') {
    socket.destroy()
    return
  }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.destroy()
    return
  }
  // Each MCP process represents one agent-to-document session.  Do not let a
  // later plugin replace an already attached document: discovery is advisory
  // and two UIs can still race between probing and upgrading.
  if (connection.socket && !connection.socket.destroyed) {
    socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 23\r\n\r\nBridge already occupied')
    socket.end()
    return
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n',
  ].join('\r\n'))
  connection.attach(socket)
}

function httpHandler(request, response) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }
  // Read-only discovery probe: reports this bridge's port/occupancy without touching the
  // WebSocket, so a plugin can enumerate live bridges without stealing an existing connection.
  if (request.method === 'GET' && request.url === '/quickdesign/status') {
    const connected = Boolean(connection.socket && connection.info)
    response.writeHead(200, { 'content-type': 'application/json', ...cors })
    response.end(JSON.stringify({
      protocol: PROTOCOL_VERSION,
      version: SERVER_VERSION,
      port: boundPort,
      connected,
      documentId: connected ? String(connection.info?.documentId || '') : null,
      connectedAt: connected ? connection.info?.connectedAt || null : null,
      error: connection.bridgeError || null,
    }))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain', ...cors })
  response.end('QuickDesign MasterGo Bridge\n')
}

function makeBridgeServer(host) {
  const server = createServer(httpHandler)
  server.on('upgrade', handleUpgrade)
  return server
}

const servers = []
const primaryServer = makeBridgeServer(PRIMARY_BIND_HOST)

function bindSecondary(port) {
  for (const host of BRIDGE_BIND_HOSTS) {
    if (host === PRIMARY_BIND_HOST) continue
    const server = makeBridgeServer(host)
    server.on('error', error => log(`bridge ${host} unavailable: ${error.message}`))
    server.listen(port, host, () => log(`bridge listening ws://${host}:${port}/quickdesign`))
    servers.push(server)
  }
}

function bindPrimary() {
  const port = BRIDGE_PORT + portAttemptIndex
  if (port > BRIDGE_PORT + BRIDGE_PORT_RANGE - 1) {
    connection.bridgeError = `No free bridge port in ${BRIDGE_PORT}-${BRIDGE_PORT + BRIDGE_PORT_RANGE - 1}.`
    log(connection.bridgeError)
    return
  }
  primaryServer.listen(port, PRIMARY_BIND_HOST)
}

primaryServer.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    portAttemptIndex += 1
    bindPrimary()
    return
  }
  if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') {
    log(`bridge ${PRIMARY_BIND_HOST} unavailable: ${error.message}`)
    return
  }
  connection.bridgeError = error.message
  log(`bridge unavailable: ${connection.bridgeError}`)
})
primaryServer.on('listening', () => {
  boundPort = BRIDGE_PORT + portAttemptIndex
  servers.push(primaryServer)
  log(`bridge listening ws://${PRIMARY_BIND_HOST}:${boundPort}/quickdesign`)
  bindSecondary(boundPort)
})

bindPrimary()

// Cross-transport parity: both the shared STDIO MCP (server.mjs) and this legacy
// direct-WS MCP must advertise the same schemas so a capability added to
// tools.mjs is instantly reachable over either transport. Drift here is what
// caused mastergo_update_nodes's new patch fields to be missing from legacy.
const tools = commonTools
const toolMethods = commonToolMethods

// Legacy transport bypasses broker's assertNodeOpRevision, so enforce the
// unsigned-bypass rejection at the tool dispatch boundary as well.
function sanitizeLegacyNodeOpParams(name, args) {
  if (name !== 'mastergo_node_op' || !args || typeof args !== 'object') return args
  if (!Object.prototype.hasOwnProperty.call(args, 'allowUnsigned')) return args
  const { allowUnsigned: _drop, ...rest } = args
  return rest
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
  }
}

async function readStatus(args) {
  const params = args && typeof args === 'object' ? args : {}
  const status = connection.status()
  if (!status.connected || params.includeContext === false) return status
  try {
    status.context = await connection.call('session.context', {}, STATUS_CONTEXT_TIMEOUT_MS)
  } catch (error) {
    // The bridge socket is live but context could not be read in time; keep the
    // connection report useful instead of failing the whole status call.
    status.contextError = { code: error.code || 'HOST_ERROR', message: error.message }
  }
  return status
}

async function callTool(name, args) {
  if (name === 'mastergo_status') return toolResult(await readStatus(args))
  if (!(name in toolMethods)) return toolResult({ code: 'METHOD_NOT_FOUND', message: `Unknown tool: ${name}` }, true)
  const safeArgs = sanitizeLegacyNodeOpParams(name, args || {})
  try {
    return toolResult(await connection.call(toolMethods[name], safeArgs))
  } catch (error) {
    return toolResult({ code: error.code || 'HOST_ERROR', message: error.message, data: error.data }, true)
  }
}

function sendMcp(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleMcp(message) {
  if (!message || message.jsonrpc !== '2.0') return
  if (message.method === 'notifications/initialized') return
  if (message.method === 'initialize') {
    sendMcp({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Use mastergo_status first: when connected it already returns the document, page, and current selection, so do not chain extra read calls to confirm the connection. Call mastergo_get_context again only after the selection or page changes. Only call mastergo_get_node_tree with an explicit nodeId when a bounded subtree is genuinely needed. QuickDesign must be running in the target MasterGo document.',
      },
    })
    return
  }
  if (message.method === 'ping') {
    sendMcp({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'tools/list') {
    sendMcp({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    const result = await callTool(message.params?.name, message.params?.arguments)
    sendMcp({ jsonrpc: '2.0', id: message.id, result })
    return
  }
  if (typeof message.id !== 'undefined') {
    sendMcp({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
  }
}

let inputBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  inputBuffer += chunk
  while (true) {
    const newline = inputBuffer.indexOf('\n')
    if (newline < 0) break
    const line = inputBuffer.slice(0, newline).trim()
    inputBuffer = inputBuffer.slice(newline + 1)
    if (!line) continue
    try {
      void handleMcp(JSON.parse(line)).catch(error => log(error.stack || error.message))
    } catch (error) {
      log(`invalid MCP JSON: ${error.message}`)
    }
  }
})

process.stdin.on('end', () => servers.forEach(server => server.close()))
