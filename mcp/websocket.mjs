const MAX_WS_PAYLOAD = 2 * 1024 * 1024
class BridgeError extends Error { constructor(code, message) { super(message); this.code = code } }
export function encodeWebSocketFrame(payload, opcode = 0x1) {
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

export function decodeWebSocketFrame(buffer) {
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

