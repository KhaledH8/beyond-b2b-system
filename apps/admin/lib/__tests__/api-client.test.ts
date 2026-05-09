import { describe, expect, it, vi } from 'vitest';
import {
  ApiConflictError,
  ApiForbiddenError,
  ApiNetworkError,
  ApiNotFoundError,
  ApiServerError,
  ApiUnauthorizedError,
  ApiValidationError,
  apiFetch,
  type ApiFetchOptions,
} from '../api-client';

/**
 * ADR-029 step 3 — apiFetch unit tests.
 *
 * Override-injection seam (getAccessToken / fetch / apiBaseUrl)
 * keeps every test hermetic. Real SDK + real fetch never run.
 *
 * Status mapping is the load-bearing surface; one test per HTTP
 * code (400, 401, 403, 404, 409, 500, network). Plus the
 * structural rules: cache: 'no-store' is hard-coded, content-type
 * appears only with a body, requestId is propagated when valid +
 * regenerated when missing/invalid, and the module is fenced
 * server-only.
 */

const VALID_API = 'http://localhost:3000';
const VALID_TOKEN = 'access.token.value';
const VALID_REQ_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

interface MakeFetchOpts {
  status?: number;
  body?: unknown;
  bodyText?: string;
  contentLength?: string;
  throws?: Error;
}

function makeFetch(opts: MakeFetchOpts = { status: 200, body: { ok: true } }): {
  fn: ReturnType<typeof vi.fn>;
} {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit): Promise<Response> => {
      if (opts.throws) throw opts.throws;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (opts.contentLength !== undefined) {
        headers.set('content-length', opts.contentLength);
      }
      const text =
        opts.bodyText ?? (opts.body !== undefined ? JSON.stringify(opts.body) : '');
      return new Response(text === '' ? null : text, {
        status: opts.status ?? 200,
        headers,
      });
    },
  );
  return { fn };
}

function defaults(
  overrides: Partial<ApiFetchOptions> = {},
): ApiFetchOptions {
  return {
    getAccessToken: vi.fn(async () => VALID_TOKEN),
    fetch: makeFetch().fn as unknown as typeof fetch,
    apiBaseUrl: VALID_API,
    ...overrides,
  };
}

// ── Bearer + token retrieval ───────────────────────────────────────────

describe('apiFetch — bearer + token retrieval', () => {
  it('A — attaches Authorization: Bearer <token>', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/me', defaults({ fetch: fn as unknown as typeof fetch }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${VALID_TOKEN}`);
  });

  it('B — calls getAccessToken once per request', async () => {
    const tokenFn = vi.fn(async () => VALID_TOKEN);
    await apiFetch('GET', '/me', defaults({ getAccessToken: tokenFn }));
    expect(tokenFn).toHaveBeenCalledTimes(1);
  });

  it('C — maps a thrown getAccessToken to ApiUnauthorizedError', async () => {
    await expect(
      apiFetch(
        'GET',
        '/me',
        defaults({
          getAccessToken: vi.fn(async () => {
            throw new Error('SDK token error');
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(ApiUnauthorizedError);
  });

  it('D — maps an empty token to ApiUnauthorizedError', async () => {
    await expect(
      apiFetch(
        'GET',
        '/me',
        defaults({ getAccessToken: vi.fn(async () => '') }),
      ),
    ).rejects.toBeInstanceOf(ApiUnauthorizedError);
  });
});

// ── cache: 'no-store' is hard-coded ────────────────────────────────────

describe('apiFetch — cache policy', () => {
  it('E — sets cache: "no-store" on every request', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/me', defaults({ fetch: fn as unknown as typeof fetch }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.cache).toBe('no-store');
  });

  it('F — callers cannot override cache (no `cache` option exposed)', async () => {
    // The ApiFetchOptions type does not expose `cache`. Pass an
    // object that includes it via `as unknown` and confirm the
    // outbound init.cache is still 'no-store'.
    const fn = makeFetch().fn;
    const sneaky = { cache: 'force-cache', fetch: fn } as unknown as ApiFetchOptions;
    await apiFetch('GET', '/me', { ...defaults(), ...sneaky });
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.cache).toBe('no-store');
  });
});

// ── Body / content-type behaviour ──────────────────────────────────────

describe('apiFetch — body + content-type', () => {
  it('G — sets Content-Type: application/json when body is provided', async () => {
    const fn = makeFetch().fn;
    await apiFetch('POST', '/things', defaults({
      fetch: fn as unknown as typeof fetch,
      body: { name: 'thing-1' },
    }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'thing-1' }));
  });

  it('H — does NOT set Content-Type when no body is provided', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/me', defaults({ fetch: fn as unknown as typeof fetch }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('I — JSON-stringifies non-trivial body values (null / 0 are honoured)', async () => {
    const fn = makeFetch().fn;
    await apiFetch('POST', '/things', defaults({
      fetch: fn as unknown as typeof fetch,
      body: null,
    }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('null');
  });
});

// ── Status mapping ─────────────────────────────────────────────────────

describe('apiFetch — status → typed error mapping', () => {
  it('J — 400 with JSON body → ApiValidationError carrying bodyJson', async () => {
    const body = { errors: [{ field: 'reason', message: 'required' }] };
    try {
      await apiFetch(
        'POST',
        '/things',
        defaults({
          fetch: makeFetch({ status: 400, body }).fn as unknown as typeof fetch,
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      expect((err as ApiValidationError).bodyJson).toEqual(body);
      expect((err as ApiValidationError).status).toBe(400);
    }
  });

  it('K — 400 with non-JSON body → ApiValidationError with bodyJson undefined', async () => {
    try {
      await apiFetch(
        'POST',
        '/things',
        defaults({
          fetch: makeFetch({ status: 400, bodyText: 'plain text error' })
            .fn as unknown as typeof fetch,
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      expect((err as ApiValidationError).bodyJson).toBeUndefined();
    }
  });

  it('L — 401 → ApiUnauthorizedError', async () => {
    await expect(
      apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ status: 401 }).fn as unknown as typeof fetch,
      })),
    ).rejects.toBeInstanceOf(ApiUnauthorizedError);
  });

  it('M — 403 → ApiForbiddenError', async () => {
    await expect(
      apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ status: 403 }).fn as unknown as typeof fetch,
      })),
    ).rejects.toBeInstanceOf(ApiForbiddenError);
  });

  it('N — 404 → ApiNotFoundError', async () => {
    await expect(
      apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ status: 404 }).fn as unknown as typeof fetch,
      })),
    ).rejects.toBeInstanceOf(ApiNotFoundError);
  });

  it('O — 409 → ApiConflictError', async () => {
    await expect(
      apiFetch('POST', '/x', defaults({
        fetch: makeFetch({ status: 409 }).fn as unknown as typeof fetch,
      })),
    ).rejects.toBeInstanceOf(ApiConflictError);
  });

  it('P — 500 → ApiServerError with status', async () => {
    try {
      await apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ status: 500 }).fn as unknown as typeof fetch,
      }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiServerError);
      expect((err as ApiServerError).status).toBe(500);
    }
  });

  it('Q — 503 → ApiServerError with status', async () => {
    try {
      await apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ status: 503 }).fn as unknown as typeof fetch,
      }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiServerError);
      expect((err as ApiServerError).status).toBe(503);
    }
  });

  it('R — fetch throws → ApiNetworkError', async () => {
    try {
      await apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ throws: new Error('ECONNREFUSED') })
          .fn as unknown as typeof fetch,
      }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiNetworkError);
      // ES2022 Error.cause attached
      expect((err as ApiNetworkError & { cause?: unknown }).cause).toBeInstanceOf(
        Error,
      );
    }
  });
});

// ── Empty / 204 body handling ──────────────────────────────────────────

describe('apiFetch — empty / 204 bodies', () => {
  it('S — 204 No Content returns undefined', async () => {
    const result = await apiFetch(
      'DELETE',
      '/x',
      defaults({
        fetch: makeFetch({ status: 204, bodyText: '' })
          .fn as unknown as typeof fetch,
      }),
    );
    expect(result).toBeUndefined();
  });

  it('T — 200 with content-length: 0 returns undefined', async () => {
    const result = await apiFetch(
      'DELETE',
      '/x',
      defaults({
        fetch: makeFetch({ status: 200, bodyText: '', contentLength: '0' })
          .fn as unknown as typeof fetch,
      }),
    );
    expect(result).toBeUndefined();
  });

  it('U — 200 with empty body and no content-length returns undefined (tolerant)', async () => {
    const result = await apiFetch(
      'DELETE',
      '/x',
      defaults({
        fetch: makeFetch({ status: 200, bodyText: '' })
          .fn as unknown as typeof fetch,
      }),
    );
    expect(result).toBeUndefined();
  });
});

// ── Request-id behaviour ───────────────────────────────────────────────

describe('apiFetch — request id', () => {
  it('V — generates a fresh ULID when none is provided', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/me', defaults({ fetch: fn as unknown as typeof fetch }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('W — propagates a valid inbound ULID unchanged', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/me', defaults({
      fetch: fn as unknown as typeof fetch,
      requestId: VALID_REQ_ID,
    }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-request-id']).toBe(VALID_REQ_ID);
  });

  it('X — replaces a malformed inbound id with a fresh ULID', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/me', defaults({
      fetch: fn as unknown as typeof fetch,
      requestId: 'not-a-ulid',
    }));
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-request-id']).not.toBe('not-a-ulid');
    expect(headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('Y — attaches the same requestId to thrown ApiError on failure', async () => {
    try {
      await apiFetch('GET', '/x', defaults({
        fetch: makeFetch({ status: 500 }).fn as unknown as typeof fetch,
        requestId: VALID_REQ_ID,
      }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ApiServerError).requestId).toBe(VALID_REQ_ID);
    }
  });
});

// ── URL composition ────────────────────────────────────────────────────

describe('apiFetch — URL composition', () => {
  it('Z — joins apiBaseUrl + path', async () => {
    const fn = makeFetch().fn;
    await apiFetch('GET', '/internal/admin/markup-rules', defaults({
      fetch: fn as unknown as typeof fetch,
      apiBaseUrl: 'https://api.example.test',
    }));
    expect(fn).toHaveBeenCalledWith(
      'https://api.example.test/internal/admin/markup-rules',
      expect.any(Object),
    );
  });
});

// ── server-only fence (static smoke) ───────────────────────────────────

describe('api-client module — server-only guard', () => {
  it('AA — api-client.ts top-line includes the server-only import', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, '..', 'api-client.ts'), 'utf8');
    expect(src.startsWith("import 'server-only';")).toBe(true);
  });
});

// ── No body logging (sanity) ───────────────────────────────────────────

describe('apiFetch — no body logging', () => {
  it('BB — does not log request bodies via console.* on a successful call', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await apiFetch('POST', '/things', defaults({
        body: { secret: 'reason-text' },
      }));
      expect(log).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      debug.mockRestore();
      info.mockRestore();
    }
  });
});
