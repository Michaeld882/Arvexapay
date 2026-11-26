import { ConnectGate } from '@/components/ConnectGate'
import { ContactsCard } from '@/components/Contacts'
import { MODULES, ModuleHero } from '@/components/payments/kit'

export default function ContactsPage() {
  return (
    <>
      <ModuleHero module={MODULES.contacts} />
      <ConnectGate allowWrongNetwork>{(address) => <ContactsCard owner={address} />}</ConnectGate>
    </>
  )
}
