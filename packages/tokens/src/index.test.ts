import { describe, expect, it } from 'vitest'
import {
  isThemePreference,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
} from './index.ts'

/**
 * THEME_INIT_SCRIPT is a static literal on purpose, so nothing enforces at
 * compile time that it still matches the constants. These tests do.
 */
describe('THEME_INIT_SCRIPT', () => {
  it('reads the same storage key the rest of the module writes', () => {
    expect(THEME_INIT_SCRIPT).toContain(`"${THEME_STORAGE_KEY}"`)
  })

  it('sets the same attribute the stylesheet selects on', () => {
    expect(THEME_INIT_SCRIPT).toContain(`"${THEME_ATTRIBUTE}"`)
  })

  it('never writes "system" as an attribute value', () => {
    // 'system' means "no attribute". Writing it would freeze the page on
    // whatever the OS preferred at load time.
    expect(THEME_INIT_SCRIPT).not.toContain('system')
  })

  it('builds no code from interpolated values', () => {
    expect(THEME_INIT_SCRIPT).not.toContain('${')
  })
})

describe('resolveTheme', () => {
  it('passes an explicit choice through unchanged', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('follows the system preference only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('isThemePreference', () => {
  it('accepts the three supported states', () => {
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isThemePreference('auto')).toBe(false)
    expect(isThemePreference(null)).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
  })
})
