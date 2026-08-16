/**
 * hourly-chime.js —— 示例扩展：整点报时。
 *
 * 演示扩展的基本形态：默认导出 apply(api)，每整点冒一个气泡。
 * 想停用：从 index.json 清单删掉本文件名即可，无需动代码。
 */

export default function apply(api) {
  let lastHour = new Date().getHours()
  setInterval(() => {
    const h = new Date().getHours()
    if (h !== lastHour) {
      lastHour = h
      api.showBubble(`${h} 点啦~`, 3000)
    }
  }, 30000)
}
