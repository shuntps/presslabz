import sharp, { type Metadata } from 'sharp'

/**
 * Every upload is decoded and re-encoded. That is the whole security model
 * for media: the bytes that land in the bucket are ones sharp produced, not
 * ones a client sent, so an SVG carrying script, a polyglot file that is both
 * a JPEG and a zip, and anything with a payload hiding in its metadata all
 * stop here — either sharp refuses to decode it, or it emits an image and
 * nothing else.
 *
 * SVG is deliberately not accepted. It is a document format with script in it,
 * and there is no re-encoding step that makes it safe while leaving it an SVG.
 *
 * Animation is not accepted either, and that is a policy rather than an
 * oversight. The stored formats here are single images, so an animated GIF or
 * WebP would be decoded to its first frame and stored as a still — the upload
 * would appear to succeed and quietly not be what the author sent. Refusing
 * says so. Supporting animation means encoding animated AVIF and WebP and
 * deciding what a poster frame is, which is a feature, not a flag.
 */

/** What a client may hand over. The stored formats are chosen below. */
const ACCEPTED_INPUT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
] as const

/** 20 MB. Larger than any sane article image, small enough to bound memory. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/**
 * The other size limit, and the one that matters for memory.
 *
 * A byte count bounds the download; it says nothing about what the bytes
 * decode to. A few hundred kilobytes of PNG can describe a gigapixel canvas —
 * the compression ratio is unbounded, which is the whole trick of a
 * decompression bomb — and decoding one costs four bytes of memory per pixel
 * before any encoding starts. Fifty megapixels is past the largest camera
 * anybody publishes from and nowhere near enough to exhaust a server.
 */
export const MAX_INPUT_PIXELS = 50_000_000

/** The longest edge we keep. Beyond this is storage nobody looks at. */
const MAX_DIMENSION = 2560

export interface RenditionSpec {
  /** Extension and the content type it is stored under. */
  readonly extension: string
  readonly contentType: string
}

/**
 * AVIF first, WebP as the fallback that every browser in use can read. The
 * original is not kept: it is the one file guaranteed to be the largest and
 * the only one that could still be a polyglot.
 */
export const RENDITIONS = {
  avif: { extension: 'avif', contentType: 'image/avif' },
  webp: { extension: 'webp', contentType: 'image/webp' },
} as const satisfies Record<string, RenditionSpec>

export type RenditionName = keyof typeof RENDITIONS

export interface ProcessedImage {
  readonly width: number
  readonly height: number
  readonly renditions: Record<RenditionName, Buffer>
}

/** Why an image was refused, so the interface can say something useful. */
export type ImageRefusal = 'not-an-image' | 'animated' | 'too-many-pixels'

export class UnsupportedImageError extends Error {
  readonly refusal: ImageRefusal

  constructor(
    refusal: ImageRefusal = 'not-an-image',
    message = 'That file is not an image this installation accepts',
  ) {
    super(message)
    this.name = 'UnsupportedImageError'
    this.refusal = refusal
  }
}

export function isAcceptedInputType(value: string): boolean {
  return (ACCEPTED_INPUT_TYPES as readonly string[]).includes(value)
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  /*
   * failOn: 'error' rather than the default, so a truncated or malformed file
   * is refused here instead of being quietly patched up and stored.
   *
   * limitInputPixels is the guard that runs inside libvips, before this code
   * gets a say: reading the header of a bomb is cheap, and decoding one is
   * not, so the ceiling has to be known to the decoder rather than checked
   * after it has already allocated.
   */
  const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })

  let metadata: Metadata
  try {
    metadata = await source.metadata()
  } catch (error) {
    /*
     * The decoder refuses a bomb before this code sees its dimensions, which
     * is the right order — reading a header is cheap and decoding one is not.
     * The cost is that the refusal arrives as a generic failure, and telling
     * somebody their photograph "is not an image" is both wrong and
     * unactionable, so the one case worth naming is recovered from the
     * message.
     *
     * Matching on a message is fragile, and the fallback is the honest
     * behaviour rather than a crash: a libvips that changes its wording turns
     * this back into "not an image", which is where it started.
     */
    if (/pixel limit/i.test(String(error))) {
      throw new UnsupportedImageError(
        'too-many-pixels',
        `That image is larger than ${MAX_INPUT_PIXELS / 1_000_000} megapixels`,
      )
    }

    throw new UnsupportedImageError()
  }

  if (!metadata.width || !metadata.height) throw new UnsupportedImageError()
  // An SVG reaching here would be rasterised, which is not what the uploader
  // meant and not what makes it safe.
  if (metadata.format === 'svg') throw new UnsupportedImageError()

  /*
   * Checked here as well as by the decoder, so the refusal names the reason.
   * Without it the client is told "not an image" about a photograph, which is
   * both wrong and unactionable.
   */
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new UnsupportedImageError(
      'too-many-pixels',
      `That image is larger than ${MAX_INPUT_PIXELS / 1_000_000} megapixels`,
    )
  }

  /*
   * `pages` is how sharp reports a sequence — a GIF, an animated WebP, an AVIF
   * sequence. Storing the first frame of one and calling it done is the
   * silent kind of wrong: the upload succeeds and the result is not what was
   * sent.
   */
  if ((metadata.pages ?? 1) > 1) {
    throw new UnsupportedImageError(
      'animated',
      'Animated images are not supported; upload a still image or a video',
    )
  }

  /*
   * rotate() with no argument applies the EXIF orientation and then drops it.
   * Without it a portrait photograph is stored on its side, because the pixels
   * and the tag that corrects them are separate things and only one survives
   * a re-encode.
   */
  const normalized = source.rotate().resize({
    width: MAX_DIMENSION,
    height: MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  })

  const [avif, webp, resized] = await Promise.all([
    normalized.clone().avif({ quality: 55 }).toBuffer(),
    normalized.clone().webp({ quality: 80 }).toBuffer(),
    normalized.clone().toBuffer({ resolveWithObject: true }),
  ])

  return {
    width: resized.info.width,
    height: resized.info.height,
    renditions: { avif, webp },
  }
}
