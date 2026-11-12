import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX, base62, createKeyBody, generateKey, hashKey } from './apiKeys.js';

describe('SP-007b API key generation', () => {
  it('is sk_spg_ + 43 base62 chars, prefix = first 8 chars of the random part, SHA-256 hash', () => {
    const { key, prefix, keyHash } = generateKey();
    expect(key).toMatch(/^sk_spg_[0-9A-Za-z]{43}$/);
    expect(prefix).toBe(key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).toBe(hashKey(key));
    expect(keyHash).not.toContain(key.slice(API_KEY_PREFIX.length));
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateKey().key));
    expect(keys.size).toBe(500);
  });

  it('base62 encodes 32 bytes at a fixed length, including the extremes', () => {
    expect(base62(Buffer.alloc(32, 0))).toBe('0'.repeat(43));
    const max = base62(Buffer.alloc(32, 0xff));
    expect(max).toHaveLength(43);
    expect(BigInt(`0x${'ff'.repeat(32)}`)).toBe(
      [...max].reduce(
        (n, c) =>
          n * 62n +
          BigInt('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.indexOf(c)),
        0n,
      ),
    );
  });

  it('create body: scopes default to read, must be known and distinct', () => {
    expect(createKeyBody.parse({}).scopes).toEqual(['read']);
    expect(createKeyBody.parse({ scopes: ['read', 'topup'] }).scopes).toEqual(['read', 'topup']);
    expect(createKeyBody.safeParse({ scopes: [] }).success).toBe(false);
    expect(createKeyBody.safeParse({ scopes: ['admin'] }).success).toBe(false);
    expect(createKeyBody.safeParse({ scopes: ['read', 'read'] }).success).toBe(false);
  });
});
