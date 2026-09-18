#!/usr/bin/env node
/**
 * End-to-end check of the `assistant/message` fallback.
 *
 * Harness builds exist that never emit `assistant/chunk`, leaving streaming
 * (the live path) with nothing to forward; the bridge then has to fall back to
 * the committed `assistant/message`. This drives one prompt and asserts the
 * reply arrives exactly once — proving both that the fallback fires and that it
 * does not duplicate text streaming already delivered.
 *
 * Usage: node scripts/acp-message-fallback-test.mjs <command> [args...]
 * Exits 0 only when exactly one copy of the reply reaches the client.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const [cmd, ...args] = process.argv.slice(2)
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let seq = 0
const texts = []
let msgId = null

const send = (method, params) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'session/update') {
    const u = m.params?.update
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      texts.push(u.content.text)
      msgId = u.messageId
    }
  }
  if (m.method === 'session/request_permission') {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: m.params?.options?.[0]?.optionId } } }) + '\n')
  }
})

await send('initialize', { protocolVersion: 1, clientCapabilities: {} })
const s = await send('session/new', { cwd: process.cwd(), mcpServers: [] })
const sid = s.result.sessionId
await send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Reply with exactly: DUPCHECK-OK' }] })

// Let trailing updates drain.
await new Promise((r) => setTimeout(r, 3000))

const joined = texts.join('')
const occurrences = joined.split('DUPCHECK-OK').length - 1
console.log(`CHUNKS: ${texts.length}`)
console.log(`TEXT: ${JSON.stringify(joined)}`)
console.log(`MESSAGE_IDS: ${new Set([msgId]).size}`)
console.log(`OCCURRENCES: ${occurrences}`)
const ok = occurrences === 1
console.log(ok ? 'PASS  exactly one copy of the reply' : `FAIL  expected 1 occurrence, got ${occurrences}`)
child.kill()
process.exit(ok ? 0 : 1)
