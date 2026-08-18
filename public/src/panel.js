/**
 * panel.js —— 模型面板：悬浮齿轮入口、模型扫描/切换/导入、预览弹窗。
 *
 * 面板只依赖 ctx 提供的 switchModel / modelPath / box / showBubble；
 * 不直接操作状态机或渲染细节。入口按钮默认静置 1.2 秒后自动隐藏，
 * 鼠标悬停模型区域时重新出现（面板打开时保持显示）。
 */

import { BASE, PREVIEW, BRIDGE, STANDALONE, loadQuips, store } from './config.js'
import { resolveBinding, extractInventory } from './binding.js'
import { attachGame } from './game.js'

/** 面板宽度上限（px）；窄窗口（如桌宠）下由 CSS min() 收缩，钳制用实测宽度。 */
const PANEL_WIDTH = 280

/**
 * 初始化模型面板。
 * @param {Object} ctx 共享上下文（switchModel / modelPath / box / showBubble）
 * @returns {?Object} 面板公共句柄；preview=1 的预览 iframe 中返回 null
 */
export function initPanel(ctx) {
  if (PREVIEW) return null

  const style = document.createElement('style')
  style.textContent = `
#l2d-model-toggle, #l2d-pin-toggle, #l2d-help-toggle, #l2d-game-toggle {
  position: absolute; top: 6px; right: 6px; z-index: 20;
  width: 34px; height: 34px; padding: 0; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,.6);
  background: rgba(255,255,255,.4);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: #4a5060; font: 16px/1 system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 2px 10px rgba(0,0,0,.14);
  opacity: .82; transition: opacity .25s ease, border-color .3s ease, background .2s ease;
}
#l2d-model-toggle:hover, #l2d-pin-toggle:hover, #l2d-help-toggle:hover, #l2d-game-toggle:hover {
  opacity: 1; background: rgba(255,255,255,.62); border-color: rgba(255,255,255,.85);
}
#l2d-model-toggle.l2d-hidden, #l2d-pin-toggle.l2d-hidden, #l2d-help-toggle.l2d-hidden, #l2d-game-toggle.l2d-hidden { opacity: 0; pointer-events: none; }
/* 静态排布（网页挂件用）：竖列自上而下 🔒❓⚙️🎮；桌宠由 followButtons 内联 left/top 覆盖此处 */
#l2d-help-toggle { top: 46px; }
#l2d-model-toggle { top: 86px; }
#l2d-game-toggle { top: 126px; }
/* 挂件无锁钮（display:none）：下方三钮逐位顶上，不留空洞 */
body.l2d-no-pin #l2d-help-toggle { top: 6px; }
body.l2d-no-pin #l2d-model-toggle { top: 46px; }
body.l2d-no-pin #l2d-game-toggle { top: 86px; }
/* 锁钮状态=边框呼吸灯：绿呼吸=自动穿透中 / 素玻璃=已解锁 / 蓝呼吸=手动锁定 */
@keyframes l2d-breathe {
  0%, 100% { box-shadow: 0 2px 10px rgba(0,0,0,.14), 0 0 3px 0 var(--glow, transparent); }
  50% { box-shadow: 0 2px 10px rgba(0,0,0,.14), 0 0 15px 4px var(--glow, transparent); }
}
#l2d-pin-toggle.auto {
  border-color: rgba(64,181,93,.85); --glow: rgba(64,181,93,.7);
  animation: l2d-breathe 2.6s ease-in-out infinite;
}
#l2d-pin-toggle.on {
  border-color: rgba(91,141,239,.9); --glow: rgba(91,141,239,.75);
  animation: l2d-breathe 2.6s ease-in-out infinite;
}
#l2d-pet-menu {
  position: fixed; z-index: 100000; min-width: 112px; padding: 4px;
  background: rgba(255,255,255,.97); color: #445;
  border: 1px solid rgba(0,0,0,.12); border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.22);
  font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  opacity: 0; visibility: hidden; transform: translateY(-4px);
  transition: opacity .15s ease, transform .15s ease, visibility .15s;
}
#l2d-pet-menu.open { opacity: 1; visibility: visible; transform: none; }
#l2d-pet-menu button {
  display: block; width: 100%; padding: 6px 10px; border: 0; border-radius: 7px;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
#l2d-pet-menu button:hover { background: #f0f4ff; }
#l2d-help-card {
  position: fixed; z-index: 100000; width: min(250px, calc(100vw - 16px));
  background: rgba(255,255,255,.97); color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,.24);
  font: 12px/1.8 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  padding: 10px 12px; box-sizing: border-box;
  opacity: 0; visibility: hidden; transform: translateY(-4px);
  transition: opacity .15s ease, transform .15s ease, visibility .15s;
}
#l2d-help-card.open { opacity: 1; visibility: visible; transform: none; }
#l2d-help-card .l2d-help-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 2px; }
#l2d-help-card .l2d-help-close { border: 0; background: none; cursor: pointer; color: #889; font-size: 14px; padding: 0 2px; }
#l2d-help-card ul { margin: 0; padding-left: 16px; }
#l2d-quips-card {
  position: fixed; z-index: 100000; width: min(300px, calc(100vw - 16px));
  background: rgba(255,255,255,.97); color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,.24);
  font: 12px/1.6 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  padding: 10px 12px; box-sizing: border-box;
  opacity: 0; visibility: hidden; transform: translateY(-4px);
  transition: opacity .15s ease, transform .15s ease, visibility .15s;
}
#l2d-quips-card.open { opacity: 1; visibility: visible; transform: none; }
#l2d-quips-card .l2d-quips-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 6px; }
#l2d-quips-card .l2d-quips-close { border: 0; background: none; cursor: pointer; color: #889; font-size: 14px; padding: 0 2px; }
#l2d-quips-card .l2d-quips-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
#l2d-quips-card .l2d-quips-row[hidden] { display: none; }
#l2d-quips-card .l2d-quips-pool { flex: 1; min-width: 0; height: 26px; border: 1px solid #d5dbe5; border-radius: 6px; background: #fff; font-size: 12px; }
#l2d-quips-card .l2d-quips-count { color: #99a; white-space: nowrap; }
#l2d-quips-card .l2d-quips-text {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 140px; max-height: 40vh;
  border: 1px solid #d5dbe5; border-radius: 8px; padding: 6px 8px;
  font: 12px/1.7 ui-monospace, 'Cascadia Mono', Consolas, monospace; color: #334;
}
#l2d-quips-card .l2d-quips-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
#l2d-quips-card .l2d-quips-status { color: #99a; }
#l2d-quips-card .l2d-quips-status.error { color: #c0392b; }
#l2d-quips-card .l2d-quips-save {
  border: 0; border-radius: 8px; padding: 5px 16px;
  background: #4a7fb5; color: #fff; font-size: 12px; cursor: pointer;
}
#l2d-quips-card .l2d-quips-save:hover { background: #3d6d9e; }
#l2d-quips-card .l2d-quips-actions { display: flex; gap: 6px; }
#l2d-quips-card .l2d-quips-preset { flex: 1; min-width: 0; height: 26px; border: 1px solid #d5dbe5; border-radius: 6px; background: #fff; font-size: 12px; }
#l2d-quips-card .l2d-quips-saveas {
  border: 1px solid #d5dbe5; border-radius: 6px; padding: 3px 8px;
  background: #fff; color: #556; font-size: 12px; cursor: pointer; white-space: nowrap;
}
#l2d-quips-card .l2d-quips-name {
  flex: 1; min-width: 0; height: 26px; box-sizing: border-box;
  border: 1px solid #d5dbe5; border-radius: 6px; padding: 0 8px; font-size: 12px;
}
#l2d-quips-card .l2d-quips-nameok, #l2d-quips-card .l2d-quips-namecancel {
  border: 1px solid #d5dbe5; border-radius: 6px; padding: 3px 8px;
  background: #fff; color: #556; font-size: 12px; cursor: pointer; white-space: nowrap;
}
#l2d-quips-card .l2d-quips-nameok { background: #4a7fb5; border-color: #4a7fb5; color: #fff; }
#l2d-quips-card .l2d-quips-reset, #l2d-quips-card .l2d-quips-del {
  border: 1px solid #d5dbe5; border-radius: 8px; padding: 4px 10px;
  background: #fff; color: #778; font-size: 12px; cursor: pointer;
}
#l2d-quips-card .l2d-quips-del:hover { color: #c0392b; border-color: #c0392b; }
#l2d-quips-card .l2d-quips-reset:disabled, #l2d-quips-card .l2d-quips-del:disabled { opacity: .45; cursor: default; }
#l2d-model-panel {
  position: fixed; z-index: 100000; width: min(280px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 16px));
  display: flex; flex-direction: column; box-sizing: border-box;
  background: rgba(255,255,255,.97); color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,.24);
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  opacity: 0; visibility: hidden; transform: translateY(-4px) scale(.98);
  transform-origin: 100% 0; transition: opacity .15s ease, transform .15s ease, visibility .15s;
  overflow: hidden;
}
#l2d-model-panel.open { opacity: 1; visibility: visible; transform: none; }
#l2d-model-panel .l2d-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px; font-weight: 600;
}
#l2d-model-panel .l2d-panel-close {
  border: 0; background: transparent; color: #889; cursor: pointer;
  font: 16px/1 system-ui, sans-serif; padding: 2px 6px; border-radius: 6px;
}
#l2d-model-panel .l2d-panel-close:hover { background: #f0f1f3; color: #334; }
#l2d-model-panel .l2d-panel-current { padding: 0 12px 8px; color: #778; font-size: 12px; overflow-wrap: anywhere; }
#l2d-model-panel .l2d-panel-list {
  flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 6px; padding: 0 8px 8px;
}
.l2d-model-row { display: flex; gap: 6px; align-items: stretch; }
.l2d-model-item {
  flex: 1; min-width: 0; text-align: left; border: 1px solid rgba(0,0,0,.08);
  background: #f7f8fa; border-radius: 8px; padding: 7px 9px; cursor: pointer;
  color: #334; font: inherit;
}
.l2d-model-item:hover { background: #eef3ff; border-color: #9db8ff; }
.l2d-model-row.selected .l2d-model-item { background: #e7f0ff; border-color: #6c96ff; box-shadow: inset 0 0 0 1px #6c96ff; }
.l2d-model-view {
  flex: 0 0 46px; border: 1px solid rgba(0,0,0,.08); border-radius: 8px;
  background: #fff; color: #556; cursor: pointer; font: 12px/1.2 inherit; padding: 4px;
}
.l2d-model-view:hover { background: #f0f4ff; border-color: #9db8ff; }
.l2d-model-del {
  flex: 0 0 30px; border: 1px solid rgba(0,0,0,.08); border-radius: 8px;
  background: #fff; color: #aab; cursor: pointer; font: 15px/1 system-ui, sans-serif; padding: 0;
}
.l2d-model-del:hover { background: #fdf0ee; border-color: #c0392b; color: #c0392b; }
.l2d-model-name { font-weight: 600; }
.l2d-model-path { font-size: 11px; color: #889; overflow-wrap: anywhere; }
.l2d-model-empty { padding: 14px 8px; text-align: center; color: #99a; }
#l2d-model-panel .l2d-panel-status { padding: 4px 12px 8px; color: #778; min-height: 18px; font-size: 12px; }
#l2d-model-panel .l2d-panel-status.error { color: #c0392b; }
#l2d-model-panel .l2d-panel-actions { display: flex; gap: 8px; padding: 0 12px 12px; }
#l2d-model-panel .l2d-panel-actions button {
  flex: 1; padding: 6px 8px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
  background: #fff; color: #445; cursor: pointer; font: inherit;
}
#l2d-model-panel .l2d-panel-actions button:hover:not(:disabled) { background: #f0f4ff; border-color: #9db8ff; }
#l2d-model-panel .l2d-panel-actions button:disabled { opacity: .45; cursor: default; }
#l2d-model-panel .l2d-fps-row {
  display: flex; align-items: center; gap: 8px; padding: 0 12px 12px;
  color: #778; font-size: 12px;
}
#l2d-model-panel .l2d-fps-row select {
  flex: 1; min-width: 0; font: inherit; color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 6px; padding: 3px 6px; background: #fff;
}
#l2d-model-panel .l2d-mode-row {
  display: flex; align-items: center; gap: 8px; padding: 0 12px 12px;
  color: #778; font-size: 12px;
}
#l2d-model-panel .l2d-mode-row select {
  flex: 1; min-width: 0; font: inherit; color: #334;
  border: 1px solid rgba(0,0,0,.12); border-radius: 6px; padding: 3px 6px; background: #fff;
}
#l2d-model-panel .l2d-quit-row { padding: 0 12px 12px; }
#l2d-model-panel .l2d-soft-row { padding: 0 12px 10px; }
#l2d-model-panel .l2d-soft-label { display: flex; align-items: center; gap: 6px; color: #778; font-size: 12px; cursor: pointer; }
#l2d-model-panel .l2d-quit-row button {
  width: 100%; padding: 6px 8px; border: 1px solid rgba(192,57,43,.35); border-radius: 8px;
  background: #fff; color: #c0392b; cursor: pointer; font: inherit; font-size: 12px;
}
#l2d-model-panel .l2d-quit-row button:hover { background: #fdf0ee; }
#l2d-model-panel .l2d-quit-row button.arm { background: #c0392b; color: #fff; }
#l2d-viewer {
  position: fixed; inset: 0; z-index: 100001; display: none; padding: 16px;
  align-items: center; justify-content: center; background: rgba(24,29,40,.55);
}
#l2d-viewer.open { display: flex; }
#l2d-viewer .l2d-viewer-card {
  width: min(520px, 94vw); height: min(620px, 88vh); display: flex; flex-direction: column;
  background: rgba(255,255,255,.97); border-radius: 16px; overflow: hidden;
  box-shadow: 0 18px 60px rgba(0,0,0,.35);
}#l2d-viewer .l2d-viewer-top {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px; border-bottom: 1px solid rgba(0,0,0,.08); font-weight: 600;
}
#l2d-viewer .l2d-viewer-title { overflow-wrap: anywhere; font-size: 13px; color: #334; }
#l2d-viewer .l2d-viewer-close {
  border: 0; background: transparent; color: #889; cursor: pointer;
  font: 16px/1 system-ui, sans-serif; padding: 2px 8px; border-radius: 6px;
}
#l2d-viewer .l2d-viewer-close:hover { background: #f0f1f3; color: #334; }
/* 双栏工作台：左预览右绑定（挂件窄窗退化为上下堆叠） */
#l2d-viewer .l2d-viewer-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
#l2d-viewer .l2d-viewer-stage { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
#l2d-viewer iframe {
  flex: 1; border: 0; background: linear-gradient(180deg, #fafbff 0%, #eef1f8 100%);
}
#l2d-viewer .l2d-binder {
  overflow-y: auto; padding: 10px 12px;
  border-top: 1px solid rgba(0,0,0,.08); background: #fbfcfe;
  font-size: 12px; color: #445; max-height: 40vh;
}
#l2d-viewer .l2d-binder[hidden] { display: none; }
#l2d-viewer .l2d-viewer-states {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px;
  border-bottom: 1px solid rgba(0,0,0,.08);
}
#l2d-viewer .l2d-state-btn {
  padding: 4px 10px; border: 1px solid rgba(0,0,0,.12); border-radius: 999px;
  background: #fff; color: #445; cursor: pointer; font: 12px/1.4 inherit;
}
#l2d-viewer .l2d-state-btn:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-state-btn.active { background: #e7f0ff; border-color: #6c96ff; color: #2b4a8f; }
#l2d-viewer .l2d-binder-toggle {
  border: 1px solid rgba(0,0,0,.12); background: #fff; color: #556; cursor: pointer;
  font: 12px/1.4 inherit; padding: 3px 10px; border-radius: 999px;
}
#l2d-viewer .l2d-binder-toggle:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-binder-toggle.active { background: #e7f0ff; border-color: #6c96ff; color: #2b4a8f; }
#l2d-viewer .l2d-binder-h { font-weight: 600; margin: 6px 0 4px; color: #556; }
#l2d-viewer .l2d-binder-tip { color: #889; margin-bottom: 2px; }
#l2d-viewer .l2d-binder-eslots, #l2d-viewer .l2d-binder-mslots, #l2d-viewer .l2d-binder-gallery {
  display: flex; flex-wrap: wrap; gap: 5px;
}
/* 素材阵列：等宽网格取代参差流式墙 */
#l2d-viewer .l2d-binder-faces, #l2d-viewer .l2d-binder-moves, #l2d-viewer .l2d-binder-pool {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 6px;
}
#l2d-viewer .l2d-chip {
  padding: 3px 9px; border: 1px solid rgba(0,0,0,.12); border-radius: 999px;
  background: #fff; cursor: pointer; font: 12px/1.4 inherit; color: #445;
}
#l2d-viewer .l2d-chip:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-chip.on { background: #e7f0ff; border-color: #6c96ff; color: #2b4a8f; }
#l2d-viewer .l2d-chip .bound { color: #98a2b3; font-size: 10px; margin-left: 4px; }
#l2d-viewer .l2d-mat {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-height: 42px; padding: 4px 6px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
  background: #fff; cursor: pointer; font: 12px/1.35 inherit; color: #334;
  text-align: center; max-width: 100%; overflow-wrap: anywhere;
}
#l2d-viewer .l2d-mat:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-mat.on { background: #e7f0ff; border-color: #6c96ff; box-shadow: inset 0 0 0 1px #6c96ff; }
#l2d-viewer .l2d-mat .badges { display: block; color: #5a9e7a; font-size: 10px; }
#l2d-viewer .l2d-binder-cur { color: #6c96ff; font-weight: 400; }
#l2d-viewer .l2d-binder-current { margin: 4px 0; color: #445; }
#l2d-viewer .l2d-binder-current b { color: #2b4a8f; }
#l2d-viewer .l2d-binder-share { color: #b0792a; margin: 2px 0; }
#l2d-viewer .l2d-binder-actions {
  display: flex; gap: 8px; margin-top: 8px;
  position: sticky; bottom: -10px; padding: 8px 0 6px;
  background: #fbfcfe; border-top: 1px solid rgba(0,0,0,.06);
}
#l2d-viewer .l2d-binder-actions button {
  flex: 1; padding: 5px 8px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
  background: #fff; color: #445; cursor: pointer; font: inherit;
}
#l2d-viewer .l2d-binder-actions button:hover { background: #f0f4ff; border-color: #9db8ff; }
#l2d-viewer .l2d-binder-status { min-height: 16px; margin-top: 4px; color: #778; }
#l2d-viewer .l2d-binder-status.error { color: #c0392b; }

/* ── 卡片拖动：头部即把手 ── */
#l2d-model-panel .l2d-panel-head, #l2d-quips-card .l2d-quips-head, #l2d-help-card .l2d-help-head { cursor: move; user-select: none; }

/* ── 模型面板分页签 ── */
#l2d-model-panel .l2d-panel-tabs {
  display: flex; gap: 4px; margin: 0 12px 8px; padding: 3px;
  background: rgba(0,0,0,.05); border-radius: 9px;
}
#l2d-model-panel .l2d-tab {
  flex: 1; border: 0; border-radius: 7px; padding: 5px 0;
  background: transparent; color: #778; cursor: pointer; font: inherit; font-size: 12.5px;
}
#l2d-model-panel .l2d-tab:hover { color: #445; }
#l2d-model-panel .l2d-tab.on { background: #fff; color: #2b4a8f; font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
#l2d-model-panel .l2d-tabpage { display: flex; flex-direction: column; flex: 1; min-height: 0; }
#l2d-model-panel .l2d-tabpage[hidden] { display: none; }

/* ── 绑定编辑器分区卡 ── */
#l2d-viewer .l2d-binder-sec {
  margin: 8px 0; padding: 8px 10px; border: 1px solid rgba(0,0,0,.07);
  border-radius: 10px; background: #fff;
}
#l2d-viewer .l2d-binder-sec .l2d-binder-h { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 6px; }
#l2d-viewer .l2d-binder-sub { color: #9aa; font-weight: 400; font-size: 11px; }

/* ── roomy：桌宠全屏窗口空间充裕，面板/卡片/菜单整体扩容美化（挂件保持紧凑）── */
body.l2d-roomy #l2d-model-panel {
  width: min(360px, calc(100vw - 16px)); max-height: min(560px, calc(100vh - 16px));
  font-size: 14px; border-radius: 14px;
}
body.l2d-roomy #l2d-model-panel .l2d-panel-head { padding: 14px 16px 8px; font-size: 15px; }
body.l2d-roomy #l2d-model-panel .l2d-panel-tabs { margin: 0 16px 10px; }
body.l2d-roomy #l2d-model-panel .l2d-tab { font-size: 13.5px; padding: 6px 0; }
body.l2d-roomy #l2d-model-panel .l2d-panel-current { padding: 0 16px 10px; font-size: 13px; }
body.l2d-roomy #l2d-model-panel .l2d-panel-list { gap: 8px; padding: 0 12px 10px; }
body.l2d-roomy .l2d-model-item { padding: 10px 12px; border-radius: 10px; }
body.l2d-roomy .l2d-model-path { font-size: 12px; }
body.l2d-roomy .l2d-model-view { flex: 0 0 54px; font-size: 13px; border-radius: 10px; }
body.l2d-roomy .l2d-model-del { flex-basis: 34px; font-size: 16px; border-radius: 10px; }
body.l2d-roomy #l2d-model-panel .l2d-panel-status { padding: 6px 16px 10px; font-size: 13px; }
body.l2d-roomy #l2d-model-panel .l2d-panel-actions { padding: 0 16px 14px; gap: 10px; }
body.l2d-roomy #l2d-model-panel .l2d-panel-actions button { padding: 8px 10px; border-radius: 10px; }
body.l2d-roomy #l2d-model-panel .l2d-fps-row { padding: 0 16px 14px; font-size: 13px; gap: 10px; }
body.l2d-roomy #l2d-model-panel .l2d-fps-row select { padding: 5px 8px; border-radius: 8px; }
body.l2d-roomy #l2d-model-panel .l2d-soft-row { padding: 0 16px 12px; }
body.l2d-roomy #l2d-model-panel .l2d-soft-label { font-size: 13px; gap: 8px; }
body.l2d-roomy #l2d-model-panel .l2d-quit-row { padding: 0 16px 14px; }
body.l2d-roomy #l2d-model-panel .l2d-quit-row button { padding: 8px 10px; font-size: 13px; border-radius: 10px; }
body.l2d-roomy #l2d-pet-menu { min-width: 136px; padding: 6px; font-size: 13.5px; border-radius: 12px; }
body.l2d-roomy #l2d-pet-menu button { padding: 8px 12px; border-radius: 8px; }
body.l2d-roomy #l2d-help-card {
  width: min(330px, calc(100vw - 16px)); font-size: 13.5px; line-height: 1.9;
  padding: 14px 16px; border-radius: 14px;
}
body.l2d-roomy #l2d-help-card .l2d-help-head { font-size: 14.5px; margin-bottom: 4px; }
body.l2d-roomy #l2d-help-card ul { padding-left: 4px; list-style: none; }
body.l2d-roomy #l2d-help-card li { margin: 3px 0; }
body.l2d-roomy #l2d-quips-card {
  width: min(430px, calc(100vw - 16px)); font-size: 13.5px;
  padding: 14px 16px; border-radius: 14px;
}
body.l2d-roomy #l2d-quips-card .l2d-quips-head { font-size: 14.5px; margin-bottom: 10px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-row { gap: 10px; margin-bottom: 10px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-pool, body.l2d-roomy #l2d-quips-card .l2d-quips-preset { height: 32px; font-size: 13.5px; border-radius: 8px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-text { min-height: 230px; font-size: 13px; padding: 8px 10px; border-radius: 10px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-save { padding: 7px 22px; font-size: 13.5px; border-radius: 10px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-saveas, body.l2d-roomy #l2d-quips-card .l2d-quips-nameok,
body.l2d-roomy #l2d-quips-card .l2d-quips-namecancel { padding: 5px 12px; font-size: 13px; border-radius: 8px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-name { height: 32px; font-size: 13.5px; border-radius: 8px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-reset, body.l2d-roomy #l2d-quips-card .l2d-quips-del { padding: 6px 14px; font-size: 13px; border-radius: 10px; }
body.l2d-roomy #l2d-quips-card .l2d-quips-foot { margin-top: 10px; }

/* roomy 预览工作台：大卡双栏，绑定编辑侧栏化 */
body.l2d-roomy #l2d-viewer .l2d-viewer-card { width: min(1120px, 94vw); height: min(800px, 92vh); }
body.l2d-roomy #l2d-viewer .l2d-viewer-body { flex-direction: row; }
body.l2d-roomy #l2d-viewer .l2d-binder {
  flex: 0 0 440px; max-height: none;
  border-top: 0; border-left: 1px solid rgba(0,0,0,.08);
  font-size: 13px; padding: 14px 16px;
}
body.l2d-roomy #l2d-viewer .l2d-binder-actions { bottom: -14px; padding: 10px 0 8px; }
body.l2d-roomy #l2d-viewer .l2d-binder-faces, body.l2d-roomy #l2d-viewer .l2d-binder-moves,
body.l2d-roomy #l2d-viewer .l2d-binder-pool { grid-template-columns: repeat(auto-fill, minmax(122px, 1fr)); gap: 8px; }
body.l2d-roomy #l2d-viewer .l2d-mat { min-height: 48px; font-size: 12.5px; }
body.l2d-roomy #l2d-viewer .l2d-binder-tip { font-size: 12.5px; line-height: 1.7; }
body.l2d-roomy #l2d-viewer .l2d-binder-current { font-size: 13px; margin: 8px 0; }
body.l2d-roomy #l2d-viewer .l2d-binder-sec { padding: 10px 12px; margin: 10px 0; }
body.l2d-roomy #l2d-viewer .l2d-viewer-states { padding: 10px 14px; gap: 8px; }
body.l2d-roomy #l2d-viewer .l2d-state-btn { padding: 6px 14px; font-size: 13px; }
`
  document.head.appendChild(style)
  document.body.classList.add('l2d-roomy')   // 全端统一扩容排版：查看器/卡片均为全视口浮层，空间同样充裕

  // ── 悬浮入口：挂件/桌宠右上角，静置自动隐藏。图标全 emoji 统一风格 ──
  const toggle = document.createElement('button')
  toggle.id = 'l2d-model-toggle'
  toggle.type = 'button'
  toggle.title = '设置'
  toggle.setAttribute('aria-label', '设置')
  toggle.textContent = '⚙️'
  toggle.addEventListener('pointerdown', (e) => e.stopPropagation())
  toggle.addEventListener('pointerup', (e) => e.stopPropagation())
  toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu() })
  toggle.addEventListener('dblclick', (e) => e.stopPropagation())
  toggle.addEventListener('wheel', (e) => e.stopPropagation())
  ctx.box.appendChild(toggle)

  // ── 游戏钮：⚙ 左边的独立功能入口，直达对局卡 ──
  const gameToggle = document.createElement('button')
  gameToggle.id = 'l2d-game-toggle'
  gameToggle.type = 'button'
  gameToggle.title = '五子棋对局'
  gameToggle.setAttribute('aria-label', '五子棋对局')
  gameToggle.textContent = '🎮'
  gameToggle.addEventListener('pointerdown', (e) => e.stopPropagation())
  gameToggle.addEventListener('pointerup', (e) => e.stopPropagation())
  // 桌宠模式：对局卡走独立卫星窗（焦点/穿透与全屏 overlay 物理隔离）；网页挂件照旧页内浮卡
  gameToggle.addEventListener('click', (e) => { e.stopPropagation(); if (BRIDGE) BRIDGE.openGame?.(); else ctx.openGame?.() })
  gameToggle.addEventListener('dblclick', (e) => e.stopPropagation())
  gameToggle.addEventListener('wheel', (e) => e.stopPropagation())
  ctx.box.appendChild(gameToggle)

  // ── 穿透钮：⚙ 左边的独立开关。平时自动（路过穿透、停留即互动），
  // 按下=强制穿透（模型不响应鼠标，UI 保留可点），再按恢复自动。
  // 图标即实时状态：绿底🔒=自动穿透中 / 白底🔓=已解锁可互动 / 蓝底🔒=手动锁定 ──
  const pinToggle = document.createElement('button')
  pinToggle.id = 'l2d-pin-toggle'
  pinToggle.type = 'button'
  pinToggle.title = '锁定后不响应鼠标（平时自动——路过不打扰，停留片刻即可互动）'
  pinToggle.setAttribute('aria-label', '穿透锁定')
  const syncPinBtn = () => {
    const unlocked = !ctx.pinned && ctx.lastIgnore === false
    pinToggle.classList.toggle('on', !!ctx.pinned)
    pinToggle.classList.toggle('auto', !ctx.pinned && !unlocked)
    pinToggle.textContent = unlocked ? '🔓' : '🔒'
  }
  ctx.syncPinBtn = syncPinBtn   // interact 的穿透状态迁移会回调这里
  pinToggle.addEventListener('pointerdown', (e) => e.stopPropagation())
  pinToggle.addEventListener('pointerup', (e) => e.stopPropagation())
  pinToggle.addEventListener('click', (e) => {
    e.stopPropagation()
    ctx.pinned = !ctx.pinned
    store.setPinned(ctx.pinned)
    ctx.evalIgnore?.()
    syncPinBtn()
    if (ctx.pinned) pinToggle.classList.remove('l2d-hidden')   // 锁定时必须现身——它是「不响应」的常驻告示
    scheduleHide()
    ctx.showBubble?.(ctx.pinned ? '锁定：咱不挡路啦' : '解锁：恢复自动', 1800, 2)
  })
  pinToggle.addEventListener('dblclick', (e) => e.stopPropagation())
  pinToggle.addEventListener('wheel', (e) => e.stopPropagation())
  if (!BRIDGE) {   // 网页挂件无穿透概念，藏钮
    pinToggle.style.display = 'none'
    document.body.classList.add('l2d-no-pin')   // 问号顶到锁位（见 CSS）
  }
  ctx.box.appendChild(pinToggle)
  syncPinBtn()

  // ── 帮助钮：独立 ? 图标，点开大白话操作引导 ──
  const helpToggle = document.createElement('button')
  helpToggle.id = 'l2d-help-toggle'
  helpToggle.type = 'button'
  helpToggle.title = '基本操作'
  helpToggle.setAttribute('aria-label', '基本操作')
  helpToggle.textContent = '❓'
  helpToggle.addEventListener('pointerdown', (e) => e.stopPropagation())
  helpToggle.addEventListener('pointerup', (e) => e.stopPropagation())
  helpToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp() })
  helpToggle.addEventListener('dblclick', (e) => e.stopPropagation())
  helpToggle.addEventListener('wheel', (e) => e.stopPropagation())
  ctx.box.appendChild(helpToggle)

  // ── 设置菜单：单 ⚙ 向下展开，合并「切换模型 / 台词编辑 / 基本操作」三入口 ──
  const menu = document.createElement('div')
  menu.id = 'l2d-pet-menu'
  menu.innerHTML = `
    <button type="button" data-act="panel">切换模型</button>
    <button type="button" data-act="quips">台词编辑</button>`
  menu.addEventListener('pointerdown', (e) => e.stopPropagation())
  menu.addEventListener('pointerup', (e) => e.stopPropagation())
  menu.addEventListener('wheel', (e) => e.stopPropagation())
  document.body.appendChild(menu)
  let menuOpen = false
  function positionMenu() {
    const rect = toggle.getBoundingClientRect()
    const w = menu.offsetWidth || 112
    const left = Math.min(Math.max(rect.right - w, 8), Math.max(8, window.innerWidth - w - 8))
    let top = rect.bottom + 6
    if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 6)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
  }
  function toggleMenu(show) {
    menuOpen = show ?? !menuOpen
    menu.classList.toggle('open', menuOpen)
    if (menuOpen) { showToggle(); positionMenu() }
    else scheduleHide()
    ctx.evalIgnore?.()
  }
  menu.querySelector('[data-act="panel"]').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(false); togglePanel() })
  menu.querySelector('[data-act="quips"]').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(false); toggleQuips() })
  // 外点关闭（拖拽起点在 box 上，冒泡到 window 即触发收拢）
  window.addEventListener('pointerdown', (e) => {
    if (menuOpen && !menu.contains(e.target) && e.target !== toggle) toggleMenu(false)
  })

  const helpCard = document.createElement('section')
  helpCard.id = 'l2d-help-card'
  helpCard.innerHTML = `
<div class="l2d-help-head"><span>怎么和咱相处</span><button class="l2d-help-close" type="button" title="关闭">×</button></div>
<ul>
  <li>👆 <b>点一下</b>：随机动作，偶尔吐槽你一句</li>
  <li>👆👆 <b>快速双击</b>：开心卖萌</li>
  <li>🫳 <b>摸摸头顶</b>：会害羞</li>
  <li>✋ <b>按住拖动</b>：带咱搬家，松手就站定</li>
  <li>🔍 <b>Ctrl + 滚轮</b>：放大缩小</li>
  <li>🖱 <b>鼠标扫过</b>：默认不挡路——看剧路过不会黑屏；想互动，在咱身上停半秒就好</li>
  <li>🔒 <b>锁头按钮</b>：绿圈呼吸=自动不挡路中；点一下蓝圈呼吸=彻底不响应鼠标；再点恢复</li>
  <li>⚙ <b>齿轮</b>：换模型、改台词；面板里还有帧率 / CPU渲染 / 退出</li>
  <li>💡 <b>左上小灯</b>：AI 正在干嘛；多任务会分列小灯</li>
</ul>`
  document.body.appendChild(helpCard)
  helpCard.querySelector('.l2d-help-close').addEventListener('click', () => toggleHelp(false))

  let helpOpen = false
  function positionHelp() {
    if (helpPlaced) return
    const rect = toggle.getBoundingClientRect()
    const w = helpCard.offsetWidth || 250
    const left = Math.min(Math.max(rect.right - w, 8), Math.max(8, window.innerWidth - w - 8))
    let top = rect.bottom + 8
    if (top + helpCard.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - helpCard.offsetHeight - 8)
    helpCard.style.left = left + 'px'
    helpCard.style.top = top + 'px'
  }
  function toggleHelp(show) {
    helpOpen = show ?? !helpOpen
    if (!helpOpen) helpPlaced = false   // 重开恢复锚定
    helpCard.classList.toggle('open', helpOpen)
    if (helpOpen) { showToggle(); positionHelp() }
    else scheduleHide()
    ctx.evalIgnore?.()
  }

  // ── 台词池编辑器：齿轮与 ? 之间的「词」入口；草稿机制（切池不丢），保存即热生效 ──
  const QUIP_POOL_LABELS = {
    thinking: '思考', working: '工作', done: '完成', waiting: '等待确认', error: '报错',
    overtime: '加班中', sleeping: '睡眠', idle: '闲置碎碎念', busy: '忙中回应',
    click: '点击反应', pat: '摸头', drag: '拖拽', greet: '见面问候',
    greet_morning: '早安问候', greet_night: '深夜问候',
  }
  // ── 桌宠 UI 跟随：桌宠窗铺满全屏（overlay），🔒/❓/⚙️/🎮 按钮锚定模型右侧。
  // 独立聊天按钮占用同列第 5 格，因此整列按 5×40px 钳制，靠近屏幕底边也不会相互重叠。──
  if (BRIDGE) {
    toggle.style.right = 'auto'
    gameToggle.style.right = 'auto'
    pinToggle.style.right = 'auto'
    helpToggle.style.right = 'auto'
    let fx = null
    let fy = null
    const followButtons = () => {
      const b = ctx.modelBounds?.()
      if (b && b.width > 0) {
        const tx = Math.min(Math.max(b.x + b.width + 8, 6), Math.max(6, window.innerWidth - 42))
        // 竖列 5×40px（🔒❓⚙️🎮💬 自上而下）：锚点钳制保证整列不出底边
        const ty = Math.min(Math.max(b.y + 4, 6), Math.max(6, window.innerHeight - 216))
        if (fx === null) { fx = tx; fy = ty }
        fx += (tx - fx) * 0.3
        fy += (ty - fy) * 0.3
        pinToggle.style.left = Math.round(fx) + 'px'
        pinToggle.style.top = Math.round(fy) + 'px'
        helpToggle.style.left = Math.round(fx) + 'px'
        helpToggle.style.top = Math.round(fy + 40) + 'px'
        toggle.style.left = Math.round(fx) + 'px'
        toggle.style.top = Math.round(fy + 80) + 'px'
        gameToggle.style.left = Math.round(fx) + 'px'
        gameToggle.style.top = Math.round(fy + 120) + 'px'
      }
      requestAnimationFrame(followButtons)
    }
    requestAnimationFrame(followButtons)
  }

  const quipsCard = document.createElement('section')
  quipsCard.id = 'l2d-quips-card'
  quipsCard.innerHTML = `
<div class="l2d-quips-head"><span>台词池编辑器</span><button class="l2d-quips-close" type="button" title="关闭">×</button></div>
<div class="l2d-quips-row">
  <select class="l2d-quips-preset" title="台词预设：官方默认不可写，编辑请另存为"></select>
  <button class="l2d-quips-saveas" type="button" title="把当前内容另存为新预设">另存为</button>
  <button class="l2d-quips-del" type="button" title="删除当前预设">删除</button>
</div>
<div class="l2d-quips-row l2d-quips-namerow" hidden>
  <input class="l2d-quips-name" type="text" maxlength="64" placeholder="新预设名称（如：Nori人设）">
  <button class="l2d-quips-nameok" type="button">确定</button>
  <button class="l2d-quips-namecancel" type="button">取消</button>
</div>
<div class="l2d-quips-row">
  <select class="l2d-quips-pool"></select>
  <span class="l2d-quips-count"></span>
  <button class="l2d-quips-reset" type="button" title="此池恢复跟随官方默认">恢复默认</button>
</div>
<textarea class="l2d-quips-text" spellcheck="false" placeholder="每行一句台词，随机抽取"></textarea>
<div class="l2d-quips-foot"><span class="l2d-quips-status"></span><button class="l2d-quips-save" type="button">保存</button></div>`
  document.body.appendChild(quipsCard)
  quipsCard.querySelector('.l2d-quips-close').addEventListener('click', () => toggleQuips(false))
  const quipsPresetEl = quipsCard.querySelector('.l2d-quips-preset')
  const quipsPoolEl = quipsCard.querySelector('.l2d-quips-pool')
  const quipsTextEl = quipsCard.querySelector('.l2d-quips-text')
  const quipsStatusEl = quipsCard.querySelector('.l2d-quips-status')
  const quipsCountEl = quipsCard.querySelector('.l2d-quips-count')
  const quipsResetBtn = quipsCard.querySelector('.l2d-quips-reset')
  const quipsDelBtn = quipsCard.querySelector('.l2d-quips-del')
  let quipsOpen = false
  let quipsDefaultRaw = null       // 官方默认文件（只读参照，永不写）
  let quipsPresetRaw = null        // 当前预设文件内容（null=官方默认视图）
  let quipsActive = null           // 生效预设名（null=官方默认）
  let quipsDraft = {}              // {池名: [行…]} 未保存修改
  let quipsPool = 'thinking'

  const effectivePools = () => ({ ...(quipsDefaultRaw?.pools ?? {}), ...(quipsPresetRaw?.pools ?? {}) })
  const poolDiffersFromDefault = (k) => {
    const cur = quipsPresetRaw?.pools?.[k]
    if (cur === undefined) return false
    return JSON.stringify(cur) !== JSON.stringify(quipsDefaultRaw?.pools?.[k])
  }

  function setQuipsStatus(text, isError = false) {
    quipsStatusEl.textContent = text
    quipsStatusEl.classList.toggle('error', isError)
  }
  function buildQuipsOptions() {
    const pools = effectivePools()
    const keys = [
      ...Object.keys(QUIP_POOL_LABELS).filter((k) => k in pools),
      ...Object.keys(pools).filter((k) => !(k in QUIP_POOL_LABELS)),
    ]
    quipsPoolEl.replaceChildren(...keys.map((k) => {
      const label = QUIP_POOL_LABELS[k] ? `${QUIP_POOL_LABELS[k]}（${k}）` : k
      return new Option(poolDiffersFromDefault(k) ? `${label} ·自定义` : label, k)
    }))
    if (!keys.includes(quipsPool)) quipsPool = keys[0] ?? 'thinking'
    quipsPoolEl.value = quipsPool
  }
  function renderQuipsPool() {
    const lines = quipsDraft[quipsPool] ?? effectivePools()[quipsPool] ?? []
    quipsTextEl.value = lines.join('\n')
    quipsCountEl.textContent = `${lines.length} 句`
    quipsResetBtn.disabled = !poolDiffersFromDefault(quipsPool)
    quipsDelBtn.disabled = quipsActive === null
    const dirty = Object.keys(quipsDraft).length
    setQuipsStatus(dirty > 0 ? `${dirty} 个池未保存` : '')
  }
  quipsTextEl.addEventListener('input', () => {
    const lines = quipsTextEl.value.split('\n').map((s) => s.trim()).filter(Boolean)
    const base = effectivePools()[quipsPool] ?? []
    const same = lines.length === base.length && lines.every((s, i) => s === base[i])
    if (same) delete quipsDraft[quipsPool]
    else quipsDraft[quipsPool] = lines
    quipsCountEl.textContent = `${lines.length} 句`
    const dirty = Object.keys(quipsDraft).length
    setQuipsStatus(dirty > 0 ? `${dirty} 个池未保存` : '')
  })
  quipsPoolEl.addEventListener('change', () => { quipsPool = quipsPoolEl.value; renderQuipsPool() })

  function positionQuips() {
    if (quipsPlaced) return
    const rect = toggle.getBoundingClientRect()
    const w = quipsCard.offsetWidth || 300
    const left = Math.min(Math.max(rect.right - w, 8), Math.max(8, window.innerWidth - w - 8))
    let top = rect.bottom + 8
    if (top + quipsCard.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - quipsCard.offsetHeight - 8)
    quipsCard.style.left = left + 'px'
    quipsCard.style.top = top + 'px'
  }
  async function postQuips(payload) {
    const res = await fetch(BASE + '/quips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(await res.text())
  }
  async function loadPresetRaw(name) {
    if (name === null) return null
    try {
      const r = await fetch(BASE + '/quips-presets/' + encodeURIComponent(name) + '.json', { cache: 'no-store' })
      const raw = r.ok ? await r.json() : null
      return raw && typeof raw === 'object' && raw.pools ? raw : null
    } catch { return null }
  }
  async function openQuips() {
    setQuipsStatus('读取中…')
    try {
      const [raw, cfgRes] = await Promise.all([
        (await fetch(BASE + '/quips.json', { cache: 'no-store' })).json(),
        // quips-config 路由不可用时优雅降级为纯官方视图（老宿主/独立服）
        fetch(BASE + '/quips-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])
      quipsDefaultRaw = raw
      quipsActive = typeof cfgRes?.active === 'string' ? cfgRes.active : null
      const presets = Array.isArray(cfgRes?.presets) ? cfgRes.presets : []
      quipsPresetEl.replaceChildren(
        new Option('官方默认', ''),
        ...presets.map((p) => new Option(p, p)),
      )
      quipsPresetEl.value = quipsActive ?? ''
      quipsPresetRaw = await loadPresetRaw(quipsActive)
    } catch {
      setQuipsStatus('读取失败', true)
      return
    }
    quipsDraft = {}
    buildQuipsOptions()
    renderQuipsPool()
  }
  function toggleQuips(show) {
    quipsOpen = show ?? !quipsOpen
    if (!quipsOpen) quipsPlaced = false   // 重开恢复锚定
    quipsCard.classList.toggle('open', quipsOpen)
    if (quipsOpen) { showToggle(); positionQuips(); void openQuips() }
    else scheduleHide()
    ctx.evalIgnore?.()
  }
  // 切换生效预设（含回官方默认）：指针写盘 + 热重载 + 刷新视图
  quipsPresetEl.addEventListener('change', async () => {
    const name = quipsPresetEl.value === '' ? null : quipsPresetEl.value
    try {
      await postQuips({ activate: name })
      quipsActive = name
      quipsPresetRaw = await loadPresetRaw(name)
      quipsDraft = {}
      await loadQuips()
      buildQuipsOptions()
      renderQuipsPool()
      setQuipsStatus(name === null ? '已切回官方默认' : `已切换到「${name}」`)
    } catch {
      setQuipsStatus('切换失败', true)
    }
  })
  // 保存：预设=全量快照（人设自包含）；官方默认视图下保存自动转另存为。
  // Electron 不支持 window.prompt——命名走卡片内联输入行。
  const quipsNameRow = quipsCard.querySelector('.l2d-quips-namerow')
  const quipsPresetRow = quipsNameRow.previousElementSibling
  const quipsNameInput = quipsCard.querySelector('.l2d-quips-name')
  function showNameRow(show, prefill = '') {
    quipsNameRow.hidden = !show
    quipsPresetRow.hidden = show
    if (show) { quipsNameInput.value = prefill; quipsNameInput.focus() }
  }
  async function doSavePreset(name) {
    const pools = { ...effectivePools(), ...quipsDraft }
    setQuipsStatus('保存中…')
    try {
      await postQuips({ save: name, data: { ...(quipsPresetRaw ?? {}), pools } })
      quipsActive = name
      quipsPresetRaw = await loadPresetRaw(name)
      quipsDraft = {}
      await loadQuips()
      // 预设下拉可能新增了一项，重建
      const cfgRes = await fetch(BASE + '/quips-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      const presets = Array.isArray(cfgRes?.presets) ? cfgRes.presets : [name]
      quipsPresetEl.replaceChildren(new Option('官方默认', ''), ...presets.map((p) => new Option(p, p)))
      quipsPresetEl.value = name
      buildQuipsOptions()
      renderQuipsPool()
      setQuipsStatus(`已保存到「${name}」并生效`)
      ctx.showBubble?.('台词更新好啦~', 2500, 2)
    } catch {
      setQuipsStatus('保存失败，请重试', true)
    }
  }
  function saveQuipsPreset(forceNewName) {
    const pools = { ...effectivePools(), ...quipsDraft }
    for (const [k, v] of Object.entries(pools)) {
      if (v.length === 0) {
        setQuipsStatus(`「${QUIP_POOL_LABELS[k] ?? k}」至少保留一句`, true)
        return
      }
    }
    if (forceNewName || quipsActive === null) {
      showNameRow(true, quipsActive ?? '')
      return
    }
    void doSavePreset(quipsActive)
  }
  quipsCard.querySelector('.l2d-quips-nameok').addEventListener('click', () => {
    const name = quipsNameInput.value.trim()
    if (!name) { setQuipsStatus('预设名不能为空', true); return }
    showNameRow(false)
    void doSavePreset(name)
  })
  quipsCard.querySelector('.l2d-quips-namecancel').addEventListener('click', () => showNameRow(false))
  quipsNameInput.addEventListener('keydown', (e) => {
    e.stopPropagation()   // 阻止 document 级 Esc 把面板也一起关掉
    if (e.key === 'Enter') quipsCard.querySelector('.l2d-quips-nameok').click()
    if (e.key === 'Escape') showNameRow(false)
  })
  quipsCard.querySelector('.l2d-quips-save').addEventListener('click', () => saveQuipsPreset(false))
  quipsCard.querySelector('.l2d-quips-saveas').addEventListener('click', () => saveQuipsPreset(true))
  // 此池恢复默认：从预设快照中删掉该池，回落官方
  quipsResetBtn.addEventListener('click', async () => {
    if (quipsActive === null || !poolDiffersFromDefault(quipsPool)) return
    const pools = { ...effectivePools(), ...quipsDraft }
    delete pools[quipsPool]
    delete quipsDraft[quipsPool]
    setQuipsStatus('保存中…')
    try {
      await postQuips({ save: quipsActive, data: { ...(quipsPresetRaw ?? {}), pools } })
      quipsPresetRaw = await loadPresetRaw(quipsActive)
      await loadQuips()
      buildQuipsOptions()
      renderQuipsPool()
      setQuipsStatus('此池已恢复官方默认')
    } catch {
      setQuipsStatus('操作失败', true)
    }
  })
  // 删除当前预设：文件删除 + 指针回官方 + 热重载
  quipsDelBtn.addEventListener('click', async () => {
    if (quipsActive === null) return
    if (!window.confirm(`删除预设「${quipsActive}」？此操作不可撤销。`)) return
    try {
      await postQuips({ delete: quipsActive })
      quipsActive = null
      quipsPresetRaw = null
      quipsDraft = {}
      await loadQuips()
      await openQuips()
      setQuipsStatus('已删除，回官方默认')
    } catch {
      setQuipsStatus('删除失败', true)
    }
  })

  const panel = document.createElement('section')
  panel.id = 'l2d-model-panel'
  panel.innerHTML = `
<div class="l2d-panel-head">
  <span>Live2D 模型</span>
  <button class="l2d-panel-close" type="button" title="关闭">×</button>
</div>
<div class="l2d-panel-tabs">
  <button type="button" class="l2d-tab on" data-tab="models">模型</button>
  <button type="button" class="l2d-tab" data-tab="prefs">设置</button>
</div>
<div class="l2d-tabpage" data-page="models">
  <div class="l2d-panel-current">当前：<span class="l2d-current-path"></span></div>
  <div class="l2d-panel-list"></div>
  <div class="l2d-panel-status"></div>
  <div class="l2d-panel-actions">
    <button type="button" class="l2d-reset">恢复默认</button>
    <button type="button" class="l2d-refresh">刷新列表</button>
    <button type="button" class="l2d-import">导入模型</button>
  </div>
</div>
<div class="l2d-tabpage" data-page="prefs" hidden>
  <div class="l2d-fps-row">
    <span>帧率</span>
    <select class="l2d-fps-select" title="渲染帧率预设（常态/睡眠/离线三档联动）">
      <option value="full">满血（60/30/12 fps）</option>
      <option value="balanced">均衡（30/12/6 fps，默认）</option>
      <option value="saver">省电（15/8/4 fps）</option>
    </select>
  </div>
  <div class="l2d-mode-row">
    <span>显示模式</span>
    <select class="l2d-mode-select" title="桌宠/网页挂件形态切换：补丁层热重载即时生效；挂件变化需刷新 DSH 页面（Ctrl+F5）">
      <option value="both">桌宠 + 挂件</option>
      <option value="pet">仅桌宠</option>
      <option value="widget">仅网页挂件</option>
    </select>
  </div>
  <div class="l2d-soft-row" hidden>
    <label class="l2d-soft-label" title="默认 GPU 渲染；拖动闪烁的机器开启后改走 CPU，切换后桌宠自动重启生效">
      <input type="checkbox" class="l2d-soft"> CPU 渲染模式（拖动闪烁时开启，切换后自动重启生效）
    </label>
  </div>
  <div class="l2d-quit-row" hidden>
    <button type="button" class="l2d-quit">退出桌宠</button>
  </div>
</div>`
  document.body.appendChild(panel)
  // 分页签切换
  panel.querySelectorAll('.l2d-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.l2d-tab').forEach((t) => t.classList.toggle('on', t === tab))
      panel.querySelectorAll('.l2d-tabpage').forEach((p) => { p.hidden = p.dataset.page !== tab.dataset.tab })
    })
  })

  const viewer = document.createElement('div')
  viewer.id = 'l2d-viewer'
  viewer.innerHTML = `
<div class="l2d-viewer-card">
  <div class="l2d-viewer-top">
    <span class="l2d-viewer-title"></span>
    <button class="l2d-binder-toggle" type="button" title="可视化绑定编辑">绑定</button>
    <button class="l2d-viewer-close" type="button" title="关闭">×</button>
  </div>
  <div class="l2d-viewer-body">
    <div class="l2d-viewer-stage">
      <div class="l2d-viewer-states"></div>
      <iframe title="Live2D 模型预览"></iframe>
    </div>
    <div class="l2d-binder" hidden>
      <div class="l2d-binder-tip">用法：先点状态按钮（工作/闲置…）选择要配谁，再点分区里的素材直接换上——预览里立刻出效果，满意了点「保存绑定」。改坏了也不怕，「恢复自动嗅探」一键还原</div>
      <div class="l2d-binder-current">正在给【<b class="l2d-binder-state"></b>】配表现：　脸 <span class="l2d-binder-face"></span>　动作 <span class="l2d-binder-move"></span></div>
      <div class="l2d-binder-share" hidden></div>
      <div class="l2d-binder-sec">
        <div class="l2d-binder-h">脸<span class="l2d-binder-sub">点一个立刻换上</span></div>
        <div class="l2d-binder-faces"></div>
      </div>
      <div class="l2d-binder-sec">
        <div class="l2d-binder-h">动作<span class="l2d-binder-sub">点一个立刻换上</span></div>
        <div class="l2d-binder-moves"></div>
      </div>
      <div class="l2d-binder-sec">
        <div class="l2d-binder-h">点击池<span class="l2d-binder-sub">点小人时随机播这些，可多选</span></div>
        <div class="l2d-binder-pool"></div>
      </div>
      <div class="l2d-binder-actions">
        <button type="button" class="l2d-binder-save">保存绑定</button>
        <button type="button" class="l2d-binder-reset">恢复自动嗅探</button>
      </div>
      <div class="l2d-binder-status"></div>
    </div>
  </div>
</div>`
  document.body.appendChild(viewer)

  const importInput = document.createElement('input')
  importInput.type = 'file'
  importInput.multiple = true
  importInput.webkitdirectory = true
  importInput.style.display = 'none'
  document.body.appendChild(importInput)

  const closeBtn = panel.querySelector('.l2d-panel-close')
  const currentPathEl = panel.querySelector('.l2d-current-path')
  const listEl = panel.querySelector('.l2d-panel-list')
  const statusEl = panel.querySelector('.l2d-panel-status')
  const resetBtn = panel.querySelector('.l2d-reset')
  const refreshBtn = panel.querySelector('.l2d-refresh')
  const importBtn = panel.querySelector('.l2d-import')
  const fpsSelect = panel.querySelector('.l2d-fps-select')

  // 帧率预设：初始化跟随持久化值，切换立即生效并给气泡反馈
  if (fpsSelect && ctx.setFpsMode) {
    fpsSelect.value = ctx.fpsMode ?? 'balanced'
    fpsSelect.addEventListener('change', () => {
      ctx.setFpsMode(fpsSelect.value)
      const label = fpsSelect.selectedOptions[0]?.textContent ?? fpsSelect.value
      ctx.showBubble?.(`帧率已切换：${label}`, 1800, 2)
    })
  }

  // 显示模式：读宿主 config 回填；切换写 cordis.patch.yml 触发补丁层热重载。
  // 桌宠增减随重挂载自动发生；挂件注入变化要等主人刷新 DSH 页面才可见。
  const modeSelect = panel.querySelector('.l2d-mode-select')
  if (STANDALONE) panel.querySelector('.l2d-mode-row').hidden = true
  async function refreshMode() {
    if (STANDALONE) return
    try {
      const r = await fetch(BASE + '/config', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (r.ok) modeSelect.value = d.pet && d.widget ? 'both' : d.pet ? 'pet' : 'widget'
    } catch { }
  }
  modeSelect.addEventListener('change', async () => {
    if (STANDALONE) return
    const mode = modeSelect.value
    setStatus('正在切换显示模式…')
    try {
      const r = await fetch(BASE + '/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
      setStatus('已切换，热重载生效中' + (mode !== 'pet' ? '；挂件变化需刷新 DSH 页面（Ctrl+F5）' : ''))
    } catch (error) {
      setStatus('切换失败：' + error.message, true)
      void refreshMode()
    }
  })

  // 退出桌宠：仅桌宠形态显示；双击确认防误触，道别后再退场
  const quitRow = panel.querySelector('.l2d-quit-row')
  const quitBtn = panel.querySelector('.l2d-quit')
  // 软渲染开关：仅桌宠形态显示；勾选状态来自持久化配置，切换写盘后自动重启
  const softRow = panel.querySelector('.l2d-soft-row')
  const softCheck = panel.querySelector('.l2d-soft')
  if (softRow && softCheck && BRIDGE?.getSoft) {
    softRow.hidden = false
    BRIDGE.getSoft().then((v) => { softCheck.checked = !!v }).catch(() => { })
    softCheck.addEventListener('change', () => {
      ctx.showBubble?.(softCheck.checked ? '切换 CPU 渲染，咱马上回来…' : '切回 GPU 渲染，咱马上回来…', 1500, 2)
      setTimeout(() => BRIDGE.setSoft(softCheck.checked), 800)
    })
  }
  if (quitRow && quitBtn && BRIDGE) {
    quitRow.hidden = false
    let armedAt = 0
    quitBtn.addEventListener('click', () => {
      const now = Date.now()
      if (armedAt !== 0 && now - armedAt < 3000) {
        ctx.showBubble?.('晚安主人，咱先退下啦…', 1500, 2)
        setTimeout(() => BRIDGE.quit(), 900)
        return
      }
      armedAt = now
      quitBtn.classList.add('arm')
      quitBtn.textContent = '再点一次确认退出'
      setTimeout(() => {
        if (armedAt === now) {
          armedAt = 0
          quitBtn.classList.remove('arm')
          quitBtn.textContent = '退出桌宠'
        }
      }, 3000)
    })
  }
  const viewerTitle = viewer.querySelector('.l2d-viewer-title')
  const viewerFrame = viewer.querySelector('iframe')
  const viewerClose = viewer.querySelector('.l2d-viewer-close')
  const statesBar = viewer.querySelector('.l2d-viewer-states')

  // 预览状态按钮栏：点什么状态看什么表现（iframe 为隔离预览实例，不接 SSE）
  for (const [state, label] of [
    ['idle', '闲置'], ['thinking', '思考'], ['working', '工作'], ['waiting', '等待'],
    ['error', '出错'], ['done', '完成'], ['sleeping', '睡眠'], ['offline', '离线'],
  ]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'l2d-state-btn'
    btn.dataset.state = state
    btn.textContent = label
    btn.addEventListener('click', () => {
      statesBar.querySelectorAll('.l2d-state-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      sendViewerState(state)
      // 绑定编辑器打开时，状态按钮同时充当「编辑目标」选择器
      if (!binderEl.hidden && binderDraft) { binderState = state; renderBinder() }
    })
    statesBar.appendChild(btn)
  }

  /**
   * iframe 就绪重试包装：同源取 contentWindow.__l2d。
   * 预览页冷启动（模块图 + PIXI + 模型 + 着色器编译）在低配机上可达 15 秒级，
   * 故重试窗口放宽到约 24 秒，避免开机窗口期内的点击被丢弃。
   * @param {(api:Object)=>void} cb 拿到预览 api 后执行
   */
  function withViewerApi(cb) {
    let tries = 0
    const attempt = () => {
      if (!viewer.classList.contains('open')) return // 弹窗已关，停止空转
      const api = viewerFrame.contentWindow?.__l2d
      if (api) { cb(api); return }
      if (++tries < 80) setTimeout(attempt, 300)
    }
    attempt()
  }

  /** 向预览 iframe 下达状态切换。 */
  function sendViewerState(state) {
    withViewerApi(api => api.enter(state))
  }

  // ── 绑定编辑器：状态直通（点状态选目标 → 点素材试穿换绑），保存写 profile.json ──

  const binderEl = viewer.querySelector('.l2d-binder')
  const binderToggle = viewer.querySelector('.l2d-binder-toggle')
  const binderStateEl = viewer.querySelector('.l2d-binder-state')
  const binderFaceEl = viewer.querySelector('.l2d-binder-face')
  const binderMoveEl = viewer.querySelector('.l2d-binder-move')
  const binderShareEl = viewer.querySelector('.l2d-binder-share')
  const binderFacesEl = viewer.querySelector('.l2d-binder-faces')
  const binderMovesEl = viewer.querySelector('.l2d-binder-moves')
  const binderPoolEl = viewer.querySelector('.l2d-binder-pool')
  const binderSaveBtn = viewer.querySelector('.l2d-binder-save')
  const binderResetBtn = viewer.querySelector('.l2d-binder-reset')
  const binderStatus = viewer.querySelector('.l2d-binder-status')

  /** 状态 → 绑定槽位映射 + 中文名（与预览状态栏一一对应；null = 该状态无动作位）。
   *  注意「思考」与「等待」共用 doubt 脸槽——UI 上会对共享给出提示。 */
  const STATE_DEF_UI = [
    ['idle', '闲置', 'default', null],
    ['thinking', '思考', 'doubt', 'think'],
    ['working', '工作', 'excited', 'excited'],
    ['waiting', '等待', 'doubt', 'shake'],
    ['error', '出错', 'troubled', 'dizzy'],
    ['done', '完成', 'happy', 'nod'],
    ['sleeping', '睡眠', 'sleep', 'sleep'],
    ['offline', '离线', 'dark', null],
  ]
  const STATE_LABEL = Object.fromEntries(STATE_DEF_UI.map(([s, l]) => [s, l]))
  const stateExprSlot = (s) => STATE_DEF_UI.find(([k]) => k === s)?.[2] ?? null
  const stateMotionSlot = (s) => STATE_DEF_UI.find(([k]) => k === s)?.[3] ?? null

  let viewerPath = ''   // 预览弹窗当前目标模型
  let binderPath = ''   // 编辑器已填充的模型（用于变更检测）
  let binderInventory = { expressions: [], motions: [] }
  /** 草稿：{ expressions: {槽位: 名}, motions: {槽位: [组,序号]}, clickPool: [[组,序号]] } */
  let binderDraft = null
  let binderState = 'idle'   // 当前编辑目标状态（与状态栏按钮联动）

  function binderSetStatus(text, isError = false) {
    binderStatus.textContent = text
    binderStatus.classList.toggle('error', isError)
  }

  /** 素材按钮文案：组:序号 + 文件名末段。 */
  function motionOptionLabel(m) {
    return `${m.group}:${m.index} ${m.file.split('/').pop()}`
  }

  /** 表情名 → 服役状态中文名列表（角标用，用户词汇而非槽位名）。 */
  function faceBadges(name) {
    return STATE_DEF_UI
      .filter(([, , eslot]) => eslot && binderDraft.expressions[eslot] === name)
      .map(([, label]) => label)
  }

  /** 动作 [组,序号] → 服役状态中文名列表（含点击池）。 */
  function moveBadges(g, i) {
    const hits = STATE_DEF_UI
      .filter(([, , , mslot]) => mslot && binderDraft.motions[mslot]?.[0] === g && binderDraft.motions[mslot]?.[1] === i)
      .map(([, label]) => label)
    if (binderDraft.clickPool.some(([pg, pi]) => pg === g && pi === i)) hits.push('点击池')
    return hits
  }

  function makeMat(text, on, badges, onClick, disabled = false) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'l2d-mat' + (on ? ' on' : '')
    btn.textContent = text
    btn.disabled = disabled
    if (badges.length > 0) {
      const s = document.createElement('span')
      s.className = 'badges'
      s.textContent = '→ ' + badges.join('、')
      btn.appendChild(s)
    }
    btn.addEventListener('click', onClick)
    return btn
  }

  /** 渲染编辑器：当前状态行 + 共享提示 + 脸/动作画廊 + 点击池。 */
  function renderBinder() {
    if (!binderDraft) return
    const eslot = stateExprSlot(binderState)
    const mslot = stateMotionSlot(binderState)
    binderStateEl.textContent = STATE_LABEL[binderState]
    binderFaceEl.textContent = binderDraft.expressions[eslot] ?? '（未绑定）'
    binderMoveEl.textContent = mslot ? (binderDraft.motions[mslot] ? motionOptionLabel({ group: binderDraft.motions[mslot][0], index: binderDraft.motions[mslot][1], file: '' }).trim() : '（未绑定）') : '（该状态无动作位）'
    // 共享提示：别的状态也在用同一个脸/动作槽时告知，避免"我改了A怎么B也变了"
    const sharers = STATE_DEF_UI.filter(([k, , s2]) => k !== binderState && s2 !== null && s2 === eslot).map(([, l]) => l)
    if (sharers.length > 0) {
      binderShareEl.hidden = false
      binderShareEl.textContent = `提示：「${sharers.join('」「')}」和当前状态共用同一张脸，换脸会一起变`
    } else {
      binderShareEl.hidden = true
    }

    binderFacesEl.replaceChildren()
    for (const name of binderInventory.expressions) {
      binderFacesEl.appendChild(makeMat(name, binderDraft.expressions[eslot] === name, faceBadges(name), () => toggleFace(name)))
    }
    binderMovesEl.replaceChildren()
    for (const m of binderInventory.motions) {
      const on = mslot !== null && binderDraft.motions[mslot]?.[0] === m.group && binderDraft.motions[mslot]?.[1] === m.index
      binderMovesEl.appendChild(makeMat(motionOptionLabel(m), on, moveBadges(m.group, m.index), () => toggleMove(m), mslot === null))
    }
    binderPoolEl.replaceChildren()
    for (const m of binderInventory.motions) {
      const on = binderDraft.clickPool.some(([pg, pi]) => pg === m.group && pi === m.index)
      binderPoolEl.appendChild(makeMat(motionOptionLabel(m), on, [], () => togglePool(m)))
    }
  }

  /** 换脸：写进当前状态的脸槽（再点同一个=解绑），并立即在预览里播放。 */
  function toggleFace(name) {
    const eslot = stateExprSlot(binderState)
    if (!eslot) return
    if (binderDraft.expressions[eslot] === name) delete binderDraft.expressions[eslot]
    else binderDraft.expressions[eslot] = name
    withViewerApi(api => api.rawExpr(name))
    renderBinder()
  }

  /** 换动作：写进当前状态的动作槽；无动作位的状态给出提示。 */
  function toggleMove(m) {
    const mslot = stateMotionSlot(binderState)
    if (!mslot) {
      binderSetStatus(`「${STATE_LABEL[binderState]}」没有动作位（闲置/离线靠模型自动呼吸）`, true)
      return
    }
    const cur = binderDraft.motions[mslot]
    if (cur && cur[0] === m.group && cur[1] === m.index) delete binderDraft.motions[mslot]
    else binderDraft.motions[mslot] = [m.group, m.index]
    withViewerApi(api => api.rawMotion(m.group, m.index))
    renderBinder()
  }

  /** 点击池多选开关，点选即试听。 */
  function togglePool(m) {
    const idx = binderDraft.clickPool.findIndex(([pg, pi]) => pg === m.group && pi === m.index)
    if (idx >= 0) binderDraft.clickPool.splice(idx, 1)
    else binderDraft.clickPool.push([m.group, m.index])
    withViewerApi(api => api.rawMotion(m.group, m.index))
    renderBinder()
  }

  /** 填充编辑器：拉取目标模型的清单与既有档案，渲染槽位表（显示值为 profile 覆盖后的生效绑定）。 */
  async function populateBinder(path) {
    binderPath = path
    const dir = path.split('/').slice(0, -1).join('/')
    binderSetStatus('正在读取素材清单…')
    let modelJson = null
    let profile = null
    try { modelJson = await (await fetch(`${BASE}/model/${path}`, { cache: 'no-store' })).json() } catch { }
    try { profile = await (await fetch(`${BASE}/model/${dir}/profile.json`, { cache: 'no-store' })).json() } catch { }
    binderInventory = extractInventory(modelJson)
    const resolved = resolveBinding(modelJson, profile)
    binderDraft = {
      expressions: { ...resolved.expr },
      motions: { ...resolved.motion },
      clickPool: resolved.clickPool.map((p) => [...p]),
    }
    renderBinder()
    binderSetStatus(profile ? '已加载既有 profile.json（可覆盖保存）' : '当前为自动嗅探结果（保存后生成 profile.json）')
  }

  /** 草稿 → profile.json 形状（丢弃空组；全空时返回 null，清空请走恢复嗅探）。 */
  function buildProfile() {
    const profile = {}
    if (Object.keys(binderDraft.expressions).length > 0) profile.expressions = binderDraft.expressions
    const motions = { ...binderDraft.motions }
    if (binderDraft.clickPool.length > 0) motions.clickPool = binderDraft.clickPool
    if (Object.keys(motions).length > 0) profile.motions = motions
    return profile.expressions || profile.motions ? profile : null
  }

  /** 保存：写档案 → 若编辑的正是当前模型则强制热重载绑定。 */
  async function saveBinder() {
    const profile = buildProfile()
    if (!profile) {
      binderSetStatus('没有可保存的绑定；想清空请用「恢复自动嗅探」', true)
      return
    }
    const dir = binderPath.split('/').slice(0, -1).join('/')
    binderSetStatus('正在保存…')
    try {
      const response = await fetch(BASE + '/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, profile }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      if (binderPath === ctx.modelPath) {
        await ctx.switchModel(ctx.modelPath, true)
        binderSetStatus('已保存并热生效')
      } else {
        binderSetStatus('已保存（切换到该模型时生效）')
      }
    } catch (error) {
      binderSetStatus('保存失败：' + error.message, true)
    }
  }

  /** 恢复自动嗅探：删除档案 → 热重载 → 重填表单显示嗅探结果。 */
  async function resetBinder() {
    const dir = binderPath.split('/').slice(0, -1).join('/')
    binderSetStatus('正在删除档案…')
    try {
      const response = await fetch(BASE + '/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, reset: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      if (binderPath === ctx.modelPath) await ctx.switchModel(ctx.modelPath, true)
      await populateBinder(binderPath)
    } catch (error) {
      binderSetStatus('恢复失败：' + error.message, true)
    }
  }

  binderToggle.addEventListener('click', () => {
    const willOpen = binderEl.hidden
    binderEl.hidden = !willOpen
    binderToggle.classList.toggle('active', willOpen)
    if (willOpen) {
      // 打开时跟随状态栏当前激活的按钮，保持「点谁配谁」的连续性
      const active = statesBar.querySelector('.l2d-state-btn.active')
      if (active?.dataset.state && STATE_LABEL[active.dataset.state]) binderState = active.dataset.state
      if (binderPath !== viewerPath) void populateBinder(viewerPath)
      else if (binderDraft) renderBinder()
    }
  })
  binderSaveBtn.addEventListener('click', () => void saveBinder())
  binderResetBtn.addEventListener('click', () => void resetBinder())

  let panelOpen = false
  let panelBusy = false
  let models = []
  let serverDefaultModel = ''
  let hideTimer = 0

  // ── 入口静置自动隐藏：指针靠近模型时出现，面板/任一卡片打开时保持，
  // 远离后三兄弟（⚙/🔒/?）一起隐退——锁没锁定看颜色，不靠常显。
  // 菜单不作阻断条件：穿透态下「点外面关闭」收不到事件，菜单容易卡死成永开，
  // 改为隐藏时连菜单一起收（按钮都隐了菜单也点不到，留着只会堵死隐藏）──
  function showToggle() {
    clearTimeout(hideTimer)
    toggle.classList.remove('l2d-hidden')
    gameToggle.classList.remove('l2d-hidden')
    pinToggle.classList.remove('l2d-hidden')
    helpToggle.classList.remove('l2d-hidden')
  }
  function scheduleHide() {
    clearTimeout(hideTimer)
    if (!panelOpen && !helpOpen && !quipsOpen) {
      hideTimer = setTimeout(() => {
        // 直接收菜单而非 toggleMenu(false)：后者会回调 scheduleHide 造成 1.2s 重军备循环
        menuOpen = false
        menu.classList.remove('open')
        toggle.classList.add('l2d-hidden')
        gameToggle.classList.add('l2d-hidden')
        helpToggle.classList.add('l2d-hidden')
        pinToggle.classList.add('l2d-hidden')
      }, 1200)
    }
  }
  showToggle()
  scheduleHide()
  // 五子棋对局卡：挂载即就绪（ctx.openGame 由 🎮 独立功能钮调用）
  attachGame(ctx)
  // 挂件：box 即小窗，指针进出直接驱动显隐。
  // 桌宠：box 铺满全屏，任何鼠标移动都会触发——显隐改由 interact 光标轮询
  // 按「指针是否靠近模型」驱动（迁移沿触发），路过屏幕别处不惊动按钮。
  if (!BRIDGE) {
    ctx.box.addEventListener('pointerenter', showToggle)
    ctx.box.addEventListener('pointermove', showToggle)
    ctx.box.addEventListener('pointerleave', scheduleHide)
  }
  // 桌宠穿透态下指针事件不进页面，按钮显隐改由 interact 的光标轮询驱动（见 interact.js onCursor）
  ctx.showChrome = showToggle
  ctx.hideChrome = scheduleHide

  // ── 卡片拖动：头部即把手；拖过一次即自由定位（position* 不再锚定），关闭重开恢复锚定 ──
  let panelPlaced = false
  let quipsPlaced = false
  let helpPlaced = false
  function makeDraggable(card, handle, setPlaced) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, textarea, a')) return
      e.preventDefault()
      const r = card.getBoundingClientRect()
      const dx = e.clientX - r.left
      const dy = e.clientY - r.top
      const move = (ev) => {
        // 钳制：至少保留 80px 横边与 40px 顶边在屏内，防拖丢
        const left = Math.min(Math.max(ev.clientX - dx, 8 - card.offsetWidth + 80), window.innerWidth - 88)
        const top = Math.min(Math.max(ev.clientY - dy, 8), window.innerHeight - 48)
        card.style.left = Math.round(left) + 'px'
        card.style.top = Math.round(top) + 'px'
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setPlaced(true)
        ctx.evalIgnore?.()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
  }
  makeDraggable(panel, panel.querySelector('.l2d-panel-head'), (v) => { panelPlaced = v })
  makeDraggable(quipsCard, quipsCard.querySelector('.l2d-quips-head'), (v) => { quipsPlaced = v })
  makeDraggable(helpCard, helpCard.querySelector('.l2d-help-head'), (v) => { helpPlaced = v })

  function setStatus(text, isError = false) {
    statusEl.textContent = text
    statusEl.classList.toggle('error', isError)
  }

  function positionPanel() {
    if (!panelOpen || panelPlaced) return
    const rect = toggle.getBoundingClientRect()
    const gap = 8
    // 窄窗口下面板会被 CSS min() 收缩，钳制必须用实测宽度而非宽度上限
    const w = panel.offsetWidth || PANEL_WIDTH
    let left = rect.right - w
    left = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - w - 8))
    let top = rect.bottom + gap
    if (top + panel.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - panel.offsetHeight - gap)
    }
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
  }

  function renderList() {
    currentPathEl.textContent = ctx.modelPath
    listEl.replaceChildren()
    if (models.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'l2d-model-empty'
      empty.textContent = '未找到 .model3.json 模型'
      listEl.appendChild(empty)
      return
    }
    for (const item of models) {
      const row = document.createElement('div')
      row.className = 'l2d-model-row' + (item.path === ctx.modelPath ? ' selected' : '')
      const itemBtn = document.createElement('button')
      itemBtn.type = 'button'
      itemBtn.className = 'l2d-model-item'
      const name = document.createElement('div')
      name.className = 'l2d-model-name'
      name.textContent = item.dir !== '' ? item.dir : item.file.replace(/\.model3\.json$/i, '')
      const path = document.createElement('div')
      path.className = 'l2d-model-path'
      path.textContent = item.path
      itemBtn.append(name, path)
      itemBtn.addEventListener('click', () => selectModel(item.path))
      const viewBtn = document.createElement('button')
      viewBtn.type = 'button'
      viewBtn.className = 'l2d-model-view'
      viewBtn.title = '预览 ' + item.path
      viewBtn.textContent = '查看'
      viewBtn.addEventListener('click', () => openViewer(item.path))
      row.append(itemBtn, viewBtn)
      // 根级散件模型（dir=''）无独立文件夹可删，宿主必 400——不给删除钮
      if (item.dir !== '') {
        const delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'l2d-model-del'
        delBtn.title = '删除 ' + item.path + '（整个文件夹从磁盘移除）'
        delBtn.textContent = '×'
        delBtn.addEventListener('click', () => deleteModel(item))
        row.appendChild(delBtn)
      }
      listEl.appendChild(row)
    }
  }

  /** 删除模型：明确警告确认 → 宿主整个目录移除（删当前模型时宿主自动回落默认并广播） */
  async function deleteModel(item) {
    if (panelBusy) return
    const warn = `删除模型「${item.dir || item.path}」？\n整个文件夹将从磁盘移除，不可恢复。`
    if (!window.confirm(warn)) return
    panelBusy = true
    setStatus('正在删除…')
    try {
      const response = await fetch(BASE + '/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: item.dir }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      setStatus(`已删除：${item.dir}${data.reset ? '（当前模型已回落默认）' : ''}`)
      await refreshModels()
    } catch (error) {
      setStatus('删除失败：' + error.message, true)
    } finally {
      panelBusy = false
    }
  }

  async function refreshModels() {
    setStatus('正在扫描模型…')
    try {
      const response = await fetch(BASE + '/models', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      models = Array.isArray(data.models) ? data.models : []
      serverDefaultModel = typeof data.defaultModel === 'string' ? data.defaultModel : ''
      resetBtn.title = '恢复默认：' + (serverDefaultModel || 'cordis.patch.yml')
      renderList()
      setStatus(models.length > 0 ? `共 ${models.length} 个模型` : '未找到 .model3.json 模型')
    } catch (error) {
      setStatus('加载失败：' + error.message, true)
    }
  }

  async function selectModel(nextPath) {
    if (panelBusy) return
    if (nextPath === ctx.modelPath) {
      renderList()
      setStatus('已经是当前模型')
      return
    }
    panelBusy = true
    setStatus('正在切换…')
    try {
      const response = await fetch(BASE + '/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: nextPath }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      const switched = await ctx.switchModel(data.model)
      if (!switched && ctx.modelPath !== data.model) throw new Error('模型加载失败')
      renderList()
      setStatus('已切换：' + data.model)
    } catch (error) {
      setStatus('切换失败：' + error.message, true)
    } finally {
      panelBusy = false
    }
  }

  async function resetDefaultModel() {
    if (panelBusy) return
    panelBusy = true
    setStatus('正在恢复默认模型…')
    try {
      const response = await fetch(BASE + '/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      const switched = await ctx.switchModel(data.model)
      if (!switched && ctx.modelPath !== data.model) throw new Error('默认模型加载失败')
      renderList()
      setStatus('已恢复默认：' + data.model)
    } catch (error) {
      setStatus('恢复失败：' + error.message, true)
    } finally {
      panelBusy = false
    }
  }

  function openPanel() {
    panelOpen = true
    showToggle()
    panel.classList.add('open')
    positionPanel()
    ctx.evalIgnore?.()  // 面板展开后立即刷新穿透判定（面板区域纳入可交互）
    if (models.length === 0) void refreshModels()
    else renderList()
    void refreshMode()
  }

  function closePanel() {
    panelOpen = false
    panelPlaced = false   // 重开恢复锚定
    panel.classList.remove('open')
    scheduleHide()
    ctx.evalIgnore?.()
  }

  function togglePanel() {
    if (panelOpen) closePanel()
    else openPanel()
  }

  function openViewer(path) {
    if (!path) return
    viewerPath = path
    viewerTitle.textContent = path
    viewerFrame.src = `${BASE}/pet.html?model=${encodeURIComponent(path)}&preview=1`
    viewer.classList.add('open')
    ctx.evalIgnore?.()
  }

  function closeViewer() {
    viewer.classList.remove('open')
    viewerFrame.src = 'about:blank'
    statesBar.querySelectorAll('.l2d-state-btn').forEach(b => b.classList.remove('active'))
    binderEl.hidden = true
    binderToggle.classList.remove('active')
    ctx.evalIgnore?.()
  }

  function runImportFlow() {
    if (panelBusy) return
    importInput.value = ''
    importInput.click()
  }

  async function importSelectedFiles(fileList) {
    const files = [...fileList]
    if (files.length === 0) return
    let modelName = ''
    for (const file of files) {
      const rel = (file.webkitRelativePath || '').replaceAll('\\', '/')
      const first = rel.split('/')[0]
      if (first && first !== '.' && first !== '..' && !first.startsWith('.')) {
        modelName = first
        break
      }
    }
    if (!modelName) {
      // Electron 不支持 window.prompt：单文件导入自动派生文件夹名（与现有模型冲突时追加序号）
      const base = ((files.length === 1 ? files[0].name.replace(/\.model3\.json$/i, '') : 'my-model') || 'my-model').trim() || 'my-model'
      modelName = base
      let n = 2
      while (models.some((m) => m.dir === modelName)) {
        modelName = `${base}-${n}`
        n += 1
      }
    }
    if (!modelName || modelName.includes('/') || modelName.includes('\\') || modelName.includes(':') || modelName.startsWith('.')) {
      setStatus('模型名称无效：请使用不含 / \\\\ : 的文件夹名', true)
      return
    }
    const ordered = [...files].sort((a, b) => {
      const ai = a.name.toLowerCase().endsWith('.model3.json') ? 1 : 0
      const bi = b.name.toLowerCase().endsWith('.model3.json') ? 1 : 0
      return ai - bi
    })
    panelBusy = true
    let model3Path = ''
    let uploaded = 0
    const upload = async (overwrite) => {
      for (const file of ordered) {
        const rel = (file.webkitRelativePath || file.name).replaceAll('\\', '/')
        const parts = rel.split('/')
        const filePath = parts.length > 1 ? parts.slice(1).join('/') : file.name
        if (!filePath) continue
        setStatus(`导入中 ${uploaded + 1}/${ordered.length}：${file.name}`)
        const response = await fetch(`${BASE}/import?model=${encodeURIComponent(modelName)}&path=${encodeURIComponent(filePath)}${overwrite ? '&overwrite=1' : ''}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: await file.arrayBuffer(),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw Object.assign(new Error(data.error || 'HTTP ' + response.status), { status: response.status })
        uploaded += 1
        if (file.name.toLowerCase().endsWith('.model3.json')) model3Path = `${modelName}/${filePath}`
      }
    }
    try {
      try {
        await upload(false)
      } catch (error) {
        // 重名防御：宿主 409 时询问后整体重传（服务端保护不被绕过，只是给确认通道）
        if (error.status === 409 && confirm(error.message + '\n\n覆盖重传全部文件？')) {
          uploaded = 0
          model3Path = ''
          await upload(true)
        } else throw error
      }
    } catch (error) {
      panelBusy = false
      setStatus('导入失败：' + error.message, true)
      await refreshModels()
      return
    }
    panelBusy = false
    await refreshModels()
    if (model3Path) {
      await selectModel(model3Path)
    } else {
      setStatus(`导入完成：${modelName}（未找到 .model3.json）`)
    }
  }

  closeBtn.addEventListener('click', closePanel)
  resetBtn.addEventListener('click', resetDefaultModel)
  refreshBtn.addEventListener('click', () => refreshModels())
  importBtn.addEventListener('click', runImportFlow)
  importInput.addEventListener('change', () => {
    void importSelectedFiles(importInput.files)
    importInput.value = ''
  })
  viewerClose.addEventListener('click', closeViewer)
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer() })
  resetBtn.title = '恢复 cordis.patch.yml 中配置的默认模型'
  window.addEventListener('resize', positionPanel)
  document.addEventListener('pointerdown', (e) => {
    // 台词卡/说明卡也挂在 body 下，点它们不算「点在面板外」
    if (panelOpen && !panel.contains(e.target) && !toggle.contains(e.target) && !viewer.contains(e.target)
      && !quipsCard.contains(e.target) && !helpCard.contains(e.target)) closePanel()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    // 台词编辑器的输入区按 Esc 不关背后的面板（输入行/正文都拦）
    if (e.target instanceof HTMLElement && quipsCard.contains(e.target)) return
    if (viewer.classList.contains('open')) closeViewer()
    else closePanel()
  })
  ctx.box.addEventListener('pointerup', () => { if (panelOpen) positionPanel() })

  return {
    refreshModels,
    openPanel,
    closePanel,
    openViewer,
    importModels: importSelectedFiles,
    get modelList() { return [...models] },
  }
}
