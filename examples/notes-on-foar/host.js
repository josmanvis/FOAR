// Host bindings for Notes on FOAR when mounted inside the FOAR playground.
import * as storage from './host/storage.js';
import * as lock from './host/lock.js';
import * as model from './host/model.js';
import { installEditor, fmt } from './host/editor.js';
import { installUx } from './host/ux.js';
import { noteCommand } from './host/export.js';
import { seedData, readV1 } from './host/seed.js';

const PURGE_AFTER = 30 * 86_400_000;
const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
];

let initPromise = null;

async function ensureData() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const messages = Object.fromEntries(
      await Promise.all(
        LOCALES.map(async ({ code }) => [
          code,
          await (await fetch(new URL(`./locales/${code}.json`, import.meta.url))).json(),
        ]),
      ),
    );

    await storage.open();
    await lock.init();

    let [notes, folders] = await Promise.all([storage.getAll('notes'), storage.getAll('folders')]);
    const ciphers = new Map();

    if (!(await storage.kvGet('seeded'))) {
      const seed = seedData();
      const imported = readV1();
      notes = [...imported, ...seed.notes];
      folders = [...seed.folders, ...(imported.length ? [{ id: 'imported', name: 'Imported' }] : [])];
      await storage.writeNotes(notes, []);
      await storage.replaceFolders(folders);
      await storage.kvSet('seeded', true);
    }
    if (!folders.some((f) => f.id === 'notes')) folders.unshift({ id: 'notes', name: 'Notes' });

    const expired = notes.filter((n) => n.deleted_at && Date.now() - n.deleted_at > PURGE_AFTER).map((n) => n.id);
    if (expired.length) {
      notes = notes.filter((n) => !expired.includes(n.id));
      await storage.writeNotes([], expired);
    }

    notes = notes.map((n) => {
      if (n.cipher) ciphers.set(n.id, n.cipher);
      const { cipher, ...rest } = n;
      return { ...rest, html: n.locked ? '' : n.html, title: n.title || model.titleOf(n.html) };
    });

    return { messages, notes, folders, ciphers };
  })();
  return initPromise;
}

export async function createHost({ createI18n, getApp }) {
  const data = await ensureData();
  const { messages, ciphers } = data;

  function preferredLocale() {
    const saved = model.loadPref('locale', null);
    if (saved && messages[saved]) return saved;
    for (const lang of navigator.languages || [navigator.language]) {
      const base = lang.split('-')[0];
      if (messages[base]) return base;
    }
    return 'en';
  }

  const i18n = createI18n({ locale: preferredLocale(), fallback: 'en', messages });
  model.setI18n(i18n.t, i18n.locale);

  const saved = new Map(data.notes.map((n) => [n.id, n]));
  let pending = null;
  let timer = 0;

  function persist(next) {
    data.notes = next;
    pending = next;
    clearTimeout(timer);
    timer = setTimeout(() => flush(), 300);
  }

  async function flush(key = lock.getKey()) {
    const next = pending;
    pending = null;
    if (!next) return;
    const puts = [];
    const seen = new Set();
    for (const n of next) {
      seen.add(n.id);
      if (saved.get(n.id) === n) continue;
      saved.set(n.id, n);
      if (n.locked) {
        if (key) ciphers.set(n.id, await lock.encrypt(n.html, key));
        puts.push({ ...n, html: '', cipher: ciphers.get(n.id) });
      } else {
        ciphers.delete(n.id);
        puts.push(n);
      }
    }
    const deletes = [...saved.keys()].filter((id) => !seen.has(id));
    for (const id of deletes) saved.delete(id);
    await storage.writeNotes(puts, deletes);
  }

  function setLocale(code) {
    queueMicrotask(() => {
      model.setI18n(i18n.t, code);
      getApp()?.setLocale(code);
      model.savePref('locale', code);
    });
  }

  async function createPassword(password, hint) {
    await lock.create(password, hint);
    getApp()?.call('Vault.Opened', {});
  }

  async function unlockNotes(password) {
    if (!(await lock.unlock(password))) {
      getApp()?.call('Vault.Failed');
      return;
    }
    const plain = {};
    for (const [id, box] of ciphers) {
      try {
        plain[id] = await lock.decrypt(box);
      } catch {}
    }
    getApp()?.call('Vault.Opened', plain);
  }

  function closeLocked() {
    const key = lock.getKey();
    lock.forget();
    clearTimeout(timer);
    flush(key);
  }

  let cleanupEditor = null;
  let cleanupUx = null;

  return {
    fullBleed: true,
    i18n,
    bindings: {
      current_locale: () => i18n.locale,
      available_locales: () => LOCALES,
      set_locale: setLocale,
      // later("Toasts.Hide", id, 6000): run a context effect after a delay
      later: (effect, arg, ms = 0) => setTimeout(() => getApp()?.call(effect, arg), ms),
      start_new_folder: () =>
        queueMicrotask(() => {
          const app = getApp();
          const row = app?.getSnapshot().find((i) => i.viewName === 'NewFolderRow');
          if (row) app.invokeEffect(row.key, 'Start');
        }),
      neighbor_of: model.neighborOf,
      load_notes: () => data.notes,
      load_folders: () => data.folders,
      persist,
      persist_folders: (f) => {
        data.folders = f;
        return storage.replaceFolders(f);
      },
      load_pref: model.loadPref,
      save_pref: model.savePref,
      note_groups: model.noteGroups,
      first_in: model.firstIn,
      count_in: model.countIn,
      count_visible: model.countVisible,
      all_tags: model.allTags,
      view_title: model.viewTitle,
      empty_text: model.emptyText,
      folder_name: model.folderName,
      by_name: model.byName,
      unique_name: model.uniqueName,
      row_title: model.rowTitle,
      preview_of: model.previewOf,
      card_text: model.cardText,
      thumb_of: model.thumbOf,
      title_of: model.titleOf,
      lock_title: model.lockTitle,
      fmt_short: model.fmtShort,
      fmt_long: model.fmtLong,
      fmt,
      note_command: noteCommand,
      password_exists: lock.exists,
      password_hint: lock.hint,
      create_password: createPassword,
      unlock_notes: unlockNotes,
      close_locked: closeLocked,
    },
    attach(app, mountEl) {
      cleanupEditor = installEditor(app, mountEl);
      cleanupUx = installUx(app, mountEl);
    },
    destroy() {
      clearTimeout(timer);
      flush();
      cleanupEditor?.();
      cleanupUx?.();
      cleanupEditor = null;
      cleanupUx = null;
    },
  };
}
