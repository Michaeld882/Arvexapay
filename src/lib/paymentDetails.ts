import type { Address } from 'viem'
import { ARC_CHAIN_ID, NETWORK_NAME } from '@/chain'
import { sendLink } from '@/lib/paymentQr'
import { getShareBase } from '@/lib/share'

/** What gets shared: the address, the network and token, and a link that opens Send with this address filled in. */
export async function paymentDetailsText(address: Address): Promise<{ text: string; url: string }> {
  const base = await getShareBase()
  const url = `${base}${sendLink(address)}`
  const text = [`Pay me USDC on ${NETWORK_NAME}`, `Address: ${address}`, `Network: ${NETWORK_NAME} (chain ${ARC_CHAIN_ID})`, 'Token: USDC', `Pay link: ${url}`].join('\n')
  return { text, url }
}

