import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * jsdom, not a real browser. It catches what a real browser would for
     * state and rendering — which is the class of fault that has actually
     * shipped from here — without adding a browser download to every CI run.
     * Layout and CORS are checked elsewhere: the first by driving a real
     * browser during development, the second by the API's own suite.
     */
    environment: 'jsdom',
    globals: false,
    restoreMocks: true,
  },
})
