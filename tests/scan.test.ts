import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { getAddress } from 'viem'
import { ARC_CHAIN_ID, USDC } from '../src/chain'
import { resolveScan, sendReviewLink } from '../src/lib/paymentQr'
import { CAMERA_MESSAGES, cameraProblem, decodeImageData } from '../src/lib/scanner'

const FRIEND = '0x1111111111111111111111111111111111111111'

describe('what a scanned or typed payment means', () => {
  test('a wallet address and a USDC request open Send, with the amount when there is one', () => {
    expect(resolveScan(FRIEND)).toEqual({ kind: 'send', address: getAddress(FRIEND), amount: undefined })
    expect(resolveScan(`  ${FRIEND}\n`)).toMatchObject({ kind: 'send' })
    expect(resolveScan(`ethereum:${USDC.address}@${ARC_CHAIN_ID}/transfer?address=${FRIEND}&uint256=2500000`)).toMatchObject({ kind: 'send', address: getAddress(FRIEND), amount: '2.5' })
    expect(resolveScan(`https://example.app/send?to=${FRIEND}&amount=3`)).toMatchObject({ kind: 'send', amount: '3' })
  })

  test('an Arvexa payment link keeps its details and opens the Pay screen, not Send', () => {
    const target = resolveScan(`https://example.app/pay?to=${FRIEND}&amount=12.5&desc=Invoice%20INV-1&ref=A1&id=abc123&evil=1`)
    expect(target.kind).toBe('pay')
    if (target.kind !== 'pay') return
    expect(target.path.startsWith('/pay?')).toBe(true)
    const params = new URLSearchParams(target.path.split('?')[1])
    expect(params.get('to')).toBe(getAddress(FRIEND))
    expect(params.get('amount')).toBe('12.5')
    expect(params.get('desc')).toBe('Invoice INV-1')
    expect(params.get('id')).toBe('abc123')
    expect(params.has('evil')).toBe(false) // only known fields are passed on
  })

  test('a payment link with a bad address or amount is rejected with its reason', () => {
    expect(resolveScan('https://example.app/pay?to=0x123&amount=1')).toMatchObject({ kind: 'invalid', title: 'Not a valid payment link' })
    expect(resolveScan(`https://example.app/pay?to=${FRIEND}&amount=abc`)).toMatchObject({ kind: 'invalid' })
  })

  test('the wrong network, the wrong token and other payment apps are named, not silently accepted', () => {
    expect(resolveScan(`ethereum:${FRIEND}@1`)).toMatchObject({ kind: 'invalid' })
    expect(resolveScan(`ethereum:0x2222222222222222222222222222222222222222@${ARC_CHAIN_ID}/transfer?address=${FRIEND}&uint256=1`)).toMatchObject({ kind: 'invalid' })
    expect(resolveScan('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=1')).toMatchObject({ kind: 'invalid', title: 'Unsupported payment code' })
    expect((resolveScan('solana:7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV') as { message: string }).message).toContain('Solana')
    expect((resolveScan('wc:8a5e5bdc@2?relay-protocol=irn&symKey=x') as { message: string }).message).toContain('WalletConnect')
  })

  test('a plain web link is offered as an API payment only, and unsafe links are refused', () => {
    expect(resolveScan('https://api.example.com/data?id=1')).toEqual({ kind: 'api', url: 'https://api.example.com/data?id=1' })
    expect(resolveScan('http://api.example.com/data')).toMatchObject({ kind: 'invalid' })
    expect(resolveScan('http://localhost:3000/premium')).toMatchObject({ kind: 'api' })
    expect(resolveScan('https://user:pass@api.example.com/data')).toMatchObject({ kind: 'invalid' })
  })

  test('empty, oversized and random text is invalid', () => {
    for (const text of ['', '   ', 'hello world', '0x123', 'x'.repeat(3000), USDC.address.slice(0, 20)]) {
      expect(resolveScan(text).kind).toBe('invalid')
    }
    // The USDC token contract is not somewhere to send money.
    expect(resolveScan(USDC.address).kind).toBe('invalid')
  })

  test('only a request with an amount opens the review screen directly', () => {
    expect(sendReviewLink(FRIEND, '2.5')).toBe(`/send?to=${FRIEND}&amount=2.5&review=1`)
    expect(sendReviewLink(FRIEND)).toBe(`/send?to=${FRIEND}`)
  })
})

describe('camera problems', () => {
  test('each browser error maps to a clear, specific message', () => {
    const named = (name: string) => Object.assign(new Error(name), { name })
    expect(cameraProblem(named('NotAllowedError'))).toBe('denied')
    expect(cameraProblem(named('NotFoundError'))).toBe('missing')
    expect(cameraProblem(named('NotReadableError'))).toBe('busy')
    expect(cameraProblem(named('SecurityError'))).toBe('insecure')
    expect(cameraProblem(new Error('anything else'))).toBe('failed')
    expect(CAMERA_MESSAGES.denied).toContain('permission was denied')
    expect(CAMERA_MESSAGES.denied).toContain('enter the payment details')
  })
})

describe('reading a real QR code', () => {
  /** Draws a real QR code (the same encoder PayHub and Receive use) into pixels, with a quiet zone, like a camera frame. */
  function raster(value: string, inverted = false): ImageData {
    const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value, size: 100, level: 'M', marginSize: 0 }))
    const modules = Number(/viewBox="0 0 (\d+) /.exec(svg)?.[1])
    const cells = [...svg.matchAll(/M(\d+)[ ,](\d+)\s*h(\d+)v1/g)].filter((match) => !(match[1] === '0' && match[2] === '0' && Number(match[3]) === modules))
    const scale = 8
    const quiet = 4
    const size = (modules + quiet * 2) * scale
    const data = new Uint8ClampedArray(size * size * 4).fill(inverted ? 0 : 255)
    for (let i = 3; i < data.length; i += 4) data[i] = 255
    for (const [, x, y, width] of cells) {
      for (let row = 0; row < scale; row += 1) {
        for (let column = 0; column < Number(width) * scale; column += 1) {
          const at = ((Number(y) + quiet) * scale + row) * size * 4 + ((Number(x) + quiet) * scale + column) * 4
          const value = inverted ? 255 : 0
          data[at] = data[at + 1] = data[at + 2] = value
        }
      }
    }
    return { data, width: size, height: size, colorSpace: 'srgb' } as ImageData
  }

  test('decodes a wallet address, a payment request and a pay link from pixels', async () => {
    for (const text of [FRIEND, `ethereum:${USDC.address}@${ARC_CHAIN_ID}/transfer?address=${FRIEND}&uint256=1500000`, `https://example.app/pay?to=${FRIEND}&amount=4`]) {
      expect(await decodeImageData(raster(text))).toBe(text)
    }
  })

  test('a light-on-dark code needs the inverted attempt, and a blank frame decodes to nothing', async () => {
    expect(await decodeImageData(raster(FRIEND, true), true)).toBe(FRIEND)
    const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64, colorSpace: 'srgb' } as ImageData
    expect(await decodeImageData(blank)).toBeNull()
  })

  test('what is decoded goes through the same checks as typed text', async () => {
    const decoded = await decodeImageData(raster('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'))
    expect(decoded).not.toBeNull()
    expect(resolveScan(decoded ?? '').kind).toBe('invalid')
  })
})
