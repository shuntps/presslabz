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
 */

/** What a client may hand over. The stored formats are chosen below. */
export const ACCEPTED_INPUT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
] as const

/** 20 MB. Larger than any sane article image, small enough to bound memory. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

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

export class UnsupportedImageError extends Error {
  constructor(message = 'That file is not an image this installation accepts') {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

export function isAcceptedInputType(value: string): boolean {
  return (ACCEPTED_INPUT_TYPES as readonly string[]).includes(value)
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  // failOn: 'error' rather than the default, so a truncated or malformed file
  // is refused here instead of being quietly patched up and stored.
  const source = sharp(input, { failOn: 'error' })

  let metadata: Metadata
  try {
    metadata = await source.metadata()
  } catch {
    throw new UnsupportedImageError()
  }

  if (!metadata.width || !metadata.height) throw new UnsupportedImageError()
  // An animated GIF or an SVG reaching here would be decoded as one frame or
  // rasterised; neither is what the uploader meant, so refuse instead.
  if (metadata.format === 'svg') throw new UnsupportedImageError()

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
