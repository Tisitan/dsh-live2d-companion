// 桌宠进程凭据（PID 文件）生命周期：桌宠拿单实例锁后写入自己的 pid，退场时清理；
// 宿主跨重启凭它识别存活实例并收养——孤儿不再占锁弹回新 spawn，桌宠不再「消失」。
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readPidRecord(file) {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8'))
    return rec !== null && typeof rec === 'object' && !Array.isArray(rec) ? rec : null
  } catch {
    return null
  }
}

export function writePidRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(record))
}

export function clearPidRecord(file) {
  try { rmSync(file, { force: true }) } catch { }
}

// ESRCH=不存在；EPERM=存在但无权发信号（按存活算，保守正确）
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

// 查目标 pid 的真实可执行文件路径：防 PID 复用误判（误收养会在 dispose 时 taskkill 无辜进程）。
// 输出走 base64 规避中文系统 GBK 控制台编码毁路径；非 Windows/查询失败一律 null——
// 调用方降级为「自述+探活」弱验证而非拒收，避免验证通道故障让孤儿问题复辟。
export function queryExecutablePath(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath))`],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let out = ''
      ps.stdout.on('data', (chunk) => { out += chunk })
      ps.on('error', () => done(null))
      ps.on('close', () => {
        try {
          done(out.trim() === '' ? null : Buffer.from(out.trim(), 'base64').toString('utf8'))
        } catch {
          done(null)
        }
      })
      setTimeout(() => { ps.kill(); done(null) }, 8000).unref()
    } catch {
      done(null)
    }
  })
}

/**
 * 判定 PID 文件指向的桌宠是否可收养。
 * alive：记录自洽（exe 自述与预期一致）+ 进程存活 +（尽测）实况可执行文件核实。
 * free：文件已顺手清理；usurped（PID 已被他人复用）绝不触碰目标进程。
 */
export async function findLivePet({ pidFile, expectedExe, verifyExecutablePath = queryExecutablePath }) {
  const wanted = String(expectedExe)
  const rec = readPidRecord(pidFile)
  if (rec === null) {
    clearPidRecord(pidFile)
    return { status: 'free', reason: 'no usable pid file' }
  }
  const claimedExe = typeof rec.exe === 'string' ? rec.exe : ''
  if (!Number.isInteger(rec.pid) || rec.pid <= 0 || claimedExe === '' || !samePath(claimedExe, wanted)) {
    clearPidRecord(pidFile)
    return { status: 'free', reason: `malformed or foreign pid file entry (exe claimed: ${claimedExe === '' ? 'none' : claimedExe})` }
  }
  if (!isPidAlive(rec.pid)) {
    clearPidRecord(pidFile)
    return { status: 'free', reason: `stale pid file (pid ${rec.pid} no longer exists)` }
  }
  const actual = await verifyExecutablePath(rec.pid)
  if (actual !== null && !samePath(actual, wanted)) {
    clearPidRecord(pidFile)
    return { status: 'free', reason: `pid ${rec.pid} reused by another executable (${actual})` }
  }
  return { status: 'alive', pid: rec.pid, identityVerified: actual !== null }
}
