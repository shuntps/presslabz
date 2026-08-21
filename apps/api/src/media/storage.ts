import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { resolveMediaBase, mediaUrl as sharedMediaUrl } from '@presslabz/core'
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

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  /* The dev store serves path-style; virtual-host style needs DNS per bucket. */
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

/** What a HEAD on the bucket actually told us. */
export type BucketState = 'present' | 'missing' | 'denied' | 'unreachable'

/**
 * Asks whether the bucket is there, and distinguishes the three ways of
 * hearing no.
 *
 * `catch {}` treated every failure as "not there" and answered by trying to
 * create it: a wrong key, an expired token or a store that was simply down all
 * produced a `CreateBucket` that could not work either, and the error an
 * operator finally saw was about creating a bucket rather than about the
 * credential or the network. The three are different problems with different
 * fixes, and only one of them is ours to repair.
 */
export async function bucketState(): Promise<BucketState> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
    return 'present'
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

    if (status === 404) return 'missing'
    if (status === 401 || status === 403) return 'denied'

    /*
     * No status means nothing answered: DNS, TLS, a refused connection, a
     * timeout. S3 answers 301 for a bucket in another region, which is a
     * configuration fault and not an absence — grouped with denied, since both
     * are "the store is there and will not serve you".
     */
    return status === undefined ? 'unreachable' : 'denied'
  }
}

/**
 * Creates the bucket if it is not there, at boot. A fresh clone and
 * `pnpm services:up` should leave a working installation rather than one that
 * fails on the first upload with an error about a bucket nobody was told to
 * make.
 *
 * Only a *missing* bucket is created. A refusal and an outage are reported as
 * themselves, because creating a bucket is not the answer to either.
 */
export async function ensureBucket(): Promise<void> {
  const state = await bucketState()

  if (state === 'denied') {
    throw new Error(
      `The object store refused the credentials for bucket "${env.S3_BUCKET}". Check S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_REGION.`,
    )
  }

  if (state === 'unreachable') {
    throw new Error(
      `The object store at ${env.S3_ENDPOINT} did not answer. Nothing was created; media uploads will fail until it does.`,
    )
  }

  if (state === 'missing') {
    /*
     * `CreateBucketConfiguration` is required by every AWS region except
     * us-east-1, which refuses it — the one endpoint where naming the region
     * is an error. Stores that ignore it, which is most S3-compatible ones,
     * are unaffected either way.
     */
    await s3.send(
      new CreateBucketCommand({
        Bucket: env.S3_BUCKET,
        ...(env.S3_REGION === 'us-east-1'
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: env.S3_REGION as BucketLocationConstraint,
              },
            }),
      }),
    )
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

/*
 * Resolved in packages/core, because the public site has to build the same URL
 * for the same asset: one host here and another there is a broken image that
 * only shows up in production.
 */
const mediaBase = resolveMediaBase({
  mediaBaseUrl: env.MEDIA_BASE_URL,
  s3Endpoint: env.S3_ENDPOINT,
  s3Bucket: env.S3_BUCKET,
})

export function mediaUrl(storageKey: string): string {
  return sharedMediaUrl(mediaBase, storageKey)
}
