const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const home = process.env.USERPROFILE
if (!home) throw new Error('找不到用户目录')

function backup(file) {
  if (!fs.existsSync(file)) return
  const target = file + '.live2d-backup'
  if (!fs.existsSync(target)) fs.copyFileSync(file, target)
}

function installCodex() {
  const codexDir = path.join(home, '.codex')
  const hooksFile = path.join(codexDir, 'hooks.json')
  fs.mkdirSync(codexDir, { recursive: true })
  let config = { description: 'User lifecycle hooks.', hooks: {} }
  if (fs.existsSync(hooksFile)) {
    backup(hooksFile)
    config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('现有 Codex hooks.json 格式不正确')
    if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) config.hooks = {}
  }
  const hookCmd = `"${path.join(root, 'adapters', 'codex-hook.cmd')}"`
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']
  for (const event of events) {
    if (!Array.isArray(config.hooks[event])) config.hooks[event] = []
    config.hooks[event] = config.hooks[event].filter(group =>
      !JSON.stringify(group).toLowerCase().includes('codex-hook.cmd'))
    config.hooks[event].push({ hooks: [{ type: 'command', command: hookCmd, commandWindows: hookCmd, timeout: 3 }] })
  }
  fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n')
  return hooksFile
}

function installOpenCode() {
  const pluginDir = path.join(home, '.config', 'opencode', 'plugins')
  const agentDir = path.join(home, '.config', 'opencode', 'agents')
  const pluginTarget = path.join(pluginDir, 'live2d-companion.js')
  const agentTarget = path.join(agentDir, 'nori.md')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  backup(pluginTarget)
  backup(agentTarget)
  fs.copyFileSync(path.join(root, 'adapters', 'opencode-live2d.js'), pluginTarget)
  fs.copyFileSync(path.join(root, 'adapters', 'nori.md'), agentTarget)
  return { plugin: pluginTarget, agent: agentTarget }
}

try {
  const codex = installCodex()
  const opencode = installOpenCode()
  console.log('安装完成。')
  console.log(`Codex: ${codex}`)
  console.log(`OpenCode 插件: ${opencode.plugin}`)
  console.log(`Nori 人设: ${opencode.agent}`)
  console.log('请重启 Codex/OpenCode。Codex 首次使用时还需要在 /hooks 中信任新钩子。')
} catch (error) {
  console.error('安装失败：' + error.message)
  process.exitCode = 1
}
