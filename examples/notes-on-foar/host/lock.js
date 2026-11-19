// Locked notes: one password, PBKDF2-SHA256 -> AES-GCM-256 (WebCrypto).
// The key only lives in memory while notes are unlocked.
import { kvGet, kvSet } from './storage.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHECK = 'notes-on-foar:lock-check:v1';
const ITERATIONS = 310_000;

let meta = null; // { salt, check, hint }
let key = null;

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function init() {
  meta = (await kvGet('lock')) ?? null;
}

export const exists = () => meta !== null;
export const hint = () => meta?.hint ?? '';
export const getKey = () => key;
export const forget = () => {
  key = null;
};

export async function encrypt(text, k = key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(text));
  return { iv: toB64(iv), data: toB64(data) };
}

export async function decrypt(box, k = key) {
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, k, fromB64(box.data));
  return dec.decode(out);
}

export async function create(password, passwordHint) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await derive(password, salt);
  meta = { salt: toB64(salt), check: await encrypt(CHECK, k), hint: passwordHint || '' };
  await kvSet('lock', meta);
  key = k;
}

/** Resolves true and keeps the key in memory when the password is right. */
export async function unlock(password) {
  if (!meta) return false;
  const k = await derive(password, fromB64(meta.salt));
  try {
    if ((await decrypt(meta.check, k)) !== CHECK) return false;
  } catch {
    return false;
  }
  key = k;
  return true;
}
