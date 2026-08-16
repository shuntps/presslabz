import { describe, expect, it } from 'vitest'
import { type Capability, capabilitiesFor } from './capabilities.ts'
import { canEditMedia, canPerformOnMedia } from './media.ts'

const alice = 'a'
const bob = 'b'

const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
  capabilities: capabilitiesFor(role),
  id,
})

describe('canEditMedia', () => {
  it('lets an author describe what they uploaded', () => {
    expect(canEditMedia(actor('author'), { uploadedById: alice })).toBe(true)
  })

  it('refuses an author somebody else’s upload', () => {
    /*
     * The hole this closes: media:upload used to guard the metadata route, so
     * every author could rewrite the alt text on every asset in the library —
     * a photograph being recaptioned under the person who took it.
     */
    expect(canEditMedia(actor('author'), { uploadedById: bob })).toBe(false)
  })

  it('lets an editor describe anything', () => {
    expect(canEditMedia(actor('editor'), { uploadedById: bob })).toBe(true)
    expect(canEditMedia(actor('administrator'), { uploadedById: bob })).toBe(true)
  })

  it('refuses a contributor, who may not put anything in the library either', () => {
    expect(canEditMedia(actor('contributor'), { uploadedById: alice })).toBe(false)
    expect(canEditMedia(actor('subscriber'), { uploadedById: alice })).toBe(false)
  })

  it('treats an asset with no uploader as needing the global capability', () => {
    /*
     * uploadedById is set to null when the account goes. Reading "owned by
     * nobody" as "owned by whoever is asking" would hand every orphaned asset
     * to every author, which is the opposite of what the column now says.
     */
    expect(canEditMedia(actor('author'), { uploadedById: null })).toBe(false)
    expect(canEditMedia(actor('editor'), { uploadedById: null })).toBe(true)
  })

  it('does not match an anonymous actor against an unowned asset', () => {
    const anonymous = { capabilities: capabilitiesFor('author'), id: null }
    expect(canEditMedia(anonymous, { uploadedById: null })).toBe(false)
  })

  it('needs the capability, not the ownership alone', () => {
    const owner = { capabilities: new Set<Capability>(['media:read']), id: alice }
    expect(canEditMedia(owner, { uploadedById: alice })).toBe(false)
  })
})

describe('the other media operations', () => {
  it('keeps uploading separate from editing', () => {
    // An author holds both; the point is that they are two capabilities, so
    // one can be revoked without the other.
    const uploaderOnly = { capabilities: new Set<Capability>(['media:upload']), id: alice }
    expect(canPerformOnMedia('upload', uploaderOnly)).toBe(true)
    expect(canPerformOnMedia('update', uploaderOnly, { uploadedById: alice })).toBe(false)
  })

  it('keeps deletion global, because an asset a document uses is not only its uploader’s', () => {
    expect(canPerformOnMedia('delete', actor('author'), { uploadedById: alice })).toBe(false)
    expect(canPerformOnMedia('delete', actor('editor'), { uploadedById: alice })).toBe(true)
  })

  it('lets every signed-in role read the library', () => {
    expect(canPerformOnMedia('read', actor('subscriber'))).toBe(true)
  })
})
