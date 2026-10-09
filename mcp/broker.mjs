import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { createServer as httpServer } from 'node:http'
import { createServer as ipcServer } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { encodeWebSocketFrame, decodeWebSocketFrame } from './websocket.mjs'
import { toolMethods } from './tools.mjs'

export const VERSION = '0.2.0'
const bundleFiles = ['server.mjs', 'broker.mjs', 'runtime.mjs', 'tools.mjs', 'websocket.mjs', 'legacy-server.mjs']
export const BUILD_ID = `quickdesign-v2-${createHash('sha256').update(bundleFiles.map(file => readFileSync(new URL(file, import.meta.url))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest('hex').slice(0, 16)}`
export const PROTOCOL = 'quickdesign.bridge.v2'
const MAX_BYTES = 2 * 1024 * 1024
const fail = (code, message, data) => Object.assign(new Error(message), { code, data })
const errorValue = error => ({ code: error.code || 'HOST_ERROR', message: error.message, ...(error.data ? { data: error.data } : {}) })
const hash = value => createHash('sha256').update(value).digest('hex')
const isWrite = method => !['session.context', 'nodes.tree'].includes(method)

export async function startBroker({ runtimeDir, basePort = 50679, portRange = 8, idleMs = 60_000, requestTimeoutMs = 170_000, contextTimeoutMs = 3000 } = {}) {
  if (!Number.isInteger(basePort) || basePort < 0 || basePort > 65535 || !Number.isInteger(portRange) || portRange < 1 || portRange > 128 || basePort + portRange - 1 > 65535) throw fail('INVALID_PORT', 'Bridge 端口或候选范围无效。')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const ipcPath = join(runtimeDir, 'broker.sock')
  const authPath = join(runtimeDir, 'authorized.json')
  const recoveryPath = join(runtimeDir, 'recovery.json')
  const readJSON = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
  const saveJSON = (path, value) => {
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    renameSync(temp, path)
  }
  const authorized = readJSON(authPath, {})
  let recovery = {}
  if (existsSync(recoveryPath)) {
    try {
      recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'))
      if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) throw new Error('Invalid recovery journal')
    } catch { throw fail('RECOVERY_INVALID', '操作恢复记录不可读，请核对记录后恢复，不能忽略未知写入启动服务。') }
  }
  const brokerId = randomUUID()
  const agents = new Map(), plugins = new Map(), pairings = new Map(), documents = new Map(), connections = new Map()
  let port, closing = false, idleSince = Date.now()
  const servers = []
  const doc = id => {
    if (!documents.has(id)) documents.set(id, { id, queue: [], active: null, lastAgent: null, cache: new Map(), blocked: recovery[id] || null })
    return documents.get(id)
  }
  const send = (plugin, message) => {
    if (!plugin.socket.destroyed) plugin.socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(message))))
  }
  const agentSummary = agent => ({
    sessionId: agent.id, name: agent.name, version: agent.version, documentId: agent.binding?.documentId || null,
    state: [...documents.values()].some(d => d.active?.agentId === agent.id) ? 'executing'
      : agent.paused ? 'paused'
      : [...documents.values()].some(d => d.queue.some(q => q.agentId === agent.id)) ? 'queued' : 'idle',
    queued: [...documents.values()].reduce((sum, d) => sum + d.queue.filter(q => q.agentId === agent.id).length, 0),
  })
  const listDocs = () => [...documents.values()].filter(d => [...plugins.values()].some(p => p.documentId === d.id)).map(d => {
    const primary = [...plugins.values()].find(p => p.documentId === d.id)
    return { documentId: d.id, pluginSessionId: primary.id, page: primary.page, pluginCount: [...plugins.values()].filter(p => p.documentId === d.id).length,
      blocked: d.blocked, queued: d.queue.length, operationId: d.active?.id || null }
  })
  const snapshot = () => ({ type: 'sessions', brokerId, buildId: BUILD_ID, version: VERSION, protocol: PROTOCOL, port,
    agents: [...agents.values()].map(agentSummary), documents: listDocs() })
  const broadcast = () => { for (const plugin of plugins.values()) send(plugin, snapshot()) }
  const bind = (agent, documentId) => {
    const primary = [...plugins.values()].find(p => p.documentId === documentId)
    if (!primary) throw fail('NOT_CONNECTED', '目标 MasterGo 文档未连接。')
    agent.binding = { documentId, pluginSessionId: primary.id }
    agent.paused = false
    broadcast()
    return agent.binding
  }
  const target = agent => {
    if (agent.paused) throw fail('AGENT_PAUSED', '此智能体会话已在插件中解绑；请明确调用 mastergo_select_document 恢复。')
    if (!agent.binding) {
      const available = listDocs()
      if (available.length !== 1) throw fail(available.length ? 'TARGET_REQUIRED' : 'NOT_CONNECTED', available.length ? '多个文档在线，请调用 mastergo_select_document 明确选择。' : '请在目标文档打开 QuickDesign 并完成首次配对。')
      bind(agent, available[0].documentId)
    }
    const plugin = plugins.get(agent.binding.pluginSessionId)
    if (!plugin || plugin.documentId !== agent.binding.documentId) throw fail('SESSION_CHANGED', '文档连接已变更，请重新选择目标文档。')
    return plugin
  }
  const finish = (d, entry, value, error) => {
    clearTimeout(entry.timer)
    if (entry.unknown) {
      entry.promise = error ? Promise.reject(error) : Promise.resolve(value)
      entry.promise.catch(() => {})
    }
    if (!entry.settled) { entry.settled = true; error ? entry.reject(error) : entry.resolve(value) }
    entry.terminal = true
    d.active = null
    if (recovery[d.id]?.operationId === entry.id) {
      const previous = recovery[d.id]
      delete recovery[d.id]
      try {
        saveJSON(recoveryPath, recovery)
        if (d.blocked?.operationId === entry.id) d.blocked = null
      } catch {
        recovery[d.id] = previous
        d.blocked = { ...previous, reason: '宿主已返回结果，但恢复记录无法清理；请检查本机存储。' }
      }
    }
    entry.completedAt = Date.now()
    broadcast()
    pump(d)
  }
  function pump(d) {
    if (d.active || d.blocked || !d.queue.length) return
    const nextIndex = d.queue.findIndex(q => q.agentId !== d.lastAgent)
    const entry = d.queue.splice(nextIndex < 0 ? 0 : nextIndex, 1)[0]
    clearTimeout(entry.queueTimer)
    const plugin = plugins.get(entry.pluginId)
    if (!plugin) { entry.settled = true; entry.terminal = true; entry.completedAt = Date.now(); entry.reject(fail('SESSION_CHANGED', '请求目标连接已失效。')); pump(d); return }
    d.active = entry; d.lastAgent = entry.agentId
    if (entry.write) {
      recovery[d.id] = { operationId: entry.id, documentId: d.id, reason: '结果尚未确认', createdAt: Date.now() }
      try { saveJSON(recoveryPath, recovery) } catch {
        delete recovery[d.id]; d.active = null; entry.settled = true; entry.terminal = true; entry.completedAt = Date.now()
        entry.reject(fail('JOURNAL_ERROR', '无法保存操作恢复记录，写入未发送。')); broadcast(); pump(d); return
      }
    }
    entry.timer = setTimeout(() => {
      if (d.active !== entry) return
      if (entry.write) {
        d.blocked = recovery[d.id]
        entry.unknown = true
        entry.settled = true
        entry.reject(fail('OUTCOME_UNKNOWN', '宿主写入结果尚未确认；后续操作暂停，请核对画布后处理该 operationId。', d.blocked))
        broadcast()
      } else finish(d, entry, null, fail('TIMEOUT', '宿主读取超时。'))
    }, entry.timeoutMs)
    send(plugin, { type: 'request', id: entry.id, operationId: entry.id, agentSessionId: entry.agentId,
      pluginSessionId: plugin.id, sessionId: plugin.id, documentId: plugin.documentId,
      method: entry.method, params: entry.params, idempotencyKey: entry.key })
    broadcast()
  }
  function assertNodeOpRevision(params) {
    const action = params && params.action
    if (action === 'move' || action === 'reorder') {
      if (typeof params.expectedSignature !== 'string' || !params.expectedSignature) {
        throw fail('REVISION_REQUIRED', `节点操作 ${action} 须提供 expectedSignature，请先用 mastergo_get_node_tree 读取当前签名。`)
      }
      return
    }
    if (action === 'delete' || action === 'ungroup' || action === 'group' || action === 'boolean') {
      const ids = Array.isArray(params.nodeIds)
        ? params.nodeIds.map(String)
        : (action === 'ungroup' && params.groupId ? [String(params.groupId)] : [])
      if (!ids.length) return
      const provided = new Set((Array.isArray(params.expectedSignatures) ? params.expectedSignatures : [])
        .filter(entry => entry && typeof entry.nodeId === 'string').map(entry => entry.nodeId))
      const missing = ids.filter(id => !provided.has(id))
      if (missing.length) throw fail('REVISION_REQUIRED', `节点操作 ${action} 须为每个目标提供 expectedSignatures（缺少 ${missing.join(', ')}）。`)
    }
  }
  function enqueue(agent, method, params, key, timeoutMs = requestTimeoutMs) {
    const plugin = target(agent), d = doc(plugin.documentId)
    if (d.blocked) throw fail('OUTCOME_UNKNOWN', '此文档有结果未知的操作，请先核对并处理。', d.blocked)
    if (method === 'history.undo') throw fail('UNDO_CONFLICT', '共享模式不执行全局撤销，避免撤销其他智能体或人工操作。')
    if (method === 'nodes.updateText' && !params.expectedSignature) throw fail('REVISION_REQUIRED', '修改文本须提供 expectedSignature。')
    if (method === 'nodes.update' && params.updates?.some(update => !update.expectedSignature)) throw fail('REVISION_REQUIRED', '每项节点修改须提供 expectedSignature。')
    if (method === 'nodes.op') assertNodeOpRevision(params)
    const cacheKey = `${agent.id}:${plugin.documentId}:${key}`
    const signature = JSON.stringify({ method, params })
    const previous = d.cache.get(cacheKey)
    if (previous) {
      if (previous.signature !== signature) throw fail('IDEMPOTENCY_CONFLICT', '同一操作键不能用于不同参数。')
      return previous.promise
    }
    if (isWrite(method) && d.cache.size >= 1000) throw fail('BUSY', '文档去重记录达到上限，请完成并核对当前操作后重新连接智能体会话。')
    if (d.queue.length >= 128 || d.queue.filter(q => q.agentId === agent.id).length >= 32) throw fail('BUSY', '文档操作队列已满，请等待当前请求完成。')
    const entry = { id: randomUUID(), key, signature, agentId: agent.id, pluginId: plugin.id, method, params, write: isWrite(method), timeoutMs }
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
    // Avoid unhandled rejection while the adapter is closing or attaching its response handler.
    entry.promise.catch(() => {})
    entry.queueTimer = setTimeout(() => {
      const index = d.queue.indexOf(entry)
      if (index < 0) return
      d.queue.splice(index, 1); entry.terminal = true; entry.completedAt = Date.now()
      entry.reject(fail('QUEUE_TIMEOUT', '请求排队超时，尚未发送给宿主。')); broadcast()
    }, timeoutMs)
    if (entry.write) d.cache.set(cacheKey, entry)
    d.queue.push(entry); pump(d)
    return entry.promise
  }
  async function call(agent, name, args = {}, key = randomUUID()) {
    if (name === 'mastergo_list_documents') return { documents: listDocs(), binding: agent.binding || null }
    if (name === 'mastergo_select_document') return bind(agent, args.documentId)
    if (name === 'mastergo_approve_connection') {
      const pending = pairings.get(args.pairingId)
      if (!pending || Date.now() - pending.createdAt > 120_000) throw fail('PAIRING_EXPIRED', '配对请求已失效，请在插件重新连接。')
      const token = randomBytes(32).toString('hex')
      authorized[hash(token)] = pending.documentId; saveJSON(authPath, authorized); pairings.delete(args.pairingId)
      registerPlugin(pending, token)
      return { documentId: pending.documentId, pluginSessionId: pending.id, paired: true }
    }
    if (name === 'mastergo_resolve_operation') {
      const plugin = target(agent), d = doc(plugin.documentId)
      if (d.blocked?.operationId !== args.operationId) throw fail('OPERATION_MISMATCH', '操作不属于当前文档的待确认记录。')
      if (d.active && plugins.has(d.active.pluginId)) throw fail('BUSY', '宿主仍可能执行中，必须先关闭该插件执行实例并核对结果。')
      const nextRecovery = { ...recovery }; delete nextRecovery[d.id]
      saveJSON(recoveryPath, nextRecovery)
      if (d.active) { clearTimeout(d.active.timer); d.active = null }
      d.blocked = null; delete recovery[d.id]; pump(d); broadcast()
      return { operationId: args.operationId, resolution: args.resolution, replayed: false }
    }
    if (name === 'mastergo_status') {
      let plugin, actionRequired = null
      try { plugin = target(agent) } catch (error) { actionRequired = error.message }
      const status = { connected: Boolean(plugin), bridge: { host: '127.0.0.1', port, version: VERSION, protocol: PROTOCOL, brokerId, buildId: BUILD_ID },
        agent: agentSummary(agent), agents: [...agents.values()].map(agentSummary), documents: listDocs(),
        plugin: plugin ? { documentId: plugin.documentId, page: plugin.page, pluginVersion: plugin.version, pluginSessionId: plugin.id, capabilities: plugin.capabilities.filter(c => c !== 'history.undo') } : null,
        pendingConnections: [...pairings.values()].map(p => ({ pairingId: p.id, documentId: p.documentId, page: p.page })), actionRequired }
      if (plugin && args.includeContext !== false) {
        try {
          status.context = await enqueue(agent, 'session.context', {}, key, contextTimeoutMs)
          // The context response refreshes plugin.page; build summaries from that response.
          status.plugin.page = plugin.page
          status.documents = listDocs()
        }
        catch (error) { status.contextError = errorValue(error) }
      }
      return status
    }
    if (!toolMethods[name]) throw fail('METHOD_NOT_FOUND', `Unknown tool: ${name}`)
    return enqueue(agent, toolMethods[name], args, key)
  }
  function registerPlugin(plugin, token) {
    plugins.set(plugin.id, plugin); doc(plugin.documentId)
    send(plugin, { type: 'hello_ack', protocol: PROTOCOL, sessionId: plugin.id, pluginSessionId: plugin.id, brokerId, buildId: BUILD_ID, ...(token ? { pairingToken: token } : {}) })
    broadcast()
  }
  function pluginMessage(plugin, message) {
    plugin.lastSeen = Date.now()
    if (message.type === 'hello' && !plugin.documentId) {
      if (message.protocol !== PROTOCOL || typeof message.documentId !== 'string' || !message.documentId) {
        send(plugin, { type: 'hello_error', code: 'PROTOCOL_MISMATCH', message: '请升级 QuickDesign 到共享 Bridge V2。' }); plugin.socket.end(); return
      }
      plugin.documentId = message.documentId; plugin.page = message.page || null; plugin.version = String(message.pluginVersion || 'unknown')
      plugin.capabilities = Array.isArray(message.capabilities) ? message.capabilities.filter(c => typeof c === 'string') : []
      if (typeof message.pairingToken === 'string' && authorized[hash(message.pairingToken)] === message.documentId) registerPlugin(plugin)
      else { plugin.createdAt = Date.now(); pairings.set(plugin.id, plugin); send(plugin, { type: 'pairing_required', pairingId: plugin.id, expiresIn: 120 }); }
      return
    }
    if (!plugins.has(plugin.id)) return
    if (message.type === 'disconnect_agent' && typeof message.agentSessionId === 'string') {
      const agent = agents.get(message.agentSessionId)
      if (!agent || agent.binding?.documentId !== plugin.documentId) {
        send(plugin, { type: 'control_result', ok: false, message: '该会话未绑定当前文档。' }); return
      }
      agent.paused = true; agent.binding = null
      const d = doc(plugin.documentId)
      for (const entry of [...d.queue]) if (entry.agentId === agent.id) {
        d.queue.splice(d.queue.indexOf(entry), 1); clearTimeout(entry.queueTimer)
        entry.terminal = true; entry.completedAt = Date.now(); entry.reject(fail('AGENT_PAUSED', '会话解绑，请求未发送。'))
      }
      // Already sent work remains locked until its terminal response; unbinding is not cancellation.
      send(plugin, { type: 'control_result', ok: true, message: '该智能体已解绑；已发送的操作仍需等待结果。' })
      broadcast(); return
    }
    if (message.type === 'ping') { send(plugin, { type: 'pong' }); return }
    if (message.type === 'pong') return
    if (message.type === 'event' && message.event === 'context_changed') { plugin.page = message.page || plugin.page; broadcast(); return }
    if (message.type !== 'response' || typeof message.id !== 'string') return
    const d = doc(plugin.documentId), entry = d.active
    if (!entry || entry.id !== message.id || entry.pluginId !== plugin.id) return
    if (entry.method === 'session.context' && message.ok) plugin.page = message.result?.document?.currentPage || message.result?.page || plugin.page
    finish(d, entry, message.result, message.ok ? null : fail(message.error?.code || 'HOST_ERROR', message.error?.message || '宿主操作失败。', message.error?.data))
  }
  function detachPlugin(plugin) {
    connections.delete(plugin.id)
    pairings.delete(plugin.id)
    if (!plugins.delete(plugin.id)) return
    const d = doc(plugin.documentId)
    for (const entry of [...d.queue]) {
      if (entry.pluginId !== plugin.id) continue
      d.queue.splice(d.queue.indexOf(entry), 1); clearTimeout(entry.queueTimer); entry.terminal = true; entry.completedAt = Date.now()
      entry.reject(fail('SESSION_CHANGED', '插件连接关闭，请重新选择文档。'))
    }
    if (d.active?.pluginId === plugin.id) {
      const entry = d.active; clearTimeout(entry.timer)
      if (entry.write) {
        d.blocked = recovery[d.id]; entry.settled = true; entry.unknown = true
        entry.reject(fail('OUTCOME_UNKNOWN', '插件断线，写入结果未知。', d.blocked))
      } else finish(d, entry, null, fail('NOT_CONNECTED', '插件已断线。'))
    }
    broadcast()
  }
  function upgrade(request, socket, head) {
    if (connections.size >= 64) { socket.destroy(); return }
    const remote = request.socket.remoteAddress
    const key = request.headers['sec-websocket-key']
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || request.url !== '/quickdesign' || typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') { socket.destroy(); return }
    // Opaque origins are used by plugin iframes; identity is established by pairing, never Origin alone.
    const origin = request.headers.origin
    if (origin && origin !== 'null' && !/^https:\/\/([a-z0-9-]+\.)?mastergo\.com$/.test(origin)) { socket.destroy(); return }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}\r\n\r\n`)
    const plugin = { id: randomUUID(), socket, buffer: Buffer.alloc(0), fragments: [], fragmentBytes: 0, lastSeen: Date.now() }
    connections.set(plugin.id, plugin)
    const consume = chunk => {
      try {
        plugin.buffer = Buffer.concat([plugin.buffer, chunk])
        if (plugin.buffer.length > MAX_BYTES + 32) throw fail('PAYLOAD_TOO_LARGE', '消息超限。')
        while (plugin.buffer.length >= 2) {
          const fin = Boolean(plugin.buffer[0] & 0x80), masked = Boolean(plugin.buffer[1] & 0x80), rsv = plugin.buffer[0] & 0x70
          if (!masked || rsv) throw fail('INVALID_FRAME', '非法 WebSocket 帧。')
          const frame = decodeWebSocketFrame(plugin.buffer)
          if (!frame) break
          plugin.buffer = plugin.buffer.subarray(frame.consumed)
          if (frame.opcode === 8) { socket.end(); break }
          if (frame.opcode === 9) { socket.write(encodeWebSocketFrame(frame.payload, 10)); continue }
          if (frame.opcode === 10) { plugin.lastSeen = Date.now(); continue }
          if (frame.opcode !== 0 && frame.opcode !== 1) throw fail('INVALID_FRAME', '仅接受文本消息。')
          if (frame.opcode === 1 && plugin.fragments.length || frame.opcode === 0 && !plugin.fragments.length) throw fail('INVALID_FRAME', '非法分片顺序。')
          plugin.fragments.push(frame.payload); plugin.fragmentBytes += frame.payload.length
          if (plugin.fragmentBytes > MAX_BYTES) throw fail('PAYLOAD_TOO_LARGE', '消息超限。')
          if (fin) { const message = JSON.parse(Buffer.concat(plugin.fragments).toString('utf8')); plugin.fragments = []; plugin.fragmentBytes = 0; pluginMessage(plugin, message) }
        }
      } catch { socket.destroy() }
    }
    socket.on('data', consume); socket.on('close', () => detachPlugin(plugin)); socket.on('error', () => detachPlugin(plugin))
    if (head?.length) consume(head)
    setTimeout(() => { if (!plugin.documentId && !socket.destroyed) socket.destroy() }, 5000).unref()
    setTimeout(() => { if (!plugins.has(plugin.id) && !socket.destroyed) socket.destroy() }, 125_000).unref()
  }
  const http = httpServer((request, response) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }
    if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return }
    if (request.method === 'GET' && request.url === '/quickdesign/status') {
      response.writeHead(200, { ...cors, 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: PROTOCOL, version: VERSION, buildId: BUILD_ID, brokerId, port, shared: true, connected: plugins.size > 0, documentId: null, connectedAt: null, error: null }))
    } else { response.writeHead(404); response.end() }
  })
  http.on('upgrade', upgrade)
  http.on('clientError', (_, socket) => socket.destroy())
  for (let offset = 0; offset < portRange; offset++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { http.off('listening', onListen); reject(error) }
        const onListen = () => { http.off('error', onError); resolve() }
        http.once('error', onError); http.once('listening', onListen); http.listen(basePort + offset, '127.0.0.1')
      })
      port = http.address().port; break
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  }
  if (!port) throw fail('PORT_RANGE_EXHAUSTED', '候选 Bridge 端口全部被占用，请配置自定义端口。')
  servers.push(http)
  const ipc = ipcServer(socket => {
    if (agents.size >= 256) { socket.destroy(); return }
    const agent = { id: randomUUID(), name: '未知客户端', version: '', socket }
    agents.set(agent.id, agent); idleSince = Date.now()
    socket.setEncoding('utf8'); let buffer = ''
    const reply = message => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) }
    reply({ type: 'ready', brokerId, buildId: BUILD_ID, version: VERSION, protocol: PROTOCOL, port, sessionId: agent.id })
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_BYTES) { socket.destroy(); return }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let message
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        if (message.type === 'register') {
          agent.name = typeof message.clientInfo?.name === 'string' ? message.clientInfo.name.slice(0, 80) : '未知客户端'
          agent.version = typeof message.clientInfo?.version === 'string' ? message.clientInfo.version.slice(0, 40) : ''
          broadcast(); continue
        }
        if (message.type !== 'call' || typeof message.id !== 'string') continue
        Promise.resolve().then(() => call(agent, message.name, message.args, message.key)).then(
          result => reply({ id: message.id, ok: true, result }), error => reply({ id: message.id, ok: false, error: errorValue(error) }))
      }
    })
    const remove = () => {
      if (!agents.delete(agent.id)) return
      for (const d of documents.values()) for (const entry of [...d.queue]) if (entry.agentId === agent.id) {
        d.queue.splice(d.queue.indexOf(entry), 1); clearTimeout(entry.queueTimer); entry.reject(fail('CLIENT_CLOSED', '智能体已退出，请求未发送。')); entry.terminal = true; entry.completedAt = Date.now()
      }
      broadcast(); idleSince = Date.now()
    }
    socket.on('error', remove); socket.on('close', remove)
    broadcast()
  })
  ipc.on('error', () => {})
  try { await new Promise((resolve, reject) => { ipc.once('error', reject); ipc.listen(ipcPath, resolve) }) }
  catch (error) { http.close(); throw error }
  servers.push(ipc)
  let pidStartedAt = null
  try { pidStartedAt = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() } catch {}
  saveJSON(join(runtimeDir, 'endpoint.json'), { brokerId, buildId: BUILD_ID, version: VERSION, port, ipcPath, pid: process.pid, pidStartedAt })
  async function close() {
    if (closing) return
    closing = true; clearInterval(maintenance)
    for (const p of connections.values()) p.socket.destroy()
    for (const agent of agents.values()) agent.socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    try { unlinkSync(ipcPath) } catch {}
    if (readJSON(join(runtimeDir, 'endpoint.json'), {}).brokerId === brokerId) try { unlinkSync(join(runtimeDir, 'endpoint.json')) } catch {}
  }
  const maintenance = setInterval(() => {
    for (const p of plugins.values()) {
      if (Date.now() - p.lastSeen > 90_000) p.socket.destroy()
      else send(p, { type: 'ping', uncertain: Date.now() - p.lastSeen > 30_000 })
    }
    for (const [id, p] of pairings) if (Date.now() - p.createdAt > 120_000) { pairings.delete(id); p.socket.destroy() }
    for (const d of documents.values()) for (const [key, entry] of d.cache) {
      if (!agents.has(entry.agentId) && entry.terminal) d.cache.delete(key)
      else if (entry.terminal && !entry.expired && Date.now() - entry.completedAt > 600_000) {
        entry.expired = true
        entry.promise = Promise.reject(fail('OPERATION_EXPIRED', '结果缓存已过期；此操作键不再执行，请核对已有结果。', { operationId: entry.id, replayed: false }))
        entry.promise.catch(() => {})
      }
    }
    if (agents.size || connections.size || [...documents.values()].some(d => d.active && plugins.has(d.active.pluginId) || d.queue.length)) idleSince = Date.now()
    else if (Date.now() - idleSince > idleMs) void close()
  }, Math.min(10_000, idleMs)).unref()
  return { brokerId, port, ipcPath, close }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startBroker({ runtimeDir: process.env.QUICKDESIGN_BROKER_RUNTIME_DIR,
    basePort: Number(process.env.QUICKDESIGN_BRIDGE_PORT || 50679), portRange: Number(process.env.QUICKDESIGN_BRIDGE_PORT_RANGE || 8),
    idleMs: Number(process.env.QUICKDESIGN_BROKER_IDLE_MS || 60_000),
    requestTimeoutMs: Number(process.env.QUICKDESIGN_REQUEST_TIMEOUT_MS || 170_000),
    contextTimeoutMs: Number(process.env.QUICKDESIGN_STATUS_CONTEXT_TIMEOUT_MS || 3000),
  }).catch(error => { process.stderr.write(`QuickDesign Broker: ${error.code || 'STARTUP_ERROR'} ${error.message}\n`); process.exitCode = 1 })
}
