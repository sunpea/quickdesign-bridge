import { connect } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { BUILD_ID } from './broker.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const runtimeError = (code, message) => Object.assign(new Error(message), { code })
const processBirth = pid => {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() } catch { return null }
}
export const runtimeDirectory = () => process.env.QUICKDESIGN_BROKER_RUNTIME_DIR || join(homedir(), '.quickdesign', 'quickdesign-mastergo', 'run')

export function connectBroker(path, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const socket = connect(path); socket.setEncoding('utf8')
    let buffer = '', ready = false
    const pending = new Map()
    const fail = error => {
      clearTimeout(timer)
      if (!ready) reject(error)
      for (const waiter of pending.values()) waiter.reject(runtimeError('BROKER_CLOSED', '共享 Bridge 连接已关闭；写入结果未知时不能自动重放。'))
      pending.clear()
    }
    const timer = setTimeout(() => { socket.destroy(); reject(runtimeError('BROKER_TIMEOUT', '共享服务启动超时。')) }, timeoutMs)
    socket.on('error', fail); socket.on('close', () => fail(runtimeError('BROKER_CLOSED', '共享服务已关闭。')))
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { socket.destroy(); return }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let message
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        if (message.type === 'ready' && !ready) {
          clearTimeout(timer)
          if (message.buildId !== BUILD_ID) { reject(runtimeError('VERSION_MISMATCH', '现有共享服务版本不同；请完成当前操作后重新加载各客户端。')); socket.destroy(); return }
          ready = true
          resolve({ socket, info: message,
            register(clientInfo) { socket.write(`${JSON.stringify({ type: 'register', clientInfo })}\n`) },
            request(name, args = {}, key = randomUUID()) {
              if (socket.destroyed) return Promise.reject(runtimeError('BROKER_CLOSED', '共享服务已关闭。'))
              const id = randomUUID()
              return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject })
                socket.write(`${JSON.stringify({ type: 'call', id, name, args, key })}\n`)
              })
            }, close() { socket.end() },
          })
        } else if (typeof message.id === 'string') {
          const waiter = pending.get(message.id)
          if (!waiter) continue
          pending.delete(message.id)
          message.ok ? waiter.resolve(message.result) : waiter.reject(Object.assign(new Error(message.error.message), message.error))
        }
      }
    })
  })
}

export async function ensureBroker({ runtimeDir = runtimeDirectory(), timeoutMs = 8000 } = {}) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const socketPath = join(runtimeDir, 'broker.sock'), lockPath = join(runtimeDir, 'start.lock')
  const deadline = Date.now() + timeoutMs
  let owned = false, childError = null
  const ownerId = randomUUID()
  try {
    while (Date.now() < deadline) {
      try { return await connectBroker(socketPath) }
      catch (error) { if (error.code === 'VERSION_MISMATCH') throw error }
      if (!owned) {
        try {
          mkdirSync(lockPath, { mode: 0o700 }); owned = true
          writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ ownerId, pid: process.pid, pidStartedAt: processBirth(process.pid), at: Date.now() }), { mode: 0o600 })
          // Recheck after winning the lock; another launch may have become ready meanwhile.
          try { return await connectBroker(socketPath) } catch (error) { if (error.code === 'VERSION_MISMATCH') throw error }
          // Never unlink a socket owned by a live but slow/unresponsive service.
          let endpoint
          try { endpoint = JSON.parse(readFileSync(join(runtimeDir, 'endpoint.json'), 'utf8')) } catch {}
          if (endpoint?.pid) {
            let alive = true
            try { process.kill(endpoint.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
            if (alive && endpoint.pidStartedAt && processBirth(endpoint.pid) !== endpoint.pidStartedAt) alive = false
            if (alive) throw runtimeError('BROKER_UNRESPONSIVE', '已有共享服务进程存活但未响应，请诊断或重载该服务，不能自动抢占。')
          }
          try { unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
          const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'broker.mjs')], {
            detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, QUICKDESIGN_BROKER_RUNTIME_DIR: runtimeDir },
          })
          child.once('error', error => { childError = error })
          child.once('exit', code => { if (code !== 0) childError = runtimeError('BROKER_START_FAILED', '共享服务启动失败，请检查候选端口和目录权限。') })
          child.unref()
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          try {
            const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
            let alive = true
            try { process.kill(owner.pid, 0) } catch (e) { if (e.code === 'ESRCH') alive = false }
            if (alive && owner.pidStartedAt && processBirth(owner.pid) !== owner.pidStartedAt) alive = false
            if (!alive && Date.now() - owner.at > 1000) {
              const stale = `${lockPath}.stale.${ownerId}`
              renameSync(lockPath, stale); rmSync(stale, { recursive: true, force: true })
            }
          } catch {
            // Recover a creator that died between mkdir and publishing owner.json.
            try {
              if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
                const stale = `${lockPath}.stale.${ownerId}`
                renameSync(lockPath, stale); rmSync(stale, { recursive: true, force: true })
              }
            } catch { /* another waiter may have recovered it */ }
          }
        }
      }
      if (childError) throw childError
      await delay(50)
    }
    throw runtimeError('BROKER_TIMEOUT', '无法启动共享 Bridge，请检查端口占用、失效启动锁或客户端版本。')
  } finally {
    if (owned) {
      try { if (JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).ownerId === ownerId) rmSync(lockPath, { recursive: true, force: true }) } catch {}
    }
  }
}
