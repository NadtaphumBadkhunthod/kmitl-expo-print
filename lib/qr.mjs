import QRCode from 'qrcode'

const DEFAULT_SITE = 'https://smartcity.kmitl.ac.th'

/**
 * The reference report's QR holds a 29-character site link, which is why it looks
 * so coarse. A visitor's own result URL is ~300 characters and needs a far denser
 * symbol, so that mode drops to the lowest error correction and the page prints
 * the code larger - otherwise the modules end up too small for a phone to read.
 */
export async function buildQR(config, scannedUrl) {
  const useResult = config.qrMode === 'result'
  const text = useResult ? scannedUrl : (config.qrSite || DEFAULT_SITE)
  const dataUrl = await QRCode.toDataURL(text, {
    margin: 0,
    width: 520,
    errorCorrectionLevel: useResult ? 'L' : 'M',
  })
  return { dataUrl, big: useResult }
}
