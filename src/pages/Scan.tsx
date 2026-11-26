import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, ImageUp, ScanLine, ShieldCheck, X } from 'lucide-react'
import { ConnectGate } from '@/components/ConnectGate'
import { Banner, Button, Card, PageHeader, cx } from '@/components/ui'
import { contactFor, useContacts } from '@/lib/contacts'
import { type PaymentQr, parsePaymentQr, sendLink } from '@/lib/paymentQr'
import { navigate } from '@/lib/router'

type Phase = 'idle' | 'starting' | 'scanning'

const MAX_SCAN_WIDTH = 640

function cameraMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Camera permission was denied. Allow camera access in your browser settings, or choose a photo of the QR code instead.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. You can choose a photo of the QR code instead.'
  if (name === 'NotReadableError') return 'The camera is being used by another app. Close it and try again.'
  if (name === 'SecurityError') return 'Camera access needs a secure (https) connection.'
  return 'The camera could not be started. You can choose a photo of the QR code instead.'
}

/** Reads a QR code from pixels. The decoder is loaded only when scanning starts. */
async function decode(data: ImageData): Promise<string | null> {
  const { default: jsQR } = await import('jsqr')
  return jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' })?.data ?? null
}

function ScanContent({ owner }: { owner: string }) {
  const contacts = useContacts(owner)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = useRef(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PaymentQr | null>(null)

  const stop = useCallback(() => {
    active.current = false
    clearTimeout(timer.current)
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
    setPhase('idle')
  }, [])

  useEffect(() => stop, [stop])

  const finish = useCallback(
    (text: string) => {
      stop()
      setResult(parsePaymentQr(text))
    },
    [stop],
  )

  const tick = useCallback(async function run() {
    if (!active.current) return
    const el = video.current
    const surface = canvas.current
    if (el && surface && el.readyState >= 2 && el.videoWidth > 0) {
      const scale = Math.min(1, MAX_SCAN_WIDTH / el.videoWidth)
      surface.width = Math.round(el.videoWidth * scale)
      surface.height = Math.round(el.videoHeight * scale)
      const context = surface.getContext('2d', { willReadFrequently: true })
      if (context) {
        context.drawImage(el, 0, 0, surface.width, surface.height)
        const text = await decode(context.getImageData(0, 0, surface.width, surface.height))
        if (text && active.current) return finish(text)
      }
    }
    if (active.current) timer.current = setTimeout(() => void run(), 150)
  }, [finish])

  const start = async () => {
    setError(null)
    setResult(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser or connection does not allow camera access. Use https, or choose a photo of the QR code instead.')
      return
    }
    setPhase('starting')
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      stream.current = media
      active.current = true
      if (video.current) {
        video.current.srcObject = media
        await video.current.play()
      }
      setPhase('scanning')
      void tick()
    } catch (err) {
      stop()
      setError(cameraMessage(err))
    }
  }

  const fromImage = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setResult(null)
    try {
      const bitmap = await createImageBitmap(file)
      const surface = canvas.current
      const context = surface?.getContext('2d', { willReadFrequently: true })
      if (!surface || !context) throw new Error('canvas unavailable')
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
      surface.width = Math.round(bitmap.width * scale)
      surface.height = Math.round(bitmap.height * scale)
      context.drawImage(bitmap, 0, 0, surface.width, surface.height)
      const text = await decode(context.getImageData(0, 0, surface.width, surface.height))
      if (text) finish(text)
      else setError('No QR code was found in that image. Try a sharper, closer photo.')
    } catch {
      setError('That file could not be read as an image.')
    }
  }

  const saved = result?.ok ? contactFor(contacts, result.address) : undefined

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <div className={cx('relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-3xl border bg-black/80', phase === 'scanning' ? 'border-accent' : 'border-line')} style={phase === 'scanning' ? { boxShadow: '0 0 40px -10px var(--accent)' } : undefined}>
          <video ref={video} playsInline muted className={cx('size-full object-cover', phase !== 'scanning' && 'opacity-0')} aria-label="Camera preview" />
          <canvas ref={canvas} className="hidden" />
          {phase !== 'scanning' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white/80">
              <ScanLine className="size-12 text-accent" aria-hidden />
              <p className="text-sm">{phase === 'starting' ? 'Starting the camera…' : 'Point your camera at a payment QR code.'}</p>
            </div>
          )}
          {phase === 'scanning' && (
            <>
              <span aria-hidden className="absolute inset-6 rounded-2xl border-2 border-white/60" />
              <span aria-hidden className="scan-sweep absolute inset-x-6 h-0.5 rounded-full bg-accent shadow-[0_0_14px_var(--accent)]" />
            </>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {phase === 'scanning' ? (
            <Button variant="secondary" className="flex-1" onClick={stop}>
              <X className="size-4" aria-hidden />
              Stop camera
            </Button>
          ) : (
            <Button className="flex-1" loading={phase === 'starting'} onClick={() => void start()}>
              <Camera className="size-4" aria-hidden />
              Start camera
            </Button>
          )}
          <label className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-line bg-transparent px-4 text-sm font-semibold text-ink-2 transition-colors hover:bg-surface-muted">
            <ImageUp className="size-4" aria-hidden />
            Choose a photo
            <input type="file" accept="image/*" className="sr-only" onChange={(event) => { void fromImage(event.target.files?.[0]); event.target.value = '' }} />
          </label>
        </div>
        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
          <ShieldCheck className="size-3.5" aria-hidden />
          Scanning happens on your device. Nothing is paid until you review and confirm in your wallet.
        </p>
      </Card>

      {error && (
        <Banner tone="warn" title="Could not scan">
          {error}
        </Banner>
      )}

      {result && !result.ok && (
        <Banner tone="danger" title="Not a valid payment code" action={<Button variant="secondary" className="min-h-10" onClick={() => setResult(null)}>Scan again</Button>}>
          {result.message}
        </Banner>
      )}

      {result?.ok && (
        <Card className="space-y-3 border-accent" aria-live="polite">
          <p className="text-sm font-semibold text-success">Payment code found</p>
          <div className="rounded-2xl border border-line bg-surface-muted p-3">
            <p className="text-xs text-muted">Pay to{saved ? ` (saved as ${saved.name})` : ''}</p>
            <p className="mono mt-1 text-sm [overflow-wrap:anywhere]">{result.address}</p>
            {result.amount && <p className="mt-2 text-sm font-semibold tabular-nums">{result.amount} USDC requested</p>}
          </div>
          <p className="text-xs text-muted">Check the address matches what you expect. You will review the full payment on the next screen before your wallet is asked to sign.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setResult(null)}>
              Scan again
            </Button>
            <Button className="flex-[2]" onClick={() => navigate(sendLink(result.address, result.amount))}>
              Continue to Send
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}

export default function Scan() {
  return (
    <>
      <PageHeader title="Scan" subtitle="Scan a wallet or payment QR code, then review the payment before you confirm." />
      <ConnectGate allowWrongNetwork>{(address) => <ScanContent owner={address} />}</ConnectGate>
    </>
  )
}
