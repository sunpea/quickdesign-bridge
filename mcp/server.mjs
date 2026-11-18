#!/usr/bin/env node
// Stable STDIO entry; all clients share one broker instead of each owning a port.
if (process.env.QUICKDESIGN_BRIDGE_MODE === 'legacy') {
  await import('./legacy-server.mjs')
} else {
  const { tools, toolMethods, legacyAliasTools, resolveToolName } = await import('./tools.mjs')
  const { ensureBroker } = await import('./runtime.mjs')
  const { VERSION, BUILD_ID } = await import('./broker.mjs')
  const { randomUUID } = await import('node:crypto')
  const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false })
  const requiredString = { type: 'string', minLength: 1, maxLength: 200 }
  const extras = [
    { name: 'quickdesign_list_documents', description: 'List connected document summaries and this agent binding. Does not read canvas nodes.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true } },
    { name: 'quickdesign_select_document', description: 'Bind only this agent session to an explicit connected document. Use after SESSION_CHANGED; never silently choose another document.', inputSchema: { ...objectSchema({ documentId: requiredString }), required: ['documentId'] }, annotations: { readOnlyHint: true } },
    { name: 'quickdesign_approve_connection', description: 'Approve a pending QuickDesign pairing only after the user confirms the pairing ID and target document displayed by the plugin. Authorizes local design access.', inputSchema: { ...objectSchema({ pairingId: requiredString }), required: ['pairingId'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: 'quickdesign_resolve_operation', description: 'After the user closes the old executing plugin instance and checks the canvas, resolve a blocked unknown operation. Never replays the write. Requires explicit user confirmation of the observed outcome.', inputSchema: { ...objectSchema({ operationId: requiredString, resolution: { type: 'string', enum: ['confirmed_applied', 'confirmed_not_applied'] } }), required: ['operationId', 'resolution'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
  ]
  const canonicalTools = [...tools.map(tool => {
    const properties = { ...tool.inputSchema.properties }
    if (toolMethods[tool.name]) properties.operationKey = { type: 'string', minLength: 1, maxLength: 200, description: 'Keep this same key on retries; never replay an unknown write with a fresh key.' }
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } }
  }), ...extras]
  // 历史名继续出现在列表里，旧配置与旧提示词才不会因为「工具不存在」失败；
  // 它们只带一行说明和放行参数的结构，真正的校验按正名的完整 schema 走。
  const allTools = [...canonicalTools, ...legacyAliasTools(canonicalTools)]
  const validate = (schema, value, path = 'arguments') => {
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
      for (const name of schema.required || []) if (!(name in value)) throw new Error(`${path}.${name} is required`)
      for (const [name, item] of Object.entries(value)) {
        if (!schema.properties?.[name]) { if (schema.additionalProperties === false) throw new Error(`${path}.${name} is unsupported`); continue }
        validate(schema.properties[name], item, `${path}.${name}`)
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems || Infinity)) throw new Error(`${path} invalid array`)
      for (const item of value) validate(schema.items, item, path)
    } else if (schema.type === 'string') {
      if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} invalid string`)
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${path} invalid number`)
    } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} invalid boolean`)
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} invalid choice`)
  }
  let clientInfo = {}, connection = null, closed = false
  let connecting = null
  const broker = async () => {
    if (connection && !connection.socket.destroyed) return connection
    if (!connecting) connecting = ensureBroker().then(value => {
      if (closed) { value.close(); throw new Error('MCP client closed') }
      connection = value; value.register(clientInfo); return value
    }).finally(() => { connecting = null })
    return connecting
  }
  const send = message => { if (!closed) process.stdout.write(`${JSON.stringify(message)}\n`) }
  const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError })
  async function handle(message) {
    if (message?.jsonrpc !== '2.0') return
    if (message.method === 'initialize') {
      clientInfo = message.params?.clientInfo || {}
      try { const conn = await broker(); conn.register(clientInfo) }
      catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `${error.code || 'STARTUP_ERROR'}: ${error.message}` } }); return }
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'quickdesign-mastergo', version: VERSION },
        instructions: `Shared Broker ${BUILD_ID}. Use quickdesign_status first; do not chain extra read calls to confirm the connection. If multiple documents are online select explicitly. Request user confirmation before approving a pending pairing. Do not replay writes with unknown outcomes. Shared mode disables global undo. quickdesign_* is the canonical tool prefix; the older mastergo_* names are accepted aliases for the same tools.` } })
    } else if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: {} })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: allTools } })
    else if (message.method === 'tools/call') {
      try {
        const tool = canonicalTools.find(t => t.name === resolveToolName(message.params?.name))
        if (!tool) throw Object.assign(new Error('Unknown tool'), { code: 'METHOD_NOT_FOUND' })
        const args = message.params.arguments || {}
        try { validate(tool.inputSchema, args) } catch (error) { throw Object.assign(error, { code: 'INVALID_ARGUMENT' }) }
        const { operationKey, ...params } = args
        const conn = await broker()
        const value = await conn.request(tool.name, params, operationKey || randomUUID())
        send({ jsonrpc: '2.0', id: message.id, result: result(value) })
      } catch (error) { send({ jsonrpc: '2.0', id: message.id, result: result({ code: error.code || 'BROKER_ERROR', message: error.message, ...(error.data ? { data: error.data } : {}) }, true) }) }
    } else if (typeof message.id !== 'undefined') send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { process.stderr.write('QuickDesign MCP input exceeds limit.\n'); process.exitCode = 1; process.stdin.destroy(); connection?.close(); return }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try { void handle(JSON.parse(line)).catch(error => process.stderr.write(`QuickDesign MCP: ${error.code || 'ERROR'}\n`)) }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    }
  })
  const close = () => { closed = true; connection?.close() }
  process.stdin.on('end', close)
  process.on('SIGTERM', () => { close(); process.exit(0) })
}
