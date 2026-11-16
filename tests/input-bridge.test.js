import test from 'node:test';
import assert from 'node:assert/strict';

// A DOM is not available in node:test. This fixture models only the browser
// operations used at the boundary; browser integration remains a separate check.
class El extends EventTarget {
  constructor(name = 'DIV', attrs = {}) { super(); this.nodeType = 1; this.nodeName = name; this.attrs = attrs; this.childNodes = []; this.isConnected = true; }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; n.parentElement = this; n.ownerDocument = this.ownerDocument; this.childNodes.push(n); } return this; }
  get nextSibling() { const a = this.parentNode?.childNodes ?? []; return a[a.indexOf(this) + 1] ?? null; }
  contains(n) { return n === this || this.childNodes.some(c => c.contains?.(n) || c === n); }
  getAttribute(n) { return this.attrs[n] ?? null; }
  hasAttribute(n) { return n in this.attrs; }
  matches(selector) { return selector.split(',').some(s => { const m = s.trim().match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return m && this.hasAttribute(m[1]) && (m[2] === undefined || this.attrs[m[1]] === m[2]); }); }
  closest(s) { return this.matches(s) ? this : this.parentElement?.closest(s) ?? null; }
  querySelectorAll(s) { return this.childNodes.flatMap(c => c.nodeType === 1 ? [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)] : []); }
  querySelector(s) { return this.querySelectorAll(s)[0] ?? null; }
  getClientRects() { return [1]; }
}
// Make text nodes report their parent like the DOM does for appended children.
function textIn(parent, value) { const n = text(value); parent.append(n); return n; }
function text(value) { const n = new El('#text'); n.nodeType = 3; n.nodeValue = value; return n; }
function fixture() {
  const doc = new EventTarget(); doc.hasFocus = () => true; doc.querySelectorAll = () => []; doc.defaultView = new EventTarget();
  const content = new El('DIV', { 'data-conversation-content': '', 'data-conversation-session': 's1' }); content.ownerDocument = doc;
  const seat = new El('DIV', { 'data-composer-seat': '' }); content.append(seat);
  const anchor = new El(); const card = new El('DIV', { 'data-composer-card': '' }); seat.append(anchor, card);
  // DSH SlotOutlet always renders this anchor, even when MenuView returns null.
  const overlay = new El('DIV', { 'data-composer-overlay': '' });
  const outlet = new El('DIV', { 'data-slot': 'conversation.input.overlay' });
  overlay.append(outlet); card.append(overlay);
  const editor = new El('DIV', { 'data-composer-input': '', contenteditable: 'true', 'data-phase': 'plain' }); card.append(editor);
  const p = new El('P'); editor.append(p); const node = text('hello'); p.append(node);
  const selection = { isCollapsed: true, rangeCount: 1, anchorNode: node, focusNode: node, anchorOffset: 5, focusOffset: 5 };
  doc.getSelection = () => selection; doc.activeElement = editor;
  let changes = 0;
  return { doc, content, seat, anchor, card, overlay, outlet, editor, p, node, selection, options: { anchor, sessionId: 's1', inputActions: { captureInsertion: () => ({ start: 5, end: 5, draftRev: 2 }) }, onChange: () => { changes++; } }, changes: () => changes };
}
let module;
test('bridge module exists and exports the researched boundary', async () => {
  module = await import('../web/input-bridge.js').catch(() => null);
  assert.equal(typeof module?.createInputBridge, 'function', 'missing createInputBridge implementation');
});
test('only the focused mapped composer with a collapsed final caret is eligible', () => {
  const f = fixture(); const b = module.createInputBridge(f.options);
  assert.equal(b.snapshot().eligible, true);
  f.doc.activeElement = f.anchor; assert.equal(b.snapshot().eligible, false);
  assert.equal(b.snapshot().reason, 'focus');
  f.doc.activeElement = f.editor; f.selection.isCollapsed = false; assert.equal(b.snapshot().eligible, false);
  f.selection.isCollapsed = true; f.selection.anchorOffset = f.selection.focusOffset = 2; assert.equal(b.snapshot().eligible, false);
  b.dispose(); assert.equal(b.snapshot().eligible, false);
});
test('rejects session mismatch, duplicate roots, frozen phases and menu without highlight', () => {
  for (const mutate of [f => { f.content.attrs['data-conversation-session'] = 's2'; }, f => f.card.append(new El('DIV', { 'data-composer-input': '' })), f => { f.editor.attrs['data-phase'] = 'sending'; }, f => f.card.append(new El('DIV', { 'data-trigger-menu': '' }))]) {
    const f = fixture(); mutate(f); const b = module.createInputBridge(f.options); assert.equal(b.snapshot().eligible, false); b.dispose();
  }
});
test('expanded Todo or Queue docks are not mistaken for the trigger menu', () => {
  const f = fixture();
  const todo = new El('BUTTON', { 'aria-expanded': 'true' });
  const queue = new El('DIV', { 'aria-expanded': 'true' });
  f.seat.append(todo, queue);
  const b = module.createInputBridge(f.options);
  assert.equal(b.snapshot().eligible, true, 'composer-seat disclosures must not pause prediction');
  f.card.append(new El('DIV', { role: 'menu' }));
  assert.equal(b.snapshot().eligible, false, 'menu semantics inside the input card still block');
  b.dispose();
});
test('empty DSH overlay scaffolding permits prediction, rendered menu or text blocks', () => {
  for (const child of [new El('DIV', { 'data-trigger-menu': '' }), new El('DIV', { role: 'listbox' }), text('unexpected')]) {
    const f = fixture(); const b = module.createInputBridge(f.options);
    assert.equal(b.snapshot().eligible, true, 'empty persistent outlet is not a menu');
    f.outlet.append(child);
    assert.equal(b.snapshot().eligible, false, 'rendered menu or text must still block');
    b.dispose();
  }
  const f = fixture(); f.overlay.append(new El('DIV'));
  const b = module.createInputBridge(f.options);
  assert.equal(b.snapshot().eligible, true, 'empty scaffolding is layout-neutral'); b.dispose();
});
test('the plugin hint inside the overlay slot does not block itself', () => {
  const f = fixture();
  const hint = new El('DIV', { 'data-input-predict-hint': '' });
  hint.append(text('继续下一步'));
  f.outlet.append(hint);
  const b = module.createInputBridge(f.options);
  assert.equal(b.snapshot().eligible, true, 'own hint is not a foreign overlay');
  const menu = new El('DIV', { 'data-trigger-menu': '' });
  f.outlet.append(menu);
  assert.equal(b.snapshot().eligible, false, 'a real menu beside the hint still blocks');
  b.dispose();
});
test('an anchor rendered inside the composer card maps to the same editor', () => {
  const f = fixture();
  const inner = new El('DIV', { 'data-input-predict-hint': '' });
  f.outlet.append(inner);
  inner.ownerDocument = f.doc; // the fixture outlet was built before joining the document
  const b = module.createInputBridge({ ...f.options, anchor: inner });
  assert.equal(b.snapshot().eligible, true);
  b.dispose();
});
test('structural end rejects trailing empty paragraphs and chips; permits a final empty paragraph placeholder', () => {
  const f = fixture(); const b = module.createInputBridge(f.options);
  const last = new El('P'); f.editor.append(last); last.append(new El('BR'));
  assert.equal(b.snapshot().eligible, false, 'empty final paragraph still lies after caret');
  f.selection.anchorNode = f.selection.focusNode = last; f.selection.anchorOffset = f.selection.focusOffset = 0;
  assert.equal(b.snapshot().eligible, true);
  last.append(new El('SPAN', { contenteditable: 'false' })); assert.equal(b.snapshot().eligible, false);
  b.dispose();
});
test('composition invalidates synchronously, blocks its closing event and removes listeners', () => {
  const f = fixture(); const b = module.createInputBridge(f.options);
  const event = new Event('compositionstart'); Object.defineProperty(event, 'target', { value: f.editor }); f.doc.dispatchEvent(event);
  assert.equal(b.snapshot().eligible, false); assert.ok(f.changes() > 0);
  const end = new Event('compositionend'); Object.defineProperty(end, 'target', { value: f.editor }); f.doc.dispatchEvent(end);
  assert.equal(b.snapshot().eligible, false);
  b.dispose(); const before = f.changes(); f.doc.dispatchEvent(new Event('selectionchange')); assert.equal(f.changes(), before);
});
test('ignores plugin-owned rendering mutations but invalidates composer mutations', () => {
  const f = fixture(); let changed;
  f.doc.defaultView.MutationObserver = class { constructor(callback) { changed = callback; } observe() {} disconnect() {} };
  const b = module.createInputBridge(f.options);
  changed([{ target: f.anchor }]); assert.equal(f.changes(), 0);
  changed([{ target: f.editor }]); assert.equal(f.changes(), 1);
  b.dispose();
});
test('rejects DOM and captured selection disagreement and distinguishes selection locations', () => {
  const f = fixture(); const b = module.createInputBridge(f.options); const key = b.snapshot().selectionKey;
  f.options.inputActions.captureInsertion = () => ({ start: 1, end: 3, draftRev: 2 }); assert.equal(b.snapshot().eligible, false);
  f.options.inputActions.captureInsertion = () => ({ start: 5, end: 5, draftRev: 3 }); assert.notEqual(b.snapshot().selectionKey, key); b.dispose();
});
