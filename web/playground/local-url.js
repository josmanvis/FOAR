// ?src= and ?app= open the source and the running app of a dev server on this
// machine. They run code on this page, so they accept only http(s) URLs on a
// loopback host: a link can't make the playground run code from anywhere else.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w-]+\.localhost)$/i;

/** The URL if it's http(s) on this machine (resolved against the page), else null. */
export function localUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw, location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

export const LOCAL_ONLY_MESSAGE = 'Only sources on this machine (localhost) can be opened with ?src= or ?app=.';
