// Pure helpers the FOAR app calls by name: text extraction, grouping, counts,
// tags, formatting and preferences.

const DAY = 86_400_000;

// ---- i18n: strings come from the FOAR runtime's t(), dates from Intl -------------
let t = (key) => key;
let locale;
let monthFmt, monthYearFmt, timeFmt, weekdayFmt, shortFmt, longFmt;
function makeFormatters() {
  monthFmt = new Intl.DateTimeFormat(locale, { month: 'long' });
  monthYearFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  timeFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  shortFmt = new Intl.DateTimeFormat(locale, { year: '2-digit', month: 'numeric', day: 'numeric' });
  longFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
}
makeFormatters();

/** Called when the language changes (before the app re-renders). */
export function setI18n(translate, nextLocale) {
  t = translate;
  locale = nextLocale;
  makeFormatters();
}

// ---- text from HTML (cached: called for every row on every update) ---------
const linesCache = new Map();

export function htmlLines(html) {
  if (!html) return [];
  let lines = linesCache.get(html);
  if (lines) return lines;
  // <template> parses without loading images or running anything.
  const tpl = document.createElement('template');
  tpl.innerHTML = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr|table)>/gi, '$&\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' $&');
  lines = tpl.content.textContent
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (linesCache.size > 3000) linesCache.clear();
  linesCache.set(html, lines);
  return lines;
}

export const titleOf = (html) => (htmlLines(html)[0] || '').slice(0, 200);

const isHidden = (note, unlocked) => note.locked && !unlocked;

export function previewOf(note, unlocked) {
  if (isHidden(note, unlocked)) return t('note.locked');
  return htmlLines(note.html)[1] || t('note.noText');
}

export function cardText(note, unlocked) {
  if (isHidden(note, unlocked)) return `🔒 ${t('note.locked')}`;
  return htmlLines(note.html).slice(0, 14).join('\n');
}

const thumbCache = new Map();
export function thumbOf(note, unlocked) {
  if (isHidden(note, unlocked) || !note.html || !note.html.includes('<img')) return '';
  let src = thumbCache.get(note.html);
  if (src === undefined) {
    src = /<img[^>]*\ssrc="([^"]+)"/i.exec(note.html)?.[1]?.replace(/&amp;/g, '&') ?? '';
    if (thumbCache.size > 500) thumbCache.clear();
    thumbCache.set(note.html, src);
  }
  return src;
}

export function rowTitle(note) {
  return (note.locked ? '🔒 ' : '') + (note.title || t('note.new'));
}

// ---- tags ---------------------------------------------------------------
const TAG = /(?:^|\s)#([\p{L}\p{N}_-]{1,40})/gu;

export function tagsOf(note) {
  if (!note.html) return [];
  const out = new Map();
  for (const line of htmlLines(note.html)) {
    for (const m of line.matchAll(TAG)) {
      const k = m[1].toLowerCase();
      if (!out.has(k)) out.set(k, m[1]);
    }
  }
  return [...out.values()];
}

const tagCache = new WeakMap();
export function allTags(notes) {
  let tags = tagCache.get(notes);
  if (tags) return tags;
  const counts = new Map();
  for (const n of notes) {
    if (n.deleted_at) continue;
    for (const tag of tagsOf(n)) {
      const k = tag.toLowerCase();
      const cur = counts.get(k);
      counts.set(k, { key: k, name: cur?.name ?? tag, count: (cur?.count ?? 0) + 1 });
    }
  }
  tags = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  tagCache.set(notes, tags);
  return tags;
}

// ---- filtering, counting, grouping ----------------------------------------
function inView(note, view) {
  if (view === 'deleted') return note.deleted_at > 0;
  if (note.deleted_at) return false;
  if (view === 'all') return true;
  if (view.startsWith('tag:')) {
    const tag = view.slice(4).toLowerCase();
    return tagsOf(note).some((x) => x.toLowerCase() === tag);
  }
  return note.folder === view;
}

const countCache = new WeakMap();
export function countIn(notes, view) {
  let m = countCache.get(notes);
  if (!m) countCache.set(notes, (m = new Map()));
  let c = m.get(view);
  if (c === undefined) {
    c = 0;
    for (const n of notes) if (inView(n, view)) c++;
    m.set(view, c);
  }
  return c;
}

function matchesQuery(note, q) {
  if (note.title.toLowerCase().includes(q)) return true;
  if (!note.html) return false;
  return htmlLines(note.html).some((l) => l.toLowerCase().includes(q));
}

const SORTS = {
  edited: (a, b) => b.updated - a.updated,
  created: (a, b) => b.created - a.created,
  // Untitled notes sort by what the list shows for them ("New Note").
  title: (a, b) => (a.title || t('note.new')).localeCompare(b.title || t('note.new'), locale, { sensitivity: 'base' }),
};

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dateBucket(ts) {
  const today = startOfDay(Date.now());
  const days = Math.round((today - startOfDay(ts)) / DAY);
  if (days <= 0) return t('group.today');
  if (days === 1) return t('group.yesterday');
  if (days < 7) return t('group.week');
  if (days < 30) return t('group.month');
  const d = new Date(ts);
  return d.getFullYear() === new Date().getFullYear() ? cap(monthFmt.format(d)) : String(d.getFullYear());
}

const cap = (s) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
const groupCache = new WeakMap();

/** [{ key, label, notes }] for the list and gallery. */
export function noteGroups(notes, view, query, sort, groupDates, folders) {
  const cacheKey = `${view}\u0000${query}\u0000${sort}\u0000${groupDates}\u0000${folders.length}\u0000${locale}`;
  let byKey = groupCache.get(notes);
  if (!byKey) groupCache.set(notes, (byKey = new Map()));
  const hit = byKey.get(cacheKey);
  if (hit) return hit;

  const q = query.trim().toLowerCase();
  let list = q
    ? notes.filter((n) => (view === 'deleted' ? n.deleted_at > 0 : !n.deleted_at) && matchesQuery(n, q))
    : notes.filter((n) => inView(n, view));
  list = list.slice().sort(SORTS[sort] || SORTS.edited);

  const groups = [];
  const pinned = view === 'deleted' ? [] : list.filter((n) => n.pinned);
  const rest = pinned.length ? list.filter((n) => !n.pinned) : list;
  if (pinned.length) groups.push({ key: 'pinned', label: t('group.pinned'), notes: pinned });

  if (groupDates && sort !== 'title') {
    const field = sort === 'created' ? 'created' : 'updated';
    let cur = null;
    for (const n of rest) {
      const label = dateBucket(n[field]);
      if (!cur || cur.label !== label) groups.push((cur = { key: `d:${label}`, label, notes: [] }));
      cur.notes.push(n);
    }
  } else if (rest.length) {
    groups.push({ key: 'notes', label: pinned.length ? t('group.notes') : '', notes: rest });
  }

  if (byKey.size > 20) byKey.clear();
  byKey.set(cacheKey, groups);
  return groups;
}

export const firstIn = (...args) => noteGroups(...args)[0]?.notes[0]?.id ?? '';

/** The note before/after `id` in display order (dir ±1), or the first/last (±999). */
export function neighborOf(notes, view, query, sort, groupDates, folders, id, dir) {
  const flat = noteGroups(notes, view, query, sort, groupDates, folders).flatMap((g) => g.notes);
  if (!flat.length) return '';
  if (dir <= -999) return flat[0].id;
  if (dir >= 999) return flat[flat.length - 1].id;
  const i = flat.findIndex((n) => n.id === id);
  if (i < 0) return flat[0].id;
  return flat[Math.max(0, Math.min(flat.length - 1, i + dir))].id;
}
export const countVisible = (...args) => noteGroups(...args).reduce((s, g) => s + g.notes.length, 0);

export function viewTitle(view, folders) {
  if (view === 'all') return t('sidebar.allNotes');
  if (view === 'deleted') return t('sidebar.deleted');
  if (view.startsWith('tag:')) return `#${view.slice(4)}`;
  return folders.find((f) => f.id === view)?.name ?? t('folder.default');
}

export function emptyText(view, query) {
  if (query.trim()) return t('empty.results');
  if (view === 'deleted') return t('empty.deleted');
  return t('empty.notes');
}

export const folderName = (folders, id) => folders.find((f) => f.id === id)?.name ?? t('folder.default');

const sortedCache = new WeakMap();
/** Folders alphabetically, like macOS Notes. */
export function byName(folders) {
  let s = sortedCache.get(folders);
  if (!s) sortedCache.set(folders, (s = folders.slice().sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }))));
  return s;
}

export function uniqueName(name, folders) {
  const taken = new Set(folders.map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let i = 2;
  while (taken.has(`${name} ${i}`.toLowerCase())) i++;
  return `${name} ${i}`;
}

export function lockTitle(note, unlocked) {
  if (!note.locked) return t('lock.lockNote');
  return unlocked ? t('sidebar.lockAllHint') : t('note.locked');
}

// ---- dates -------------------------------------------------------------------
export function fmtShort(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
  if (days <= 0) return timeFmt.format(ts);
  if (days === 1) return t('group.yesterday');
  if (days < 7) return cap(weekdayFmt.format(ts));
  return shortFmt.format(ts);
}

export const fmtLong = (ts) => t('date.long', { date: longFmt.format(ts), time: timeFmt.format(ts) });

// ---- preferences ---------------------------------------------------------------
const PREFS_KEY = 'notes-on-foar/prefs';
let prefs = {};
try {
  prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
} catch {
  prefs = {};
}

export const loadPref = (k, fallback) => (k in prefs ? prefs[k] : fallback);

export function savePref(k, v) {
  prefs[k] = v;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
