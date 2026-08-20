import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { MAX_INPUT_PIXELS, processImage, UnsupportedImageError } from './process.ts'

/**
 * What the pipeline refuses, and why it says so.
 *
 * Every one of these used to be accepted or mislabelled. The comment above
 * `processImage` claimed animated images were rejected and only SVG was, so an
 * animation was decoded to its first frame and stored as a still — an upload
 * that appeared to succeed and was not what the author sent. And a
 * decompression bomb was refused by the decoder with a message that reached
 * the client as "that file is not an image", about a file that is.
 */

/**
 * Eighty-five bytes of real GIF89a: two frames, a Netscape loop block, one
 * pixel each. Written out rather than generated, because sharp in this version
 * will not encode a multi-page image, and a fixture that cannot be built is
 * one the test cannot rely on.
 */
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
)

async function still(width = 24, height = 18): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer()
}

async function refusalOf(input: Buffer): Promise<string> {
  try {
    await processImage(input)
    return 'accepted'
  } catch (error) {
    return error instanceof UnsupportedImageError ? error.refusal : `unexpected: ${error}`
  }
}

describe('what the pipeline accepts', () => {
  it('re-encodes a still image into both renditions', async () => {
    const processed = await processImage(await still())

    expect(processed.width).toBe(24)
    expect(processed.height).toBe(18)
    expect(processed.renditions.avif.byteLength).toBeGreaterThan(0)
    expect(processed.renditions.webp.byteLength).toBeGreaterThan(0)
  })
})

describe('what it refuses, and what it says', () => {
  /*
   * The stored formats are single images. Keeping the first frame of an
   * animation and calling the upload done is the silent kind of wrong.
   */
  it('refuses an animation rather than storing one frame of it', async () => {
    expect(
      await sharp(ANIMATED_GIF)
        .metadata()
        .then((m) => m.pages),
    ).toBe(2)
    expect(await refusalOf(ANIMATED_GIF)).toBe('animated')
  })

  it('accepts a still image of the same format', async () => {
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .gif()
      .toBuffer()

    expect(await refusalOf(gif)).toBe('accepted')
  })

  /*
   * A byte count bounds the download and says nothing about what the bytes
   * decode to: this header claims nine hundred megapixels in a few hundred
   * bytes, which is the whole trick. It is refused from the header, before
   * anything allocates four bytes per pixel.
   */
  it('refuses a header that claims more pixels than it will decode', async () => {
    const bomb = Buffer.from(await still(4, 4))
    bomb.writeUInt32BE(30_000, 16)
    bomb.writeUInt32BE(30_000, 20)

    expect(30_000 * 30_000).toBeGreaterThan(MAX_INPUT_PIXELS)
    expect(await refusalOf(bomb)).toBe('too-many-pixels')
  })

  it('refuses an SVG, which no re-encoding makes safe', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')

    expect(await refusalOf(svg)).toBe('not-an-image')
  })

  it('refuses something that is not an image at all', async () => {
    expect(await refusalOf(Buffer.from('#!/bin/sh\necho hello\n'))).toBe('not-an-image')
  })
})
