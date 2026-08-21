import { env } from '../src/env.ts'
import {
  deliveryCheckUrl,
  mediaDelivery,
  provisionStorage,
  StorageProvisioningError,
} from '../src/media/storage.ts'

/**
 * Prepares the object store, once, the way `db:migrate` prepares the database.
 *
 * This is the only place in PressLabz that creates a bucket or writes a
 * policy. The API used to do both at every start, which made an ordinary
 * restart an infrastructure write and meant the credentials the server runs
 * with had to keep permissions it needed exactly once. The running server
 * calls `HeadBucket`, `PutObject` and `DeleteObjects`; nothing it does needs
 * `CreateBucket` or `PutBucketPolicy` any more.
 *
 * Safe to run again: it creates nothing that is there, rewrites no policy it
 * did not write, and ends with the same check object it started with.
 */
try {
  const result = await provisionStorage()

  console.warn(
    result.created
      ? `Created bucket "${env.S3_BUCKET}".`
      : `Bucket "${env.S3_BUCKET}" already exists; its policy was left alone.`,
  )

  if (result.policyApplied) {
    console.warn('Applied the minimal public-read policy to the bucket it just created.')
  }

  console.warn(
    mediaDelivery === 'direct'
      ? `Readers fetch media from the store itself, and ${deliveryCheckUrl()} answers without credentials.`
      : `MEDIA_BASE_URL is set, so readers fetch from ${env.MEDIA_BASE_URL} and this command wrote no policy — the bucket's own access is yours to decide. Point that base at this bucket before serving: /health checks it on every call, and reports the instance degraded until it answers.`,
  )
} catch (error) {
  if (error instanceof StorageProvisioningError) {
    /*
     * The whole point of the class: an operator gets the sentence that says
     * what to do, not a stack trace through the AWS SDK.
     */
    console.error(error.message)
    process.exitCode = 1
  } else {
    throw error
  }
}
