import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'fir', // The prefix that will output in your mudfarer console stream
    environment: 'node',
    include: ['*.test.js']
  }
})