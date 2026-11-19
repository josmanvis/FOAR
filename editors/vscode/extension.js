// Minimal zero-dependency VS Code client for `foar lsp`.
// Bridges VS Code diagnostics, completions, hover, and go-to-definition directly
// to the native Rust `foar lsp` JSON-RPC 2.0 server over stdio.
const cp = require('node:child_process');
const vscode = require('vscode');

let proc = null;
let nextId = 1;
const pending = new Map();
let buf = Buffer.alloc(0);
let diagCollection = null;

function send(msg) {
  if (!proc || !proc.stdin.writable) return;
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  proc.stdin.write(body);
}

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function handleMessage(msg) {
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
    return;
  }
  if (msg.method === 'textDocument/publishDiagnostics' && diagCollection) {
    const uri = vscode.Uri.parse(msg.params.uri);
    const diags = (msg.params.diagnostics || []).map((d) => {
      const range = new vscode.Range(
        d.range.start.line,
        d.range.start.character,
        d.range.end.line,
        d.range.end.character,
      );
      return new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Error);
    });
    diagCollection.set(uri, diags);
  }
}

function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const header = buf.slice(0, sep).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.slice(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) return;
    const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.slice(sep + 4 + len);
    try {
      handleMessage(JSON.parse(body));
    } catch {}
  }
}

async function activate(context) {
  const cfg = vscode.workspace.getConfiguration('foar');
  const bin = cfg.get('serverPath', 'foar');
  diagCollection = vscode.languages.createDiagnosticCollection('foar');
  context.subscriptions.push(diagCollection);

  proc = cp.spawn(bin, ['lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.on('data', onData);

  await request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  const openDoc = (doc) => {
    if (doc.languageId !== 'foar') return;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: doc.uri.toString(), languageId: 'foar', version: doc.version, text: doc.getText() } },
    });
  };
  vscode.workspace.textDocuments.forEach(openDoc);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(openDoc),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== 'foar') return;
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: e.document.uri.toString(), version: e.document.version },
          contentChanges: [{ text: e.document.getText() }],
        },
      });
    }),
    vscode.languages.registerCompletionItemProvider(
      'foar',
      {
        async provideCompletionItems(doc, pos) {
          const res = await request('textDocument/completion', {
            textDocument: { uri: doc.uri.toString() },
            position: { line: pos.line, character: pos.character },
          });
          return (res || []).map((item) => {
            const ci = new vscode.CompletionItem(item.label);
            ci.detail = item.detail;
            ci.documentation = item.documentation;
            return ci;
          });
        },
      },
      '.', '@', ':',
    ),
    vscode.languages.registerHoverProvider('foar', {
      async provideHover(doc, pos) {
        const res = await request('textDocument/hover', {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
        });
        if (!res || !res.contents) return null;
        return new vscode.Hover(new vscode.MarkdownString(res.contents.value));
      },
    }),
    vscode.languages.registerDefinitionProvider('foar', {
      async provideDefinition(doc, pos) {
        const res = await request('textDocument/definition', {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
        });
        if (!res || !res.uri) return null;
        const r = res.range;
        return new vscode.Location(
          vscode.Uri.parse(res.uri),
          new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character),
        );
      },
    }),
  );
}

async function deactivate() {
  if (proc) {
    await request('shutdown', null).catch(() => {});
    send({ jsonrpc: '2.0', method: 'exit', params: null });
    proc.kill();
    proc = null;
  }
}

module.exports = { activate, deactivate };
