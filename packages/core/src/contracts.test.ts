import { LOCALES } from '@presslabz/i18n'
import { THEME_PREFERENCES } from '@presslabz/tokens/preferences'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, type Capability, capabilitiesFor, ROLES } from './capabilities.ts'
import { sessionResponseSchema, sessionUserSchema } from './contracts.ts'

/*
 * The session response is the one body the admin used to take on trust, so
 * these tests are about the two halves of that: everything the product
 * declares gets through, and everything else is refused rather than reaching
 * React as a `string` standing in for a domain value.
 *
 * The vocabularies are iterated rather than listed. A role added to `ROLES`
 * and forgotten here would otherwise be a value the schema refuses and no
 * test mentions.
 */

const valid = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'someone@presslabz.test',
  displayName: 'Someone',
  role: 'administrator',
  locale: 'en',
  themePreference: 'system',
  capabilities: ['content:read'],
} as const

describe('the session user contract', () => {
  it.each(ROLES)('accepts the role %s', (role) => {
    expect(sessionUserSchema.parse({ ...valid, role }).role).toBe(role)
  })

  it.each(LOCALES)('accepts the interface language %s', (locale) => {
    expect(sessionUserSchema.parse({ ...valid, locale }).locale).toBe(locale)
  })

  it.each(THEME_PREFERENCES)('accepts the theme preference %s', (themePreference) => {
    expect(sessionUserSchema.parse({ ...valid, themePreference }).themePreference).toBe(
      themePreference,
    )
  })

  it.each([
    ['role', 'superuser'],
    ['role', 'Administrator'],
    ['locale', 'de'],
    ['locale', 'en-GB'],
    ['themePreference', 'auto'],
    ['themePreference', 'Dark'],
  ])('refuses %s = %s', (field, value) => {
    expect(sessionUserSchema.safeParse({ ...valid, [field]: value }).success).toBe(false)
  })

  /*
   * Case and whitespace are not corrected. A schema that trimmed or
   * lowercased would make the admin accept a value the CHECK constraints in
   * the database refuse, and the two ends would disagree about the same row.
   */
  it('does not repair a value that is nearly right', () => {
    expect(sessionUserSchema.safeParse({ ...valid, locale: ' en' }).success).toBe(false)
    expect(sessionUserSchema.safeParse({ ...valid, role: 'AUTHOR' }).success).toBe(false)
  })

  it('refuses a missing field rather than defaulting it', () => {
    const { themePreference, ...withoutTheme } = valid
    expect(sessionUserSchema.safeParse(withoutTheme).success).toBe(false)
  })

  it('refuses a null where a string belongs', () => {
    expect(sessionUserSchema.safeParse({ ...valid, displayName: null }).success).toBe(false)
  })

  it('refuses an empty display name, which no account has', () => {
    expect(sessionUserSchema.safeParse({ ...valid, displayName: '' }).success).toBe(false)
  })

  it('refuses capabilities that are not strings', () => {
    expect(sessionUserSchema.safeParse({ ...valid, capabilities: [1] }).success).toBe(false)
  })

  /*
   * The capability list is a closed catalogue like the three fields above it.
   * As `z.array(z.string())` this accepted `made:up` and handed it to the
   * admin as something to decide a control from — a name no build declares, a
   * check nothing can ever satisfy, and a control that stays hidden with
   * nothing anywhere saying why.
   */
  it.each(CAPABILITIES)('accepts the capability %s', (capability) => {
    expect(sessionUserSchema.parse({ ...valid, capabilities: [capability] }).capabilities).toEqual([
      capability,
    ])
  })

  it('accepts the whole catalogue at once', () => {
    const parsed = sessionUserSchema.parse({ ...valid, capabilities: [...CAPABILITIES] })
    expect(parsed.capabilities).toHaveLength(CAPABILITIES.length)
  })

  it('accepts an account that holds none', () => {
    expect(sessionUserSchema.parse({ ...valid, capabilities: [] }).capabilities).toEqual([])
  })

  it.each(['made:up', 'content:destroy', 'CONTENT:READ', 'content:read '])(
    'refuses the unknown capability %s',
    (capability) => {
      expect(sessionUserSchema.safeParse({ ...valid, capabilities: [capability] }).success).toBe(
        false,
      )
    },
  )

  it('refuses a list where only one entry is unknown', () => {
    const capabilities = ['content:read', 'made:up', 'media:read']
    expect(sessionUserSchema.safeParse({ ...valid, capabilities }).success).toBe(false)
  })

  /*
   * What the API actually sends, for every role, rather than a list written
   * here. A capability added to a bundle and not to the catalogue would be a
   * payload the client refuses, and this is where that is caught.
   */
  it.each(ROLES)('accepts everything the bundle for %s holds', (role) => {
    const capabilities = [...capabilitiesFor(role)]
    expect(sessionUserSchema.safeParse({ ...valid, role, capabilities }).success).toBe(true)
  })

  /*
   * The inferred type is `Capability[]`, not `string[]`. A screen asking about
   * a name no build declares stops compiling instead of hiding a control for
   * ever. Asserted by assignment: this file would not typecheck if the element
   * type were wider.
   */
  it('infers the catalogue as the element type', () => {
    const parsed = sessionUserSchema.parse({ ...valid, capabilities: ['content:read'] })
    const first: Capability | undefined = parsed.capabilities[0]
    expect(first).toBe('content:read')
  })
})

describe('the session response contract', () => {
  it('accepts the envelope the API sends', () => {
    expect(sessionResponseSchema.parse({ user: valid }).user.email).toBe(valid.email)
  })

  it('refuses a bare user, which is not what any route answers', () => {
    expect(sessionResponseSchema.safeParse(valid).success).toBe(false)
  })

  it('refuses an envelope holding a user it would refuse on its own', () => {
    expect(sessionResponseSchema.safeParse({ user: { ...valid, role: 'root' } }).success).toBe(
      false,
    )
  })
})
