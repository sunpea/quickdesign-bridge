#!/usr/bin/env node
/**
 * One-time installer for the QuickDesign MasterGo MCP server.
 *
 * Why this exists: MCP clients used to be told to "find the quickdesign-mastergo
 * install directory", which turned every first connection into a filesystem
 * search. This script publishes the server to a fixed path and prints a
 * paste-ready config, so agents only ever need to read one known file.
 *
 * Usage: node plugins/quickdesign-mastergo/scripts/install-mcp.mjs
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BUILD_ID } from '../mcp/broker.mjs'

const INSTALL_DIR = join(homedir(), '.quickdesign', 'quickdesign-mastergo')
const INSTALLED_SERVER = join(INSTALL_DIR, 'server.mjs')
const INSTALLED_CONFIG = join(INSTALL_DIR, 'mcp.json')
const SOURCE_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs')
const CACHE_DIR = join(homedir(), '.codex', 'plugins', 'cache', 'personal', 'quickdesign-mastergo')

export const SERVER_NAME = 'quickdesign_mastergo'

/** Config object every MCP client can paste; absolute paths only, no shell lookup. */
export function buildMcpConfig(nodePath = process.execPath, serverPath = INSTALLED_SERVER) {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        command: nodePath,
        args: [serverPath],
        default_tools_approval_mode: 'writes',
        startup_timeout_sec: 10,
        tool_timeout_sec: 180,
      },
    },
  }
}

/** Migrate only this plugin's recognizable V1 cache entries, keeping recoverable originals. */
export function migrateCachedEntries(cacheRoot, serverPath) {
  if (!cacheRoot || !existsSync(cacheRoot)) return []
  const launcher = `#!/usr/bin/env node\n// QuickDesign canonical MCP entry; old cache metadata does not identify the running server version.\nawait import(${JSON.stringify(pathToFileURL(serverPath).href)})\n`
  const migrated = []
  for (const version of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!version.isDirectory()) continue
    const entry = join(cacheRoot, version.name, 'mcp', 'server.mjs')
    if (!existsSync(entry)) continue
    const current = readFileSync(entry, 'utf8')
    if (current === launcher) { migrated.push(entry); continue }
    // Never replace an unrelated/custom entry, or a newer self-contained V2 package.
    if (!current.includes("const SERVER_NAME = 'quickdesign-mastergo'") || !current.includes("const PROTOCOL_VERSION = 'quickdesign.bridge.v1'")) continue
    const backup = `${entry}.before-v2`
    if (!existsSync(backup)) copyFileSync(entry, backup)
    writeFileSync(`${entry}.tmp`, launcher)
    renameSync(`${entry}.tmp`, entry)
    migrated.push(entry)
  }
  return migrated
}

export function install({ nodePath = process.execPath, sourceServer = SOURCE_SERVER, installDir = INSTALL_DIR,
  migrateCacheRoot = installDir === INSTALL_DIR ? CACHE_DIR : null } = {}) {
  const files = ['server.mjs', 'broker.mjs', 'runtime.mjs', 'tools.mjs', 'websocket.mjs', 'legacy-server.mjs']
  const sourceDir = dirname(sourceServer)
  for (const file of files) if (!existsSync(join(sourceDir, file))) throw new Error(`安装包不完整：${file}`)
  const configPath = join(installDir, 'mcp.json')
  let previous = {}
  if (existsSync(configPath)) previous = JSON.parse(readFileSync(configPath, 'utf8'))
  mkdirSync(installDir, { recursive: true })
  const versionDir = join(installDir, 'versions', BUILD_ID)
  mkdirSync(versionDir, { recursive: true })
  for (const file of files) copyFileSync(join(sourceDir, file), join(versionDir, file))
  writeFileSync(join(versionDir, 'build.json'), `${JSON.stringify({ buildId: BUILD_ID, files }, null, 2)}\n`)
  const serverPath = join(installDir, 'server.mjs')
  // Atomically switch the stable launcher only after the complete bundle exists.
  const launcher = `${serverPath}.tmp`
  writeFileSync(launcher, `#!/usr/bin/env node\nawait import('./versions/${BUILD_ID}/server.mjs')\n`)
  if (existsSync(serverPath) && !existsSync(`${serverPath}.before-v2`)) copyFileSync(serverPath, `${serverPath}.before-v2`)
  renameSync(launcher, serverPath)
  const fresh = buildMcpConfig(nodePath, serverPath)
  const config = { ...previous, mcpServers: { ...previous.mcpServers,
    [SERVER_NAME]: { ...fresh.mcpServers[SERVER_NAME], ...previous.mcpServers?.[SERVER_NAME], command: nodePath, args: [serverPath] },
  } }
  writeFileSync(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(`${configPath}.tmp`, configPath)
  const migratedCacheEntries = migrateCachedEntries(migrateCacheRoot, serverPath)
  return { serverPath, configPath, config, migratedCacheEntries }
}

function main() {
  const { configPath, serverPath } = install()
  process.stdout.write(
    [
      'QuickDesign MasterGo MCP 已安装。',
      '',
      `服务入口：${serverPath}`,
      `配置文件：${configPath}`,
      '',
      '把下面内容写入智能体的 MCP 配置（Codex 为 config.toml 或 .mcp.json，WorkBuddy/Cursor 为 mcpServers）：',
      '',
      // Only emit this server's fresh copyable config; other preserved entries may contain secrets.
      JSON.stringify(buildMcpConfig(process.execPath, serverPath), null, 2),
      '',
    ].join('\n'),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
