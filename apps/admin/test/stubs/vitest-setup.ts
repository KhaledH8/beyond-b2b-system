import { cleanup } from '@testing-library/react';
import { expect, afterEach } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// RTL doesn't auto-cleanup in vitest without globalThis.afterEach;
// run cleanup explicitly after every test.
afterEach(cleanup);
