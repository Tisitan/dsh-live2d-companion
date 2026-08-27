// 桌宠 PID 凭据生命周期测试：读写往返 / 探活 / 收养决策（活收养 / 陈旧清理 / PID 复用拒绝 / 损坏容错）。
// 运行：node pet-lifecycle.test.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearPidRecord, findLivePet, isPidAlive, queryExecutablePath, readPidRecord, writePidRecord } from './pet-lifecycle.mjs'

let passed = 0, failed = 0
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ FAIL: ${label}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'l2d-pid-test-'))
const fakeExe = 'X:\\fake\\path\\electron.exe'
const pidFile = join(dir, 'pet.pid')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lower = (s) => String(s).toLowerCase()

// ── PID 文件读写 ──
{
  assert(readPidRecord(pidFile) === null, 'read: 不存在的文件返回 null')
  writePidRecord(pidFile, { pid: 4242, exe: fakeExe, bornAt: 123 })
  const rec = readPidRecord(pidFile)
  assert(rec !== null && rec.pid === 4242 && rec.exe === fakeExe, 'write/read: 往返保真')
  writeFileSync(pidFile, '{{{not json')
  assert(readPidRecord(pidFile) === null, 'read: 损坏 JSON 返回 null')
  clearPidRecord(pidFile)
  assert(!existsSync(pidFile), 'clear: 文件被移除')
  clearPidRecord(pidFile)
  assert(true, 'clear: 幂等不抛')
}

// ── B1 回归：凭据目录不存在时写入自建成功 ──
{
  const deepFile = join(dir, 'fresh', 'nested', 'pet.pid')
  writePidRecord(deepFile, { pid: 7, exe: fakeExe, bornAt: 456 })
  assert(readPidRecord(deepFile)?.pid === 7, 'write: 父目录整链缺失时递归自建并写入')

  const repoRoot = fileURLToPath(new URL('./', import.meta.url))
  const mainSrc = readFileSync(join(repoRoot, 'pet', 'main.js'), 'utf8')
  const mk = mainSrc.indexOf('fs.mkdirSync(path.dirname(L2D_PIDFILE)')
  const wr = mainSrc.indexOf('fs.writeFileSync(L2D_PIDFILE')
  assert(mk !== -1 && wr !== -1 && mk < wr, 'guard: pet/main.js 写凭据前先递归建目录（mkdir 在 write 之前）')

  const indexSrc = readFileSync(join(repoRoot, 'index.js'), 'utf8')
  assert(indexSrc.includes('ensurePetCredentialDir') && indexSrc.includes('mkdirSync(dirname(PET_PID_FILE)'),
    'guard: index.js 挂载时确保凭据目录存在（宿主侧双保险）')
}

// ── isPidAlive ──
{
  assert(isPidAlive(process.pid), 'alive: 自身进程存活')
  const dying = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => dying.on('exit', resolve))
  let dead = false
  for (let i = 0; i < 20 && !dead; i++) { dead = !isPidAlive(dying.pid); if (!dead) await sleep(100) }
  assert(dead, `alive: 已退出进程不再存活 (pid ${dying.pid})`)
}

// ── findLivePet 决策矩阵（verify 注入，免除环境依赖）──
{
  const noFile = await findLivePet({ pidFile: join(dir, 'absent.pid'), expectedExe: fakeExe, verifyExecutablePath: async () => null })
  assert(noFile.status === 'free' && /no usable/.test(noFile.reason), 'find: 无文件 → free')

  writeFileSync(pidFile, '{broken')
  const corrupt = await findLivePet({ pidFile, expectedExe: fakeExe, verifyExecutablePath: async () => null })
  assert(corrupt.status === 'free' && !existsSync(pidFile), 'find: 损坏文件 → free 且顺手清理')

  writePidRecord(pidFile, { pid: process.pid, exe: fakeExe.replace('fake', 'hijack'), bornAt: Date.now() })
  const foreignEntry = await findLivePet({ pidFile, expectedExe: fakeExe, verifyExecutablePath: async () => null })
  assert(foreignEntry.status === 'free' && /malformed or foreign/.test(foreignEntry.reason), 'find: exe 自述与预期不符 → free（凭据指向别的程序）')

  writePidRecord(pidFile, { pid: 999999999, exe: fakeExe, bornAt: Date.now() })
  const ghost = await findLivePet({ pidFile, expectedExe: fakeExe, verifyExecutablePath: async () => null })
  assert(ghost.status === 'free' && /stale/.test(ghost.reason) && !existsSync(pidFile), 'find: 死 pid → 陈旧清理')

  writePidRecord(pidFile, { pid: process.pid, exe: fakeExe, bornAt: Date.now() })
  const adopt = await findLivePet({ pidFile, expectedExe: fakeExe, verifyExecutablePath: async () => fakeExe.toUpperCase() })
  assert(adopt.status === 'alive' && adopt.pid === process.pid && adopt.identityVerified === true && existsSync(pidFile), 'find: 活进程 + 实况核实一致 → alive/verified（文件保留）')

  const usurped = await findLivePet({ pidFile, expectedExe: fakeExe, verifyExecutablePath: async () => 'C:\\Windows\\System32\\cmd.exe' })
  assert(usurped.status === 'free' && /reused by another executable/.test(usurped.reason) && !existsSync(pidFile), 'find: PID 被他人复用 → 拒收且不触碰目标进程')

  writePidRecord(pidFile, { pid: process.pid, exe: fakeExe, bornAt: Date.now() })
  const unverified = await findLivePet({ pidFile, expectedExe: fakeExe, verifyExecutablePath: async () => null })
  assert(unverified.status === 'alive' && unverified.identityVerified === false, 'find: 验证通道故障 → 弱验证收养（自述+探活）')
  clearPidRecord(pidFile)
}

// ── 真 CIM 验证通道 sanity（查询失败只跳过不计败）──
if (process.platform === 'win32') {
  const real = await queryExecutablePath(process.pid)
  if (real === null) console.log('  ○ SKIP: Win32_Process 查询通道不可用（环境限制）')
  else assert(lower(real) === lower(process.execPath), `query: 真实通道返回 node 可执行文件 (${real})`)
} else {
  const none = await queryExecutablePath(process.pid)
  assert(none === null, 'query: 非 Windows 平台恒 null（弱验证路径）')
}

// ── e2e 冒烟：真进程全链路（默认 CIM 验证）→ 存活收养 → 死后陈旧清理 ──
{
  const tenant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' })
  try {
    await sleep(200)
    writePidRecord(pidFile, { pid: tenant.pid, exe: process.execPath, bornAt: Date.now() })
    const alive = await findLivePet({ pidFile, expectedExe: process.execPath })
    assert(alive.status === 'alive' && alive.pid === tenant.pid,
      `smoke: 活进程收养${alive.identityVerified ? '' : '（CIM 不可用走弱验证）'}`)
  } finally {
    try { tenant.kill() } catch { }
  }
  await new Promise((resolve) => tenant.on('exit', resolve))
  let gone = false
  for (let i = 0; i < 30 && !gone; i++) { gone = !isPidAlive(tenant.pid); if (!gone) await sleep(100) }
  const afterDeath = await findLivePet({ pidFile, expectedExe: process.execPath })
  assert(afterDeath.status === 'free' && !existsSync(pidFile), 'smoke: 进程死亡 → 陈旧判定并清理凭据')
}

clearPidRecord(pidFile)
try { rmSync(dir, { recursive: true, force: true }) } catch { }

console.log(`\n结果：${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
