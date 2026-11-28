/**
 * Reading QR codes from camera frames and photos. Uses the browser's own QR detector when it has one (fast and
 * reliable on Android Chrome) and the bundled jsQR decoder everywhere else (iPhone Safari, desktop Firefox).
 */

interface DetectedCode {
  rawValue: string
}
interface QrDetector {
  detect: (source: ImageBitmapSource) => Promise<DetectedCode[]>
}
type DetectorConstructor = (new (options: { formats: string[] }) => QrDetector) & { getSupportedFormats?: () => Promise<string[]> }

let nativeDetector: Promise<QrDetector | undefined> | undefined

/** The browser's QR detector, or undefined when it is missing or cannot read QR codes. */
function native(): Promise<QrDetector | undefined> {
  nativeDetector ??= (async () => {
    const Detector = (globalThis as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
    if (!Detector) return undefined
    try {
      const formats = (await Detector.getSupportedFormats?.()) ?? ['qr_code']
      return formats.includes('qr_code') ? new Detector({ formats: ['qr_code'] }) : undefined
    } catch {
      return undefined
    }
  })()
  return nativeDetector
}

/** Reads a QR code from pixels. The jsQR decoder is only loaded when it is needed. */
export async function decodeImageData(data: ImageData, tryInverted = false): Promise<string | null> {
  const { default: jsQR } = await import('jsqr')
  return jsQR(data.data, data.width, data.height, { inversionAttempts: tryInverted ? 'attemptBoth' : 'dontInvert' })?.data ?? null
}

/**
 * Reads one camera frame or photo. `surface` is a scratch canvas. Returns the decoded text, or null when no QR
 * code is visible in this frame.
 */
export async function readFrame(source: CanvasImageSource & { width?: number; height?: number }, surface: HTMLCanvasElement, options: { maxSide: number; tryInverted?: boolean }): Promise<string | null> {
  const width = (source as HTMLVideoElement).videoWidth || (source as ImageBitmap).width || 0
  const height = (source as HTMLVideoElement).videoHeight || (source as ImageBitmap).height || 0
  if (!width || !height) return null

  const detector = await native()
  if (detector) {
    try {
      const found = await detector.detect(source)
      const text = found.find((code) => code.rawValue)?.rawValue
      if (text) return text
    } catch {
      // fall through to the bundled decoder
    }
  }

  const scale = Math.min(1, options.maxSide / Math.max(width, height))
  surface.width = Math.max(1, Math.round(width * scale))
  surface.height = Math.max(1, Math.round(height * scale))
  const context = surface.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('canvas unavailable')
  context.drawImage(source, 0, 0, surface.width, surface.height)
  return decodeImageData(context.getImageData(0, 0, surface.width, surface.height), options.tryInverted)
}

export type CameraProblem = 'denied' | 'missing' | 'busy' | 'insecure' | 'unsupported' | 'failed'

export function cameraProblem(err: unknown): CameraProblem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'missing'
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy'
  if (name === 'SecurityError') return 'insecure'
  return 'failed'
}

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  denied: 'Camera permission was denied. Allow camera access for this site in your browser settings and try again, or choose a photo of the QR code, or enter the payment details below.',
  missing: 'No camera was found on this device. You can choose a photo of the QR code or enter the payment details below.',
  busy: 'The camera is being used by another app or tab. Close it and try again.',
  insecure: 'Camera access needs a secure (https) connection. You can choose a photo of the QR code or enter the payment details below.',
  unsupported: 'This browser does not allow camera access here. Use https in a current browser, or choose a photo of the QR code, or enter the payment details below.',
  failed: 'The camera could not be started. You can try again, choose a photo of the QR code, or enter the payment details below.',
}

/** Opens the rear camera when there is one. Falls back to any camera when the constraints cannot be met. */
export async function openCamera(): Promise<MediaStream> {
  if (!globalThis.isSecureContext && globalThis.location?.hostname !== 'localhost') throw Object.assign(new Error('insecure'), { name: 'SecurityError' })
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'UnsupportedError' })
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
  } catch (err) {
    if (err instanceof Error && err.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    throw err
  }
}

/** True when the browser has already been told to refuse the camera for this site (no prompt can appear). */
export async function cameraBlocked(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' })
    return status?.state === 'denied'
  } catch {
    return false
  }
}
