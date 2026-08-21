import { hasIntegrationEnv } from '@presslabz/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Provisioning, against a store that can actually refuse.
 *
 * The unit suite proves which commands are sent. This proves the part a fake
 * cannot: that the policy written to a new bucket really does let an anonymous
 * reader fetch an object, that a policy already on a bucket survives being
 * provisioned over, and that a credential without the right to change a policy
 * is not a credential this command needs.
 *
 * Every test makes its own bucket and drops it, so none of them depends on
 * having run after another, and the developer's own bucket is never touched.
 */
const ready = hasIntegrationEnv()

let storage: typeof import('./storage.ts')
let sdk: typeof import('@aws-sdk/client-s3')
let admin: import('@aws-sdk/client-s3').S3Client
/** Read, Write, List, Tagging — and no Admin, so no policy may be written. */
let limited: import('@aws-sdk/client-s3').S3Client
/** Read and List only: the store answers it, and refuses every write. */
let readonly: import('@aws-sdk/client-s3').S3Client
let counter = 0
const made: string[] = []

/**
 * The key the read-only test attempts, named here so teardown can remove it
 * whether or not the write was refused.
 *
 * If a regression ever lets that write through, the assertion fails — as it
 * should — and the object exists. Deleting only the check key would then leave
 * the bucket non-empty, `DeleteBucket` would refuse it, and one honest failure
 * would leave litter behind in every run afterwards.
 */
const REFUSED_WRITE_KEY = 'media/never-written.txt'

function client(accessKeyId: string, secretAccessKey: string) {
  return new sdk.S3Client({
    endpoint: process.env.S3_ENDPOINT as string,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
}

/** A name nothing else in this run uses. */
function bucketName(): string {
  counter += 1
  const name = `presslabz-provision-${process.pid.toString(36)}-${counter}`
  made.push(name)
  return name
}

function checkUrlFor(name: string): string {
  return `${process.env.S3_ENDPOINT}/${name}/${storage.DELIVERY_CHECK_KEY}`
}

async function policyOf(name: string): Promise<string> {
  const answer = await admin.send(new sdk.GetBucketPolicyCommand({ Bucket: name }))
  return String(answer.Policy)
}

describe.skipIf(!ready)('provisioning a real object store', () => {
  beforeAll(async () => {
    storage = await import('./storage.ts')
    sdk = await import('@aws-sdk/client-s3')
    admin = client(
      process.env.S3_ACCESS_KEY_ID as string,
      process.env.S3_SECRET_ACCESS_KEY as string,
    )
    limited = client('presslabz-runtime', 'presslabz-runtime-secret')
    readonly = client('presslabz-readonly', 'presslabz-readonly-secret')
  }, 60_000)

  afterAll(async () => {
    for (const name of made) {
      await admin
        .send(
          new sdk.DeleteObjectsCommand({
            Bucket: name,
            Delete: {
              Objects: [{ Key: storage.DELIVERY_CHECK_KEY }, { Key: REFUSED_WRITE_KEY }],
            },
          }),
        )
        .catch(() => {})
      await admin.send(new sdk.DeleteBucketCommand({ Bucket: name })).catch(() => {})
    }
    admin.destroy()
    limited.destroy()
    readonly.destroy()
  })

  it('creates a bucket a reader can actually read from', async () => {
    const bucket = bucketName()

    const result = await storage.provisionStorage({
      client: admin,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    expect(result).toMatchObject({ created: true, policyApplied: true })

    // Not the SDK's opinion — an unsigned request, like a browser makes.
    const response = await fetch(checkUrlFor(bucket), { cache: 'no-store' })
    expect(response.status).toBe(200)
    await response.body?.cancel()
  })

  /*
   * The defect in one assertion. A policy an operator put there has to still
   * be there afterwards, byte for byte — not "an equivalent one", which is
   * what a rewrite would leave behind.
   */
  it('leaves an existing policy exactly as it found it', async () => {
    const bucket = bucketName()
    await storage.provisionStorage({
      client: admin,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    const theirs = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'WrittenByTheOperator',
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
      ],
    })

    await admin.send(new sdk.PutBucketPolicyCommand({ Bucket: bucket, Policy: theirs }))
    const before = await policyOf(bucket)

    await storage.provisionStorage({
      client: admin,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    expect(await policyOf(bucket)).toBe(before)
    expect(await policyOf(bucket)).toContain('WrittenByTheOperator')
  })

  /*
   * The question the running server asks at every health check, and the whole
   * reason it no longer creates anything: a bucket that is not there has to
   * come back as *missing* and still not be there afterwards.
   */
  it('reports a bucket that is not there without creating one', async () => {
    const absent = `presslabz-absent-${process.pid.toString(36)}`

    expect(await storage.bucketStateOf(admin, absent)).toBe('missing')

    const listed = await admin.send(new sdk.ListBucketsCommand({}))
    expect((listed.Buckets ?? []).map((entry) => entry.Name)).not.toContain(absent)
  })

  /*
   * A credential that may read, write and list but not change a policy is the
   * ordinary shape of a runtime account — and provisioning an existing bucket
   * with it has to work, because there is no policy to write. That this
   * credential genuinely cannot write one is asserted rather than assumed.
   */
  it('needs no policy permission for a bucket that already exists', async () => {
    const bucket = bucketName()
    await storage.provisionStorage({
      client: admin,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    const refused = limited.send(
      new sdk.PutBucketPolicyCommand({ Bucket: bucket, Policy: await policyOf(bucket) }),
    )
    await expect(refused).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } })

    await expect(
      storage.provisionStorage({
        client: limited,
        bucket,
        delivery: 'direct',
        checkUrl: checkUrlFor(bucket),
      }),
    ).resolves.toMatchObject({ created: false, policyApplied: false })
  })

  /*
   * The limit of the health contract, pinned so nobody re-derives the claim
   * that was removed from it.
   *
   * `bucketState` answering `present` means the store answered this credential
   * and nothing more. Below, the same credential that produces `present` is
   * refused its very first write — so an installation can be reported `up`,
   * accept an upload from an author, spend the re-encode and fail at the
   * store. That is a **known and accepted** limit of `/health`, not a defect
   * this test is waiting to have fixed: verifying a write means performing
   * one, and `/health` deliberately writes nothing.
   */
  it('answers present for a credential that cannot write, which is why up never claims uploads', async () => {
    const bucket = bucketName()
    await storage.provisionStorage({
      client: admin,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    expect(await storage.bucketStateOf(readonly, bucket)).toBe('present')

    await expect(
      readonly.send(
        new sdk.PutObjectCommand({ Bucket: bucket, Key: REFUSED_WRITE_KEY, Body: 'x' }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } })
  })

  /*
   * And the message an operator gets when provisioning runs as that credential
   * must not tell them something about a different identity. `storage:init`
   * may be run with a privileged account while the server serves with a narrow
   * one; what a refused PutObject proves is only about the account it was
   * given.
   */
  it('blames only the identity it was given when a write is refused', async () => {
    const bucket = bucketName()
    await storage.provisionStorage({
      client: admin,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    const refusal = storage.provisionStorage({
      client: readonly,
      bucket,
      delivery: 'direct',
      checkUrl: checkUrlFor(bucket),
    })

    await expect(refusal).rejects.toBeInstanceOf(storage.StorageProvisioningError)
    await expect(refusal).rejects.toThrow(/identity given to this command/)
    await expect(refusal).rejects.toThrow(/refused the permission/)
  })

  it('is idempotent against the real store', async () => {
    const bucket = bucketName()
    const options = {
      client: admin,
      bucket,
      delivery: 'direct' as const,
      checkUrl: checkUrlFor(bucket),
    }

    await storage.provisionStorage(options)
    const second = await storage.provisionStorage(options)
    const third = await storage.provisionStorage(options)

    expect(second).toEqual(third)
    expect(second).toMatchObject({ created: false, policyApplied: false })
  })
})
