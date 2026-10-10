/**
 * 极简 WebSocket 客户端（RFC 6455 客户端半边），只为了说 CDP。
 *
 * 为什么不用 Node 内建的全局 `WebSocket`：本机实测中，undici 版 WebSocket 与
 * Chrome 154 的 DevTools 端点在握手成功后立即以 1006 异常关闭（同一 URL、同一时刻，
 * 裸 socket 手工握手却返回 101）。改为自己实现握手与帧编解码，零依赖且行为确定。
 *
 * 覆盖范围（够用即可，不做扩展协商）：
 *   - 握手：Sec-WebSocket-Key / Accept 校验
 *   - 发送：文本帧，强制 MASK，长度 7/16/64 位三种编码
 *   - 接收：文本与二进制帧、分片重组、ping 自动回 pong、close 回执
 */

import net from 'node:net'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export class RawWebSocket extends EventEmitter {
  constructor(url) {
    super()
    this.url = new URL(url)
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.open = false
    this.closed = false
    this.fragments = []
    this.fragmentOpcode = 0
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64')
      const port = Number(this.url.port || 80)
      const path = this.url.pathname + this.url.search

      this.socket = net.connect(port, this.url.hostname, () => {
        this.socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${this.url.host}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        )
      })

      let handshake = Buffer.alloc(0)
      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk])
        const end = handshake.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = handshake.subarray(0, end).toString('latin1')
        this.socket.off('data', onData)
        if (!/^HTTP\/1\.1 101/.test(head)) {
          reject(new Error('WebSocket 握手失败: ' + head.split('\r\n')[0]))
          return
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)
        if (!accept || accept[1] !== expected) {
          reject(new Error('Sec-WebSocket-Accept 校验失败'))
          return
        }
        this.open = true
        const rest = handshake.subarray(end + 4)
        this.socket.on('data', (c) => this._onData(c))
        this.socket.on('error', (e) => this.emit('error', e))
        this.socket.on('close', () => {
          this.closed = true
          this.emit('close')
        })
        if (rest.length) this._onData(rest)
        resolve()
      }
      this.socket.on('data', onData)
      this.socket.on('error', (e) => { if (!this.open) reject(e) })
      setTimeout(() => { if (!this.open) reject(new Error('WebSocket 握手超时')) }, 10000)
    })
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this._readFrame()
      if (!frame) return
      this._handleFrame(frame)
    }
  }

  /** 解析一个帧；数据不足时返回 null 并保留缓冲。 */
  _readFrame() {
    const b = this.buffer
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (b.length < offset + 2) return null
      len = b.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (b.length < offset + 8) return null
      const big = b.readBigUInt64BE(offset)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('帧过大')
      len = Number(big)
      offset += 8
    }
    let mask = null
    if (masked) {
      if (b.length < offset + 4) return null
      mask = b.subarray(offset, offset + 4)
      offset += 4
    }
    if (b.length < offset + len) return null
    let payload = Buffer.from(b.subarray(offset, offset + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    this.buffer = b.subarray(offset + len)
    return { fin, opcode, payload }
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x9) { this._sendFrame(0xa, payload); return } // ping → pong
    if (opcode === 0xa) return // pong
    if (opcode === 0x8) { this.close(); return } // close
    if (opcode === 0x0) {
      this.fragments.push(payload)
    } else {
      this.fragments = [payload]
      this.fragmentOpcode = opcode
    }
    if (!fin) return
    const full = Buffer.concat(this.fragments)
    this.fragments = []
    this.emit('message', this.fragmentOpcode === 0x1 ? full.toString('utf8') : full)
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('socket 已关闭')
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const len = data.length
    let header
    if (len < 126) {
      header = Buffer.alloc(6)
      header[1] = 0x80 | len
    } else if (len < 65536) {
      header = Buffer.alloc(8)
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(14)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode
    const mask = crypto.randomBytes(4)
    mask.copy(header, header.length - 4)
    const masked = Buffer.from(data)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
    this.socket.write(Buffer.concat([header, masked]))
  }

  send(text) {
    this._sendFrame(0x1, text)
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this._sendFrame(0x8, Buffer.alloc(0)) } catch { /* 已经断了 */ }
    try { this.socket.end() } catch { /* 已经断了 */ }
  }
}

export function connect(url) {
  const ws = new RawWebSocket(url)
  return ws.connect().then(() => ws)
}
