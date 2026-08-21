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
 * Where readers actually fetch media from, which is what decides everything
 * else in this file.
 *
 * `direct` — `MEDIA_BASE_URL` is unset, so a reader's browser asks the object
 * store itself for `S3_ENDPOINT/S3_BUCKET/key`. The bucket has to serve
 * anonymous reads or the site has no images.
 *
 * `external` — `MEDIA_BASE_URL` names a delivery base in front of the store.
 * What that is — a CDN, a reverse proxy, an edge that signs its own origin
 * requests — is the operator's business, and so is the bucket's policy. This
 * installation writes objects and says nothing about who may read them.
 *
 * Deliberately not called "cdn": the variable guarantees an external base, not
 * a technology.
 */
export type MediaDelivery = 'direct' | 'external'

export const mediaDelivery: MediaDelivery = env.MEDIA_BASE_URL ? 'external' : 'direct'

/**
 * The minimal public-read policy, for a bucket this installation created
 * itself and serves directly. Reads only, and only of objects — a policy that
 * granted anything else would be one an operator has to audit.
 */
function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  })
}

/**
 * One small object whose only job is to be fetched the way a reader fetches an
 * image.
 *
 * `HeadBucket` proves that the store answers this credential. It proves
 * nothing about writing and nothing about reading — those are three different
 * permissions on any store worth the name. Asking for a known object over the
 * real public URL is the only answer about readers that is not a guess.
 *
 * Fixed key, fixed bytes, no information in it. `no-store` because a cached
 * 200 would keep answering after the policy that allowed it was removed, which
 * is precisely the failure this exists to notice.
 */
export const DELIVERY_CHECK_KEY = 'media/delivery-check.txt'
const DELIVERY_CHECK_BODY = 'presslabz delivery check\n'

/** What a HEAD on the bucket actually told us. */
export type BucketState = 'present' | 'missing' | 'denied' | 'erroring' | 'unreachable'

/**
 * Asks whether the bucket is there, and tells the ways of hearing no apart:
 * `missing`, `denied`, `erroring`, `unreachable`.
 *
 * `catch {}` treated every failure as "not there" and answered by trying to
 * create it: a wrong key, an expired token or a store that was simply down all
 * produced a `CreateBucket` that could not work either, and the error an
 * operator finally saw was about creating a bucket rather than about the
 * credential or the network. The three are different problems with different
 * fixes, and only one of them is ours to repair.
 */
export async function bucketState(): Promise<BucketState> {
  return bucketStateOf(s3, env.S3_BUCKET)
}

/** The same question, asked of a client and a bucket a caller chose. */
export async function bucketStateOf(client: S3Client, bucket: string): Promise<BucketState> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    return 'present'
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode

    /*
     * No status means nothing answered: DNS, TLS, a refused connection, a
     * timeout.
     */
    if (status === undefined) return 'unreachable'

    if (status === 404) return 'missing'

    /*
     * S3 answers 301 for a bucket in another region, which is a configuration
     * fault and not an absence — grouped with denied, since both are "the
     * store is there and will not serve you this bucket".
     */
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) return 'denied'

    /*
     * A 5xx is the store failing, not the store refusing, and calling it
     * `denied` sent an operator to check credentials that were never the
     * problem. Anything else unexpected joins it rather than being filed as a
     * refusal it is not.
     */
    return 'erroring'
  }
}

/**
 * Why a reader could not fetch an object, when they could not.
 *
 * Four answers rather than a boolean, because they are four different jobs:
 * `forbidden` is a policy or an access block, `missing` is an object that is
 * not there — most often this installation never ran `storage:init` — and
 * `unreachable` is the network or a base that is down. `unexpected` carries
 * the status, so a 500 from a proxy is not silently filed as one of the other
 * three.
 *
 * None of this reaches `/health`. It is what the log says.
 */
export type DeliveryFailure = 'forbidden' | 'missing' | 'unreachable' | 'unexpected'

export type DeliveryOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: DeliveryFailure; readonly status?: number }

/**
 * Fetches a URL the way a reader's browser would: no credentials, no
 * signature, nothing this process knows.
 */
export async function checkDelivery(url: string, timeoutMs: number): Promise<DeliveryOutcome> {
  let response: Response

  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    // A timeout, a refused connection, DNS, TLS. Nothing answered.
    return { ok: false, cause: 'unreachable' }
  }

  // Nothing wants the bytes, and an unread body holds the socket open.
  await response.body?.cancel()

  if (response.ok) return { ok: true }
  if (response.status === 403) return { ok: false, cause: 'forbidden', status: 403 }
  if (response.status === 404) return { ok: false, cause: 'missing', status: 404 }
  return { ok: false, cause: 'unexpected', status: response.status }
}

/**
 * What the log says about a delivery failure, in a sentence with a next step.
 *
 * The next step depends on where readers are being sent. A 404 from the store
 * itself has one plausible cause and one fix — the check object was never
 * written, so run the installation command. A 404 from a delivery base in
 * front of the store has at least five, and naming only the first would send
 * an operator to run a command that changes nothing.
 */
export function deliveryFailureMessage(
  url: string,
  outcome: DeliveryOutcome,
  delivery: MediaDelivery = mediaDelivery,
): string {
  if (outcome.ok) return `${url} is readable without credentials`

  switch (outcome.cause) {
    case 'forbidden':
      return delivery === 'direct'
        ? `${url} answered 403 to an anonymous request: readers get errors instead of images. Allow public reads of the media prefix on the bucket, or set MEDIA_BASE_URL to a base that serves them.`
        : `${url} answered 403 to an anonymous request: readers get errors instead of images. The delivery base named by MEDIA_BASE_URL is refusing, which is its own configuration rather than the bucket's — check how it authorises requests to its origin.`
    case 'missing':
      return delivery === 'direct'
        ? `${url} answered 404: the delivery check object is not in the bucket. Run \`pnpm storage:init\` against this installation.`
        : `${url} answered 404. Any of these would do it: MEDIA_BASE_URL points somewhere else, the base prefixes paths differently from the bucket, its origin is not connected to this bucket, the object has not propagated yet, or \`pnpm storage:init\` was never run. Fetching the same key straight from the store tells you which half is wrong.`
    case 'unreachable':
      return `${url} did not answer at all within the health check budget: the media delivery base is down or unroutable from this instance.`
    default:
      return `${url} answered ${outcome.status} to an anonymous request, which is neither success nor a refusal this can interpret.`
  }
}

/** Refused for a reason an operator can act on, rather than a stack trace. */
export class StorageProvisioningError extends Error {}

/**
 * How a provisioning command failed, told apart rather than all called a
 * refusal.
 *
 * "Was refused" for a connection that never opened sends an operator to audit
 * an access policy while the store is simply down. Four answers, because they
 * are four different next steps: a permission to grant, a network to fix, a
 * store to wait for or restart, and a status nothing here can interpret.
 */
function failureNarrative(error: unknown): string {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  const name = (error as { name?: string }).name ?? 'error'

  if (status === undefined) {
    return `Nothing answered (${name}): the endpoint is unreachable from here — network, DNS, TLS or a timeout.`
  }
  if (status === 401 || status === 403) {
    return `The store refused the permission (${name}, ${status}).`
  }
  if (status >= 500) {
    return `The store answered ${status} (${name}), which is the store failing rather than refusing.`
  }
  return `The store answered ${status} (${name}), which is neither success nor a refusal.`
}

/**
 * Sends one provisioning command, and turns a failure into a sentence.
 *
 * An operational failure here — no permission, public access blocked, a name
 * somebody else owns, a store that is down — is expected input, not a defect,
 * and a stack trace through the AWS SDK tells the person reading it nothing
 * they can act on. The status and the SDK's own error name are kept because
 * they are diagnostic; the request, its headers and anything signed are not,
 * because they are not.
 */
async function step(
  client: S3Client,
  command: object,
  attempt: string,
  advice: string,
): Promise<void> {
  try {
    await client.send(command as Parameters<S3Client['send']>[0])
  } catch (error) {
    throw new StorageProvisioningError(
      `${attempt} did not succeed. ${failureNarrative(error)} ${advice}`,
    )
  }
}

export interface ProvisionOptions {
  readonly client?: S3Client
  readonly bucket?: string
  readonly delivery?: MediaDelivery
  readonly checkUrl?: string
  /** Injected so provisioning can be asserted without an object store. */
  readonly checkDelivery?: (url: string) => Promise<DeliveryOutcome>
}

export interface ProvisionResult {
  readonly created: boolean
  readonly policyApplied: boolean
  readonly delivery: MediaDelivery
  readonly checkKey: string
}

/**
 * Brings the object store to the state this installation needs, once.
 *
 * This is an installation step, next to `db:migrate`, and it is the only code
 * in PressLabz that creates a bucket or writes a policy. It used to run at
 * every API start, and outside the branch that had created anything: a server
 * coming back from a restart re-sent a complete `PutBucketPolicy` over
 * whatever an operator had put there. That also meant the credentials the
 * server runs with needed `CreateBucket` and `PutBucketPolicy` for the life of
 * the installation, to do something it should do once.
 *
 * What it will and will not do:
 *
 * - A missing bucket is created, and — in direct delivery only — given the
 *   minimal public-read policy, because a bucket this command just made is one
 *   nothing else owns yet.
 * - An existing bucket keeps its policy. Always. If it will not serve readers,
 *   this fails and says so; replacing an operator's policy to make an error
 *   go away is not a repair.
 * - With `MEDIA_BASE_URL` set, no policy is written at all and nothing is
 *   concluded about the bucket's own readability. Readers do not go there.
 *
 * Idempotent: run it twice and the second run creates nothing, writes no
 * policy, and rewrites the same check object with the same bytes.
 */
export async function provisionStorage(options: ProvisionOptions = {}): Promise<ProvisionResult> {
  const client = options.client ?? s3
  const bucket = options.bucket ?? env.S3_BUCKET
  const delivery = options.delivery ?? mediaDelivery

  const state = await bucketStateOf(client, bucket)

  if (state === 'denied') {
    throw new StorageProvisioningError(
      `The object store refused the credentials for bucket "${bucket}". Nothing was created. Check S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_REGION.`,
    )
  }

  if (state === 'unreachable') {
    throw new StorageProvisioningError(
      `The object store at ${env.S3_ENDPOINT} did not answer. Nothing was created; start it and run this again.`,
    )
  }

  if (state === 'erroring') {
    throw new StorageProvisioningError(
      `The object store at ${env.S3_ENDPOINT} answered, but not with anything this can act on — it is failing rather than refusing. Nothing was created; check the store's own logs and run this again.`,
    )
  }

  const created = state === 'missing'

  if (created) {
    /*
     * `CreateBucketConfiguration` is required by every AWS region except
     * us-east-1, which refuses it — the one endpoint where naming the region
     * is an error. Stores that ignore it, which is most S3-compatible ones,
     * are unaffected either way.
     */
    await step(
      client,
      new CreateBucketCommand({
        Bucket: bucket,
        ...(env.S3_REGION === 'us-east-1'
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: env.S3_REGION as BucketLocationConstraint,
              },
            }),
      }),
      `Creating bucket "${bucket}"`,
      `The credentials given to this command need CreateBucket, or somebody has to create the bucket and run this again — an existing one is never modified.`,
    )
  }

  const policyApplied = created && delivery === 'direct'

  if (policyApplied) {
    await step(
      client,
      new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }),
      `Bucket "${bucket}" was created, but writing its public-read policy`,
      `The credentials given to this command need PutBucketPolicy, or the store blocks public access at the account level. Set the policy yourself, or set MEDIA_BASE_URL and run this again — the bucket exists now, so it will not be touched.`,
    )
  }

  await step(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: DELIVERY_CHECK_KEY,
      Body: DELIVERY_CHECK_BODY,
      ContentType: 'text/plain; charset=utf-8',
      CacheControl: 'no-store',
      ContentDisposition: 'inline',
    }),
    `Writing ${DELIVERY_CHECK_KEY} to bucket "${bucket}"`,
    `This says the identity given to this command may not write to the bucket. It says nothing about the identity the server runs with, which may be a different one — an installation is free to provision with a privileged account and serve with a narrow one.`,
  )

  /*
   * Verified here only for the delivery this command configured. With
   * MEDIA_BASE_URL set the base in front of the store is somebody else's to
   * stand up, and refusing to finish an installation because a CDN is not
   * wired yet would make provisioning depend on a thing provisioning does not
   * own. `/health` checks that base on every call; this does not.
   */
  if (delivery === 'direct') {
    const url = options.checkUrl ?? deliveryCheckUrl()
    const check = options.checkDelivery ?? ((target: string) => checkDelivery(target, 10_000))
    const outcome = await check(url).catch(
      () => ({ ok: false, cause: 'unreachable' }) as DeliveryOutcome,
    )

    if (!outcome.ok) {
      throw new StorageProvisioningError(
        created
          ? `Bucket "${bucket}" was created and given a public-read policy, but ${deliveryFailureMessage(url, outcome, delivery)} The store may block public access at the account level, which is a setting this command cannot and should not change.`
          : `Bucket "${bucket}" already exists and its policy was left exactly as it is, because this installation did not create it. ${deliveryFailureMessage(url, outcome, delivery)}`,
      )
    }
  }

  return { created, policyApplied, delivery, checkKey: DELIVERY_CHECK_KEY }
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

/**
 * Where the delivery check is fetched from — the real public URL, built the
 * same way every image URL is. Checking it any other way would be checking
 * something readers do not do.
 */
export function deliveryCheckUrl(): string {
  return mediaUrl(DELIVERY_CHECK_KEY)
}
