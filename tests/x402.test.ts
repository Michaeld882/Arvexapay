import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { ARC_CHAIN_ID, USDC } from '../src/chain'
import { ARC_TARGET, MAX_API_PRICE, assertSignedExactly, discover, parseResourceUrl, payOffer, refuseRequirement, verifySettlement, type PayableOffer } from '../src/lib/x402'

const PAYEE = '0x3333333333333333333333333333333333333333' as Address
const PAYER = '0x4444444444444444444444444444444444444444' as Address
const URL_PAID = 'https://api.example.test/paid'

const requirement = (patch: Record<string, unknown> = {}): PaymentRequirements =>
  ({ scheme: 'exact', network: ARC_TARGET.network, asset: USDC.address, amount: '10000', payTo: PAYEE, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' }, ...patch }) as PaymentRequirements

const required = (...accepts: PaymentRequirements[]): PaymentRequired => ({ x402Version: 2, resource: { url: URL_PAID, description: 'Market data', mimeType: 'application/json' }, accepts })

/** A server's 402 answer, as the x402 libraries encode it. This is protocol data, never a payment result. */
const answer402 = (paymentRequired: PaymentRequired): Response => new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired), 'Content-Type': 'application/json' } })

const fetchReturning = (response: () => Response | Promise<Response>) => {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return response()
  }) as typeof fetch
  return { fn, calls }
}

describe('x402 addresses', () => {
  test('only secure web addresses are used', () => {
    expect(parseResourceUrl('https://api.example.com/data?x=1')).toEqual({ ok: true, url: 'https://api.example.com/data?x=1' })
    expect(parseResourceUrl('http://localhost:3000/premium').ok).toBe(true)
    for (const bad of ['', '  ', 'api.example.com', 'http://api.example.com', 'ftp://x.com', 'https://u:p@api.example.com', 'javascript:alert(1)', `https://${'a'.repeat(3000)}.com`]) {
      expect(parseResourceUrl(bad).ok).toBe(false)
    }
  })
})

describe('what Arvexa will sign', () => {
  test('exact USDC on Arc with a real payee and a sane price is accepted', () => {
    expect(refuseRequirement(requirement(), ARC_TARGET)).toBeUndefined()
    expect(refuseRequirement(requirement({ amount: MAX_API_PRICE.toString() }), ARC_TARGET)).toBeUndefined()
  })

  test('every other option is refused with a reason', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ scheme: 'upto' }, /does not sign/],
      [{ network: 'eip155:8453' }, /not Arc Mainnet/],
      [{ asset: '0x2222222222222222222222222222222222222222' }, /token other than USDC/],
      [{ payTo: '0x0000000000000000000000000000000000000000' }, /no valid payee/],
      [{ payTo: USDC.address }, /no valid payee/],
      [{ payTo: 'not an address' }, /no valid payee/],
      [{ amount: '0' }, /no valid price/],
      [{ amount: '-5' }, /no valid price/],
      [{ amount: '1.5' }, /no valid price/],
      [{ amount: (MAX_API_PRICE + 1n).toString() }, /more than Arvexa allows/],
      [{ extra: { assetTransferMethod: 'permit2' } }, /token approval/],
    ]
    for (const [patch, message] of cases) expect(refuseRequirement(requirement(patch), ARC_TARGET)).toMatch(message)
  })
})

describe('reading what an API says', () => {
  test('a price on Arc in USDC becomes an offer for exactly that option', async () => {
    const { fn, calls } = fetchReturning(() => answer402(required(requirement({ network: 'eip155:8453' }), requirement())))
    const found = await discover(URL_PAID, ARC_TARGET, fn)
    expect(found.kind).toBe('payable')
    if (found.kind !== 'payable') return
    expect(found.offer.amount).toBe(10_000n)
    expect(found.offer.payTo).toBe(getAddress(PAYEE))
    expect(found.offer.description).toBe('Market data')
    expect(found.offer.paymentRequired.accepts).toHaveLength(1) // only the accepted option can ever be signed
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.has('payment-signature')).toBe(false) // looking never pays
  })

  test('an API on another network or token, or with too high a price, is unsupported and never offered', async () => {
    for (const patch of [{ network: 'eip155:8453' }, { asset: '0x2222222222222222222222222222222222222222' }, { amount: (MAX_API_PRICE * 2n).toString() }]) {
      const found = await discover(URL_PAID, ARC_TARGET, fetchReturning(() => answer402(required(requirement(patch)))).fn)
      expect(found.kind).toBe('unsupported')
    }
  })

  test('an older x402 version is unsupported', async () => {
    const v1 = JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '10000', resource: URL_PAID, description: '', mimeType: '', payTo: PAYEE, maxTimeoutSeconds: 60, asset: USDC.address, extra: {} }] })
    const found = await discover(URL_PAID, ARC_TARGET, fetchReturning(() => new Response(v1, { status: 402 })).fn)
    expect(found).toMatchObject({ kind: 'unsupported' })
  })

  test('a free API, an error, a 402 that is not x402 and an unreachable server are each reported honestly', async () => {
    expect(await discover(URL_PAID, ARC_TARGET, fetchReturning(() => new Response('hello', { status: 200 })).fn)).toEqual({ kind: 'free', status: 200, preview: 'hello' })
    expect(await discover(URL_PAID, ARC_TARGET, fetchReturning(() => new Response('no', { status: 500 })).fn)).toMatchObject({ kind: 'failed', message: expect.stringContaining('500') })
    expect(await discover(URL_PAID, ARC_TARGET, fetchReturning(() => new Response('pay up', { status: 402 })).fn)).toMatchObject({ kind: 'failed', message: expect.stringContaining('x402') })
    const offline = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    expect(await discover(URL_PAID, ARC_TARGET, offline)).toMatchObject({ kind: 'failed', message: expect.stringContaining('CORS') })
    expect(await discover('http://api.example.test/paid', ARC_TARGET, offline)).toMatchObject({ kind: 'failed', message: expect.stringContaining('https') })
  })

  test('requests never carry cookies or credentials', async () => {
    let seen: RequestInit | undefined
    const spy = (async (_input: RequestInfo | URL, init?: RequestInit) => { seen = init; return new Response('ok') }) as typeof fetch
    await discover(URL_PAID, ARC_TARGET, spy)
    expect(seen?.credentials).toBe('omit')
    expect(seen?.method).toBe('GET')
  })
})

describe('paying an offer', () => {
  const buyer = privateKeyToAccount(generatePrivateKey()) // a throwaway key that exists only inside this test
  const signer = { address: buyer.address, signTypedData: (message: Parameters<typeof buyer.signTypedData>[0]) => buyer.signTypedData(message) }

  async function offerFor(patch: Record<string, unknown> = {}): Promise<PayableOffer> {
    const found = await discover(URL_PAID, ARC_TARGET, fetchReturning(() => answer402(required(requirement(patch)))).fn)
    if (found.kind !== 'payable') throw new Error('expected a payable offer')
    return found.offer
  }

  test('the signed payment pays exactly the price shown, from the connected wallet, to the shown payee', async () => {
    const offer = await offerFor()
    const { fn, calls } = fetchReturning(() => new Response('{}', { status: 402 }))
    await payOffer(offer, signer as never, ARC_TARGET, fn)
    expect(calls).toHaveLength(1)
    const header = calls[0].headers.get('payment-signature')
    expect(header).toBeTruthy()
    const payload = decodePaymentSignatureHeader(header as string) as PaymentPayload
    const authorization = (payload.payload as { authorization: { from: string; to: string; value: string }; signature: string }).authorization
    expect(getAddress(authorization.from)).toBe(buyer.address)
    expect(getAddress(authorization.to)).toBe(getAddress(PAYEE))
    expect(authorization.value).toBe('10000')
    expect((payload.payload as { signature: string }).signature).toMatch(/^0x[0-9a-f]+$/i)
    expect(JSON.stringify(payload)).not.toMatch(/private/i)
  })

  test('an API that refuses the payment is reported as refused, not paid', async () => {
    const offer = await offerFor()
    const result = await payOffer(offer, signer as never, ARC_TARGET, fetchReturning(() => new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 402 })).fn)
    expect(result).toMatchObject({ kind: 'refused', status: 402, message: expect.stringContaining('invalid_signature') })
    const server = await payOffer(offer, signer as never, ARC_TARGET, fetchReturning(() => new Response('boom', { status: 503 })).fn)
    expect(server).toMatchObject({ kind: 'refused', status: 503 })
  })

  test('a 200 without a readable settlement is never reported as a settled payment', async () => {
    const offer = await offerFor()
    const result = await payOffer(offer, signer as never, ARC_TARGET, fetchReturning(() => new Response('{"data":1}', { status: 200 })).fn)
    expect(result.kind).toBe('paid-unconfirmed')
  })

  test('a wallet that declines to sign stops everything: the API is never called with a payment', async () => {
    const offer = await offerFor()
    const declining = { address: buyer.address, signTypedData: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) } }
    const { fn, calls } = fetchReturning(() => new Response('{}'))
    await expect(payOffer(offer, declining as never, ARC_TARGET, fn)).rejects.toThrow(/rejected/i)
    expect(calls).toHaveLength(0)
  })

  test('a prepared payment that does not match the offer is rejected before it is sent', async () => {
    const offer = await offerFor()
    const payload = (patch: Record<string, string>) => ({ x402Version: 2, accepted: offer.requirement, payload: { signature: '0x', authorization: { from: PAYER, to: PAYEE, value: '10000', ...patch } } }) as unknown as PaymentPayload
    expect(() => assertSignedExactly(payload({}), offer, PAYER)).not.toThrow()
    expect(() => assertSignedExactly(payload({ to: '0x5555555555555555555555555555555555555555' }), offer, PAYER)).toThrow(/does not match/)
    expect(() => assertSignedExactly(payload({ value: '10001' }), offer, PAYER)).toThrow(/does not match/)
    expect(() => assertSignedExactly(payload({}), offer, '0x6666666666666666666666666666666666666666')).toThrow(/does not match/)
    expect(() => assertSignedExactly({ x402Version: 2, payload: {} } as unknown as PaymentPayload, offer, PAYER)).toThrow(/does not match/)
  })
})

describe('verifying a settlement on chain', () => {
  const log = (token: Address, from: Address, to: Address, value: bigint) => ({ address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]), blockHash: null, blockNumber: null, logIndex: 0, transactionHash: null, transactionIndex: 0, removed: false }) as never
  const expected = { asset: USDC.address, payer: PAYER, payTo: PAYEE, amount: 10_000n }

  test('only a successful transaction that moved exactly the price from payer to payee counts', () => {
    expect(verifySettlement({ status: 'success', logs: [log(USDC.address, PAYER, PAYEE, 10_000n)] }, expected)).toBe(true)
    expect(verifySettlement({ status: 'reverted', logs: [log(USDC.address, PAYER, PAYEE, 10_000n)] }, expected)).toBe(false)
    expect(verifySettlement({ status: 'success', logs: [log(USDC.address, PAYER, PAYEE, 9_999n)] }, expected)).toBe(false)
    expect(verifySettlement({ status: 'success', logs: [log(USDC.address, PAYER, '0x5555555555555555555555555555555555555555', 10_000n)] }, expected)).toBe(false)
    expect(verifySettlement({ status: 'success', logs: [log('0x2222222222222222222222222222222222222222', PAYER, PAYEE, 10_000n)] }, expected)).toBe(false)
    expect(verifySettlement({ status: 'success', logs: [] }, expected)).toBe(false)
  })
})

test('the app targets Arc Mainnet', () => {
  expect(ARC_TARGET.network).toBe(`eip155:${ARC_CHAIN_ID}`)
  expect(ARC_TARGET.asset).toBe(USDC.address)
})
