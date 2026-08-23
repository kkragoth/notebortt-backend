import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        setupFiles: ['./test/setup.ts'],
        include: ['test/**/*.test.ts'],
        env: {
            LOG_LEVEL: 'warn',
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
