import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // ESM project
        include: ['src/**/*.test.js'],
        // Test environment
        environment: 'node',
    },
});
