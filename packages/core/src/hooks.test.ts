import { describe, expect, it, vi } from 'vitest'
import { createHooks, type HookFailure } from './hooks.ts'

interface Actions extends Record<string, unknown> {
  'thing:happened': { readonly id: string }
}

interface Filters extends Record<string, unknown> {
  'thing:name': { readonly name: string }
}

function hooksWithFailures(timeoutMs?: number) {
  const failures: HookFailure[] = []
  const hooks = createHooks<Actions, Filters>({
    onFailure: (failure) => failures.push(failure),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  return { hooks, failures }
}

describe('actions', () => {
  it('tells every handler what happened', async () => {
    const { hooks } = hooksWithFailures()
    const seen: string[] = []

    hooks.action('thing:happened', (payload) => {
      seen.push(`a:${payload.id}`)
    })
    hooks.action('thing:happened', async (payload) => {
      seen.push(`b:${payload.id}`)
    })

    await hooks.emit('thing:happened', { id: '1' })

    expect(seen.sort()).toEqual(['a:1', 'b:1'])
  })

  it('starts them in priority order, then registration order', async () => {
    const { hooks } = hooksWithFailures()
    const started: string[] = []

    hooks.action('thing:happened', () => void started.push('default'))
    hooks.action('thing:happened', () => void started.push('late'), { priority: 20 })
    hooks.action('thing:happened', () => void started.push('early'), { priority: 1 })
    hooks.action('thing:happened', () => void started.push('default-two'))

    await hooks.emit('thing:happened', { id: '1' })

    expect(started).toEqual(['early', 'default', 'default-two', 'late'])
  })

  /*
   * The rule the whole design rests on: by the time an action runs, the write
   * has landed. A handler that throws has failed at its own job, and telling
   * the author their work was lost would be a lie.
   */
  it('is not allowed to fail the operation that caused it', async () => {
    const { hooks, failures } = hooksWithFailures()
    let reached = false

    hooks.action('thing:happened', () => {
      throw new Error('the integration is down')
    })
    hooks.action('thing:happened', () => {
      reached = true
    })

    await expect(hooks.emit('thing:happened', { id: '1' })).resolves.toBeUndefined()

    expect(reached).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ hook: 'thing:happened', kind: 'action' })
  })

  it('is not allowed to hang the request either', async () => {
    const { hooks, failures } = hooksWithFailures(20)

    hooks.action('thing:happened', () => new Promise(() => {}), { label: 'never-answers' })

    await hooks.emit('thing:happened', { id: '1' })

    expect(failures).toHaveLength(1)
    expect(failures[0]?.label).toBe('never-answers')
    expect(String((failures[0] as HookFailure).error)).toContain('timed out')
  })

  it('stops telling a handler that unregistered', async () => {
    const { hooks } = hooksWithFailures()
    const handler = vi.fn()

    const off = hooks.action('thing:happened', handler)
    await hooks.emit('thing:happened', { id: '1' })
    off()
    await hooks.emit('thing:happened', { id: '2' })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('costs nothing when nobody is listening', async () => {
    const { hooks } = hooksWithFailures()
    await expect(hooks.emit('thing:happened', { id: '1' })).resolves.toBeUndefined()
  })
})

describe('filters', () => {
  it('passes the value through the chain, in order', async () => {
    const { hooks } = hooksWithFailures()

    hooks.filter('thing:name', (value) => ({ name: `${value.name}-second` }), { priority: 20 })
    hooks.filter('thing:name', (value) => ({ name: `${value.name}-first` }), { priority: 1 })

    const result = await hooks.apply('thing:name', { name: 'start' })

    expect(result.name).toBe('start-first-second')
  })

  it('awaits an asynchronous handler', async () => {
    const { hooks } = hooksWithFailures()

    hooks.filter('thing:name', async (value) => ({ name: value.name.toUpperCase() }))

    expect((await hooks.apply('thing:name', { name: 'quiet' })).name).toBe('QUIET')
  })

  /*
   * One broken extension must not blank a page. The value it was handed
   * stands, the chain carries on, and the failure is reported to whoever is
   * watching rather than to the reader.
   */
  it('keeps the value when a handler throws, and carries on', async () => {
    const { hooks, failures } = hooksWithFailures()

    hooks.filter('thing:name', () => {
      throw new Error('bad plugin')
    })
    hooks.filter('thing:name', (value) => ({ name: `${value.name}!` }), { priority: 20 })

    const result = await hooks.apply('thing:name', { name: 'kept' })

    expect(result.name).toBe('kept!')
    expect(failures[0]).toMatchObject({ kind: 'filter' })
  })

  /*
   * A filter that returns nothing has forgotten to return. Taking it at its
   * word would replace a document with undefined.
   */
  it('refuses a handler that returns nothing', async () => {
    const { hooks, failures } = hooksWithFailures()

    hooks.filter('thing:name', (() => undefined) as never)

    expect((await hooks.apply('thing:name', { name: 'intact' })).name).toBe('intact')
    expect(String((failures[0] as HookFailure).error)).toContain('returned nothing')
  })

  it('returns the value untouched when nothing is registered', async () => {
    const { hooks } = hooksWithFailures()
    expect(await hooks.apply('thing:name', { name: 'as-is' })).toEqual({ name: 'as-is' })
  })
})

describe('what is registered', () => {
  it('can be counted, for a diagnostics page and for a test', () => {
    const { hooks } = hooksWithFailures()

    hooks.action('thing:happened', () => {})
    hooks.action('thing:happened', () => {})
    hooks.filter('thing:name', (value) => value)

    expect(hooks.registered()).toEqual({ 'thing:happened': 2, 'thing:name': 1 })
  })
})
