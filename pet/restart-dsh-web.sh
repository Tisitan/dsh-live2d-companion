#!/usr/bin/env bash
# restart-dsh-web.sh —— restart-dsh-web.ps1（Windows 版）的 Linux 同语义移植：
# 结束占用 3080 的旧 dsh web 进程（对应 Stop-Process -Force）→ nohup 后台重启
# （对应 cmd /k 新窗口，Linux 无窗可开改日志落盘）→ 轮询 45x2s 等就绪 → 探活 Live2D 插件。
# ps1 本体保持 Windows 专用，本脚本仅服务 Linux 侧，二者互不引用。
set -u

PORT=3080
DESKTOP="$HOME/Desktop"
LOG="$DESKTOP/dsh-web.log"

get_pid() {
  ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

PID="$(get_pid)"
CMDLINE=""
if [ -n "$PID" ]; then
  CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
  echo "停止旧实例 (pid $PID)..."
  kill "$PID" 2>/dev/null || true
  sleep 2
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  sleep 1
else
  echo "端口 $PORT 没有在监听，直接启动..."
fi

if [ -z "$CMDLINE" ]; then
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$DSH_BIN" ]; then
    CMDLINE="$DSH_BIN web"
  else
    CMDLINE="node $HOME/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web"
  fi
fi

echo "启动: $CMDLINE"
cd "$DESKTOP" || exit 1
nohup $CMDLINE >>"$LOG" 2>&1 &
echo "日志: $LOG"

UP=false
for _ in $(seq 1 45); do
  sleep 2
  if ss -tln "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then UP=true; break; fi
done

if $UP; then
  echo 'DSH Web 已就绪 (http://127.0.0.1:3080)'
  if STATE="$(curl -s --max-time 5 http://127.0.0.1:3080/live2d/state)"; then
    echo "Live2D 插件: $STATE"
  else
    echo 'Live2D 插件未响应，检查 cordis.patch.yml 的 insert 行'
  fi
else
  echo '等待超时，请查看日志:'
  echo "  tail -50 $LOG"
fi
