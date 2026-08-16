import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  canActOnResource,
  capabilitiesFor,
  isCapability,
  isRole,
  ROLES,
  roleHasCapability,
} from './capabilities.ts'

describe('role bundles', () => {
  it('grants strictly more as the role widens', () => {
    const sets = ROLES.map((role) => capabilitiesFor(role))
    for (let i = 1; i < sets.length; i++) {
      const narrower = sets[i - 1]
      const wider = sets[i]
      expect(narrower, `${ROLES[i - 1]} vs ${ROLES[i]}`).toBeDefined()
      for (const capability of narrower ?? []) {
        expect(wider?.has(capability), `${ROLES[i]} should keep ${capability}`).toBe(true)
      }
    }
  })

  it('gives a subscriber no way to write anything', () => {
    const caps = capabilitiesFor('subscriber')
    for (const capability of caps) {
      expect(capability.startsWith('content:read') || capability.startsWith('media:read')).toBe(
        true,
      )
    }
  })

  it('lets only an administrator manage users, settings and plugins', () => {
    for (const role of ROLES) {
      const expected = role === 'administrator'
      expect(roleHasCapability(role, 'users:manage'), role).toBe(expected)
      expect(roleHasCapability(role, 'settings:manage'), role).toBe(expected)
      expect(roleHasCapability(role, 'plugins:manage'), role).toBe(expected)
    }
  })

  it('does not let a contributor publish', () => {
    expect(roleHasCapability('contributor', 'content:publish')).toBe(false)
    expect(roleHasCapability('author', 'content:publish')).toBe(true)
  })

  it('references no capability outside the declared list', () => {
    for (const role of ROLES) {
      for (const capability of capabilitiesFor(role)) {
        expect(CAPABILITIES, `${role} grants unknown ${capability}`).toContain(capability)
      }
    }
  })
})

describe('canActOnResource', () => {
  const alice = 'a'
  const bob = 'b'

  it('lets an author edit their own document but not another', () => {
    expect(canActOnResource('author', 'update', alice, alice)).toBe(true)
    expect(canActOnResource('author', 'update', alice, bob)).toBe(false)
  })

  it('lets an editor edit anyone', () => {
    expect(canActOnResource('editor', 'update', alice, bob)).toBe(true)
    expect(canActOnResource('editor', 'delete', alice, bob)).toBe(true)
  })

  it('refuses a subscriber outright', () => {
    expect(canActOnResource('subscriber', 'update', alice, alice)).toBe(false)
  })

  it('refuses an orphaned document to an "own only" role', () => {
    // ownerId null means the author was deleted; nobody "owns" it any more.
    expect(canActOnResource('author', 'delete', alice, null)).toBe(false)
    expect(canActOnResource('editor', 'delete', alice, null)).toBe(true)
  })

  it('refuses an anonymous actor even when the owner is also null', () => {
    expect(canActOnResource('author', 'update', null, null)).toBe(false)
  })
})

describe('guards', () => {
  it('accepts declared values and rejects everything else', () => {
    expect(isRole('editor')).toBe(true)
    expect(isRole('superadmin')).toBe(false)
    expect(isCapability('content:publish')).toBe(true)
    expect(isCapability('content:everything')).toBe(false)
    expect(isCapability(null)).toBe(false)
  })
})
