import { readFileSync } from 'node:fs'
import type { S3Client } from '@aws-sdk/client-s3'
import { hasIntegrationEnv } from '@presslabz/db/testing'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * What provisioning will and will not do to somebody else's bucket.
 *
 * No object store here, and none needed: every rule being asserted is about
 * which commands are sent, and a fake client records those exactly. What a
 * real store adds — that the policy works, that the check object is fetchable
 * — is asserted against a real one in storage.integration.test.ts.
 *
 * The environment gate is not about services. storage.ts imports env.ts, which
 * validates at import; the suite needs a configured environment to load at
 * all, so it is loaded after the gate has decided, exactly as orphans.test.ts
 * does.
 */
const ready = hasIntegrationEnv()

let storage: typeof import('./storage.ts')

/**
 * A client that records what was sent, and answers HeadBucket as told.
 *
 * `head` is either `present` or the HTTP status the store answers — a number,
 * not a state, because the mapping from one to the other is itself something
 * these tests are here to pin.
 */
function fakeStore(head: 'present' | number | 'silent') {
  const sent: string[] = []

  const client = {
    send: async (command: object) => {
      const name = command.constructor.name
      sent.push(name)

      if (name === 'HeadBucketCommand' && head !== 'present') {
        throw Object.assign(new Error('head'), {
          name: 'HeadFailed',
          $metadata: { httpStatusCode: head === 'silent' ? undefined : head },
        })
      }

      return {}
    },
  }

  return { sent, client: client as unknown as S3Client }
}

describe.skipIf(!ready)('provisioning the object store', () => {
  beforeAll(async () => {
    storage = await import('./storage.ts')
  })

  describe('a bucket that already exists', () => {
    /*
     * The defect this whole issue is about. `PutBucketPolicy` sat outside the
     * branch that created anything, so every API start — every restart, every
     * deploy, every test that built the app — re-sent a complete policy over
     * whatever an operator had put there.
     */
    it('never writes a policy over it', async () => {
      const { sent, client } = fakeStore('present')

      await storage.provisionStorage({
        client,
        bucket: 'theirs',
        delivery: 'direct',
        checkUrl: 'http://example.invalid/check',
        checkDelivery: async () => ({ ok: true }) as const,
      })

      expect(sent).not.toContain('PutBucketPolicyCommand')
      expect(sent).not.toContain('CreateBucketCommand')
    })

    it('refuses, rather than repairing, when it does not serve readers', async () => {
      const { sent, client } = fakeStore('present')

      const refusal = storage.provisionStorage({
        client,
        bucket: 'theirs',
        delivery: 'direct',
        checkUrl: 'http://example.invalid/check',
        checkDelivery: async () => ({ ok: false, cause: 'forbidden' }) as const,
      })

      await expect(refusal).rejects.toBeInstanceOf(storage.StorageProvisioningError)
      // The refusal must not be a policy write that happened anyway.
      expect(sent).not.toContain('PutBucketPolicyCommand')
    })

    it('says what the operator can do about it', async () => {
      const { client } = fakeStore('present')

      await expect(
        storage.provisionStorage({
          client,
          bucket: 'theirs',
          delivery: 'direct',
          checkUrl: 'http://example.invalid/check',
          checkDelivery: async () => ({ ok: false, cause: 'forbidden' }) as const,
        }),
      ).rejects.toThrow(/MEDIA_BASE_URL|allow public reads/)
    })
  })

  describe('a bucket that is not there', () => {
    it('creates it and gives it the minimal policy, in direct delivery', async () => {
      const { sent, client } = fakeStore(404)

      const result = await storage.provisionStorage({
        client,
        bucket: 'ours',
        delivery: 'direct',
        checkUrl: 'http://example.invalid/check',
        checkDelivery: async () => ({ ok: true }) as const,
      })

      expect(sent).toEqual([
        'HeadBucketCommand',
        'CreateBucketCommand',
        'PutBucketPolicyCommand',
        'PutObjectCommand',
      ])
      expect(result).toMatchObject({ created: true, policyApplied: true })
    })

    /*
     * The check object is written before the read is attempted, because there
     * is otherwise nothing to read: a bucket created one line earlier is
     * empty, and "no object" and "no permission" both answer 403 on most
     * stores.
     */
    it('writes the check object before asking whether it can be read', async () => {
      const { sent, client } = fakeStore(404)
      let sentWhenRead: string[] = []

      await storage.provisionStorage({
        client,
        bucket: 'ours',
        delivery: 'direct',
        checkUrl: 'http://example.invalid/check',
        checkDelivery: async () => {
          sentWhenRead = [...sent]
          return { ok: true } as const
        },
      })

      expect(sentWhenRead).toContain('PutObjectCommand')
    })
  })

  describe('when MEDIA_BASE_URL names a delivery base', () => {
    /*
     * Readers never touch the bucket in this mode, so its policy is the
     * operator's business — it may be entirely private behind an origin access
     * control. Writing a public-read policy here would open a bucket somebody
     * deliberately closed.
     */
    it('writes no policy, even to a bucket it creates itself', async () => {
      const { sent, client } = fakeStore(404)

      const result = await storage.provisionStorage({
        client,
        bucket: 'ours',
        delivery: 'external',
      })

      expect(sent).not.toContain('PutBucketPolicyCommand')
      expect(result).toMatchObject({ created: true, policyApplied: false })
    })

    it('concludes nothing from whether the bucket is publicly readable', async () => {
      const { client } = fakeStore('present')
      let asked = false

      await storage.provisionStorage({
        client,
        bucket: 'theirs',
        delivery: 'external',
        checkDelivery: async () => {
          asked = true
          return { ok: false, cause: 'forbidden' } as const
        },
      })

      expect(asked).toBe(false)
    })
  })

  describe('when the store will not have it', () => {
    it.for([
      ['refuses the credentials', 403],
      ['does not answer', 'silent'],
      ['is failing', 500],
    ] as const)('creates nothing and says so: %s', async ([, head]) => {
      const { sent, client } = fakeStore(head)

      await expect(
        storage.provisionStorage({ client, bucket: 'ours', delivery: 'direct' }),
      ).rejects.toBeInstanceOf(storage.StorageProvisioningError)

      expect(sent).toEqual(['HeadBucketCommand'])
    })
  })

  /*
   * Run twice, and the second run must be the first run minus everything that
   * changed anything: no create, no policy, and the same check object written
   * over itself with the same bytes.
   */
  it('is idempotent', async () => {
    const first = fakeStore(404)
    await storage.provisionStorage({
      client: first.client,
      bucket: 'ours',
      delivery: 'direct',
      checkUrl: 'http://example.invalid/check',
      checkDelivery: async () => ({ ok: true }) as const,
    })

    const second = fakeStore('present')
    const result = await storage.provisionStorage({
      client: second.client,
      bucket: 'ours',
      delivery: 'direct',
      checkUrl: 'http://example.invalid/check',
      checkDelivery: async () => ({ ok: true }) as const,
    })

    expect(first.sent).toContain('CreateBucketCommand')
    expect(second.sent).toEqual(['HeadBucketCommand', 'PutObjectCommand'])
    expect(result).toMatchObject({ created: false, policyApplied: false })
  })
})

/*
 * Read off disk rather than executed, because the property is an absence and
 * an absence cannot be observed by calling something. What is asserted is that
 * the file which builds the server names no command that changes
 * infrastructure — which is what makes "a restart writes no policy" true for
 * every restart rather than for the ones a test happened to make.
 *
 * No environment needed: this reads a file.
 */
describe('the server this application starts', () => {
  const source = readFileSync(new URL('../app.ts', import.meta.url), 'utf8')

  it.for(['provisionStorage', 'CreateBucket', 'PutBucketPolicy'])(
    'never reaches for %s',
    (name) => {
      expect(source).not.toContain(name)
    },
  )

  /* What it does still do, so this test cannot pass by the import vanishing. */
  it('still asks the store whether it is there', () => {
    expect(source).toContain('bucketState')
  })
})

/*
 * The four answers the log has to tell apart. A 403 is a policy, a 404 is an
 * installation that never ran storage:init, nothing at all is a base that is
 * down, and anything else is a proxy doing something none of those describe —
 * four different next steps, and "not readable" was one word for all of them.
 */
describe.skipIf(!ready)('reading the check object as a reader would', () => {
  beforeAll(async () => {
    storage = await import('./storage.ts')
  })

  const served = (status: number) => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(status === 200 ? 'ok' : '', { status })) as typeof fetch
    return () => {
      globalThis.fetch = original
    }
  }

  it.for([
    [200, { ok: true }],
    [403, { ok: false, cause: 'forbidden', status: 403 }],
    [404, { ok: false, cause: 'missing', status: 404 }],
    [502, { ok: false, cause: 'unexpected', status: 502 }],
  ] as const)('reports %i as its own thing', async ([status, expected]) => {
    const restore = served(status)
    try {
      expect(await storage.checkDelivery('http://example.invalid/check', 1_000)).toEqual(expected)
    } finally {
      restore()
    }
  })

  it('reports nothing answering as unreachable', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch

    try {
      expect(await storage.checkDelivery('http://example.invalid/check', 1_000)).toEqual({
        ok: false,
        cause: 'unreachable',
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it.for([
    ['forbidden', /403|public reads|MEDIA_BASE_URL/],
    ['missing', /storage:init/],
    ['unreachable', /did not answer/],
    ['unexpected', /neither success nor a refusal/],
  ] as const)('says what to do about %s', ([cause, expected]) => {
    const message = storage.deliveryFailureMessage('http://example.invalid/check', {
      ok: false,
      cause,
      status: 500,
    })

    expect(message).toMatch(expected)
  })
})

/*
 * Which HTTP status means what. A 5xx used to come back as `denied`, which
 * sent an operator to audit credentials that were never the problem while the
 * store was simply failing.
 */
describe.skipIf(!ready)('what a HEAD on the bucket is taken to mean', () => {
  beforeAll(async () => {
    storage = await import('./storage.ts')
  })

  it.for([
    ['it is there', 'present', 'present'],
    ['no such bucket', 404, 'missing'],
    ['the credentials are refused', 403, 'denied'],
    ['the token is not accepted', 401, 'denied'],
    ['the bucket is in another region', 301, 'denied'],
    ['the store is failing', 500, 'erroring'],
    ['the store is overloaded', 503, 'erroring'],
    ['nothing answered', 'silent', 'unreachable'],
  ] as const)('%s', async ([, head, expected]) => {
    const { sent, client } = fakeStore(head)

    expect(await storage.bucketStateOf(client, 'whichever')).toBe(expected)
    // Whatever the answer, asking must not have changed anything.
    expect(sent).toEqual(['HeadBucketCommand'])
  })
})

/*
 * A 404 has one plausible cause when readers fetch from the bucket, and at
 * least five when they fetch from a base in front of it. Naming only the first
 * sent an operator to run a command that changes nothing.
 */
describe.skipIf(!ready)('what the log advises, per delivery mode', () => {
  beforeAll(async () => {
    storage = await import('./storage.ts')
  })

  const missing = { ok: false, cause: 'missing', status: 404 } as const
  const forbidden = { ok: false, cause: 'forbidden', status: 403 } as const

  it('sends a direct installation to storage:init', () => {
    const message = storage.deliveryFailureMessage('http://store/check', missing, 'direct')

    expect(message).toMatch(/storage:init/)
    expect(message).toMatch(/not in the bucket/)
  })

  it('does not tell an external installation that storage:init is the fix', () => {
    const message = storage.deliveryFailureMessage('http://cdn/check', missing, 'external')

    expect(message).toMatch(/MEDIA_BASE_URL points somewhere else/)
    expect(message).toMatch(/propagated/)
    // It may still be one of the causes — it must not be stated as the cause.
    expect(message).not.toMatch(/^.*Run `pnpm storage:init`/)
  })

  it('blames the bucket policy directly, and the base externally', () => {
    expect(storage.deliveryFailureMessage('http://store/check', forbidden, 'direct')).toMatch(
      /public reads of the media prefix on the bucket/,
    )
    expect(storage.deliveryFailureMessage('http://cdn/check', forbidden, 'external')).toMatch(
      /delivery base named by MEDIA_BASE_URL is refusing/,
    )
  })
})
