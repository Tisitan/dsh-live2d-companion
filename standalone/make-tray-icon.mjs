// 生成 standalone/tray-icon.png（32×32，薄荷绿系圆形图标，Nori 主题色）。
// 手写 PNG chunk，只用 node 内置 zlib —— 不引入任何 npm 依赖。
// 留档用途：二进制资源在 git 里无法 review，脚本即其可复现的出处。
// 用法：node standalone/make-tray-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 32
const SS = 4                                  // 每像素 4×4 超采样（抗锯齿）
const MINT = [0x6e, 0xe7, 0xb7, 0xff]         // 主题薄荷绿
const MINT_EDGE = [0x34, 0xd3, 0x99, 0xff]    // 外圈描边：缩到 16px 仍有轮廓
const WHITE = [0xff, 0xff, 0xff, 0xff]

const CX = 16
const CY = 16
const R = 15
const EYES = [{ x: 11, y: 14, r: 2 }, { x: 21, y: 14, r: 2 }]
// 微笑：二次贝塞尔 (10,21)-(16,26)-(22,21) 展平成折线，按「到折线距离」描边
const SMILE = []
for (let i = 0; i <= 24; i++) {
  const t = i / 24
  const mt = 1 - t
  SMILE.push([
    mt * mt * 10 + 2 * mt * t * 16 + t * t * 22,
    mt * mt * 21 + 2 * mt * t * 26 + t * t * 21,
  ])
}
const SMILE_HALF_WIDTH = 1.0

function distToSmile(x, y) {
  let best = Infinity
  for (let i = 1; i < SMILE.length; i++) {
    const [x1, y1] = SMILE[i - 1]
    const [x2, y2] = SMILE[i]
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
  }
  return best
}

/** 子样本着色：null = 透明（圆外）。 */
function sampleAt(x, y) {
  const d = Math.hypot(x - CX, y - CY)
  if (d > R) return null
  for (const eye of EYES) if (Math.hypot(x - eye.x, y - eye.y) <= eye.r) return WHITE
  if (distToSmile(x, y) <= SMILE_HALF_WIDTH) return WHITE
  return d > R - 1.2 ? MINT_EDGE : MINT
}

// 扫描线：每行首字节是 filter type 0（None），其后 RGBA
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4)
  for (let x = 0; x < SIZE; x++) {
    let r = 0
    let g = 0
    let b = 0
    let hits = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = sampleAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
        if (px === null) continue
        r += px[0]
        g += px[1]
        b += px[2]
        hits++
      }
    }
    const o = rowStart + 1 + x * 4
    if (hits === 0) continue   // 已是全零：透明像素
    // 颜色只对命中的子样本取均值（避免边缘掺黑），覆盖率折进 alpha
    raw[o] = Math.round(r / hits)
    raw[o + 1] = Math.round(g / hits)
    raw[o + 2] = Math.round(b / hits)
    raw[o + 3] = Math.round((hits / (SS * SS)) * 255)
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8    // bit depth
ihdr[9] = 6    // color type 6 = RGBA
ihdr[10] = 0   // compression
ihdr[11] = 0   // filter
ihdr[12] = 0   // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = join(dirname(fileURLToPath(import.meta.url)), 'tray-icon.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE} RGBA)`)
