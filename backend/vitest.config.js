import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // ESM project
        include: ['src/**/*.test.js'],
        // Test environment
        environment: 'node',
        // 逐文件 DB 隔离：每个 worker 指向独立临时空库（见 vitest.setup.js）
        setupFiles: ['./vitest.setup.js'],
    },
});
