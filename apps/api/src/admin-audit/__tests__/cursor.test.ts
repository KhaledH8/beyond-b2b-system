import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../cursor';

const VALID_ID = '01ARZ3NDEKTSV4RRFFQ69G5AAA';
const VALID_ISO = '2026-05-13T10:00:00.000Z';

describe('cursor — encode / decode round-trip', () => {
  it('A — encodes to a base64 string', () => {
    const c = encodeCursor(VALID_ISO, VALID_ID);
    expect(c).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('B — decode(encode(x)) round-trips occurredAt + id', () => {
    const c = encodeCursor(VALID_ISO, VALID_ID);
    const decoded = decodeCursor(c);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(VALID_ID);
    expect(decoded!.occurredAt.toISOString()).toBe(VALID_ISO);
  });
});

describe('cursor — invalid inputs decode to null (never throw)', () => {
  it('C — non-base64 input', () => {
    expect(decodeCursor('***not-base64***')).toBeNull();
  });

  it('D — base64 of non-JSON', () => {
    const bad = Buffer.from('not json', 'utf8').toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('E — base64 of JSON missing fields', () => {
    const bad = Buffer.from(JSON.stringify({ x: 'y' }), 'utf8').toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('F — id is not a valid ULID', () => {
    const bad = Buffer.from(
      JSON.stringify({ o: VALID_ISO, i: 'not-a-ulid' }),
      'utf8',
    ).toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('G — occurredAt is not a valid date', () => {
    const bad = Buffer.from(
      JSON.stringify({ o: 'not-a-date', i: VALID_ID }),
      'utf8',
    ).toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('H — JSON top-level is not an object', () => {
    const bad = Buffer.from(JSON.stringify(['arr']), 'utf8').toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('I — JSON top-level is null', () => {
    const bad = Buffer.from('null', 'utf8').toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });
});
