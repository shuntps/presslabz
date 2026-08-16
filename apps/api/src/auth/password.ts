import { hash, verify } from '@node-rs/argon2'

/**
 * Algorithm.Argon2id. Passed as a literal because the library exports
 * `Algorithm` as a `const enum`, which cannot be imported under
 * `verbatimModuleSyntax`. Argon2id also happens to be the library default,
 * but setting it implicitly would silently downgrade every stored password
 * if that default ever changed — the tests assert the digest really is
 * argon2id rather than trusting either the constant or the default.
 */
const ARGON2ID = 2

/**
 * OWASP's Argon2id baseline: 19 MiB of memory, two iterations, no
 * parallelism. Memory cost is what makes GPU cracking expensive, so it is the
 * parameter to raise first if these are ever revisited.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS)
}

/**
 * Returns false rather than throwing on a malformed digest. A corrupted row
 * should deny access, not surface a 500 that tells an attacker the account
 * exists.
 */
export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, ARGON2_OPTIONS)
  } catch {
    return false
  }
}

/**
 * Verified against when no account matches, so that a request for an unknown
 * address costs the same as one for a known address. Without this, response
 * timing enumerates registered users.
 */
let dummyDigest: string | null = null

export async function equalizeTiming(password: string): Promise<void> {
  dummyDigest ??= await hashPassword('presslabz-timing-equalizer')
  await verifyPassword(dummyDigest, password)
}
