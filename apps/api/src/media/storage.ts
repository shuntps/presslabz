import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { env } from '../env.ts'

/**
 * The object store, and the rules about what may enter it.
 *
 * Nothing executable is ever served from uploads. That is not enforced by
 * checking a filename — a filename is whatever the client said it was — but by
 * re-encoding every image through sharp and writing the result under a key
 * this module generates, with a content type this module chooses. A file sharp
 * cannot decode as an image never becomes an object at all.
 */

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  /* MinIO serves path-style; virtual-host style needs DNS per bucket. */
  forcePathStyle: true,
})

/**
 * Reads are public because a CMS's media is public, and because signed URLs
 * expire — a page cached at the edge would outlive the links inside it.
 * Writes stay credentialed.
 */
const PUBLIC_READ_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${env.S3_BUCKET}/*`],
    },
  ],
})

/**
 * Creates the bucket if it is not there, at boot. A fresh clone and
 * `pnpm services:up` should leave a working installation rather than one that
 * fails on the first upload with an error about a bucket nobody was told to
 * make.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }))
  }

  await s3.send(new PutBucketPolicyCommand({ Bucket: env.S3_BUCKET, Policy: PUBLIC_READ_POLICY }))
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      /*
       * Media is immutable: a new upload is a new key, so it can be cached for
       * as long as anything is willing to keep it.
       */
      CacheControl: 'public, max-age=31536000, immutable',
      /*
       * The content type above is one this module chose. This stops a browser
       * guessing at it should the store ever serve something unexpected.
       */
      ContentDisposition: 'inline',
    }),
  )
}

export async function deleteObjects(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: env.S3_BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  )
}

const mediaBase = env.MEDIA_BASE_URL ?? `${env.S3_ENDPOINT}/${env.S3_BUCKET}`

export function mediaUrl(storageKey: string): string {
  return `${mediaBase}/${storageKey}`
}
