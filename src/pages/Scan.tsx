import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Camera, ImageUp, ScanLine, ShieldCheck, X } from 'lucide-react'
import { ConnectGate } from '@/components/ConnectGate'
import { Banner, Button, Card, PageHeader, cx } from '@/components/ui'
import { type ScanTarget, resolveScan, sendReviewLink } from '@/lib/paymentQr'
import { navigate } from '@/lib/router'
import { CAMERA_MESSAGES, cameraBlocked, cameraProblem, openCamera, readFrame } from '@/lib/scanner'

type Phase = 'idle' | 'starting' | 'scanning'

const FRAME_INTERVAL_MS = 150
const CAMERA_SCAN_SIDE = 960
const PHOTO_SCAN_SIDE = 1600

function ScanContent() {
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = useRef(false)
  const frames = useRef(0)
  const manualId = useId()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState<ScanTarget | null>(null)
  const [opening, setOpening] = useState(false)
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)

  const stop = useCallback(() => {
    active.current = false
    clearTimeout(timer.current)
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
    setPhase('idle')
  }, [])

  useEffect(() => stop, [stop])

  // The camera light must never stay on in the background.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && active.current) {
        stop()
        setNotice('The camera was turned off because you left this screen. Start it again when you are ready.')
      }
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [stop])

  /** Every route ends on a screen that shows the payment first. Nothing is signed or sent from here. */
  const handle = useCallback((text: string): boolean => {
    const next = resolveScan(text)
    if (next.kind === 'send') {
      setOpening(true)
      navigate(sendReviewLink(next.address, next.amount))
    } else if (next.kind === 'pay') {
      setOpening(true)
      navigate(next.path)
    } else {
      setTarget(next)
    }
    return next.kind === 'send' || next.kind === 'pay'
  }, [])

  const finish = useCallback(
    (text: string) => {
      stop()
      handle(text)
    },
    [handle, stop],
  )

  const tick = useCallback(async function run() {
    if (!active.current) return
    const el = video.current
    const surface = canvas.current
    if (el && surface && el.readyState >= 2 && el.videoWidth > 0) {
      frames.current += 1
      try {
        // Every fourth frame also tries inverted (light on dark) codes.
        const text = await readFrame(el, surface, { maxSide: CAMERA_SCAN_SIDE, tryInverted: frames.current % 4 === 0 })
        if (text && active.current) return finish(text)
      } catch {
        // a frame that cannot be read is skipped
      }
    }
    if (active.current) timer.current = setTimeout(() => void run(), FRAME_INTERVAL_MS)
  }, [finish])

  const reset = () => {
    setError(null)
    setNotice(null)
    setTarget(null)
    setOpening(false)
  }

  const start = async () => {
    reset()
    setPhase('starting')
    try {
      if (await cameraBlocked()) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
      const media = await openCamera()
      stream.current = media
      active.current = true
      frames.current = 0
      if (video.current) {
        video.current.srcObject = media
        await video.current.play()
      }
      setPhase('scanning')
      void tick()
    } catch (err) {
      stop()
      setError(CAMERA_MESSAGES[err instanceof Error && err.name === 'UnsupportedError' ? 'unsupported' : cameraProblem(err)])
    }
  }

  const cancel = () => {
    stop()
    setNotice('Scan cancelled. You can start the camera again, choose a photo, or enter the details below.')
  }

  const fromImage = async (file: File | undefined) => {
    if (!file) return
    reset()
    try {
      const bitmap = await createImageBitmap(file)
      const surface = canvas.current
      if (!surface) throw new Error('canvas unavailable')
      const text = await readFrame(bitmap, surface, { maxSide: PHOTO_SCAN_SIDE, tryInverted: true })
      bitmap.close?.()
      if (text) finish(text)
      else setError('No QR code was found in that image. Try a sharper, closer photo with the whole code in view.')
    } catch {
      setError('That file could not be read as an image.')
    }
  }

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault()
    reset()
    setManualError(null)
    const text = manual.trim()
    if (text === '') {
      setManualError('Paste a wallet address, a payment link or an ethereum: payment request.')
      return
    }
    if (!handle(text)) setManualError(null)
  }

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <div className={cx('relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-3xl border bg-black/80', phase === 'scanning' ? 'border-accent' : 'border-line')} style={phase === 'scanning' ? { boxShadow: '0 0 40px -10px var(--accent)' } : undefined}>
          <video ref={video} playsInline muted autoPlay className={cx('size-full object-cover', phase !== 'scanning' && 'opacity-0')} aria-label="Camera preview" />
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
            <Button variant="secondary" className="flex-1" onClick={cancel}>
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

      <Card className="space-y-3">
        <form onSubmit={submitManual} className="space-y-3" noValidate>
          <label htmlFor={manualId} className="block text-sm font-semibold text-ink-2">
            Or enter it manually
          </label>
          <input
            id={manualId}
            value={manual}
            onChange={(event) => { setManual(event.target.value); setManualError(null) }}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            placeholder="0x… address, payment link or ethereum: request"
            aria-invalid={manualError ? true : undefined}
            className="min-h-12 w-full rounded-2xl border border-line bg-surface-muted px-4 font-mono text-sm text-ink outline-none transition-colors placeholder:font-sans placeholder:text-subtle focus:border-line-strong"
          />
          {manualError && <p className="text-xs text-danger" role="alert">{manualError}</p>}
          <Button type="submit" variant="secondary" className="w-full">
            Continue to payment
          </Button>
        </form>
      </Card>

      {opening && (
        <Banner tone="success" title="Payment code found">
          Opening the payment. You review everything before your wallet is asked to sign.
        </Banner>
      )}

      {notice && <Banner tone="info">{notice}</Banner>}

      {error && (
        <Banner tone="warn" title="Could not scan">
          {error}
        </Banner>
      )}

      {target?.kind === 'invalid' && (
        <Banner tone="danger" title={target.title} action={<Button variant="secondary" className="min-h-10" onClick={reset}>Scan again</Button>}>
          {target.message}
        </Banner>
      )}

      {target?.kind === 'api' && (
        <Card className="space-y-3 border-accent" aria-live="polite">
          <p className="text-sm font-semibold">This is a web link, not a wallet address</p>
          <p className="mono rounded-2xl border border-line bg-surface-muted p-3 text-xs [overflow-wrap:anywhere]">{target.url}</p>
          <p className="text-xs text-muted">If this is an API that asks for payment (x402), you can check its price and pay from your wallet. Nothing is requested from it until you choose to.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={reset}>
              Scan again
            </Button>
            <Button className="flex-[2]" onClick={() => navigate(`/payments/x402?url=${encodeURIComponent(target.url)}`)}>
              Open API payments
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
      <PageHeader title="ScanFlow" subtitle="Scan a wallet or payment QR code, then review the payment before you confirm." />
      <ConnectGate allowWrongNetwork>{() => <ScanContent />}</ConnectGate>
    </>
  )
}
