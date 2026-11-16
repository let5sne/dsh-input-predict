// Compatibility adapter for the researched DSH 0.2.2-rc.3 DOM. These markers
// are implementation details, not a public editor API. Unknown layouts fail
// closed. Mutations use only the public revision-guarded InputActions API.
const CONTENT = '[data-conversation-content]';
const SEAT = '[data-composer-seat]';
const INPUT = '[data-composer-input]';
const BLOCKED = '[inert], [hidden], [aria-hidden="true"]';

const MENU_SELECTOR = '[data-trigger-menu], [role="listbox"], [role="menu"], [aria-expanded="true"], [data-slot-error]';

/** Whether an overlay slot renders content rather than empty scaffolding.
 * Closed DSH slots retain display:contents wrappers and empty per-cell spans;
 * real menus render semantic markers, text, or a crash face.
 */
export function overlayHasContent(root) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    // This plugin's own placeholder hint lives in the same overlay slot.
    if (node !== root && node.nodeType === 1 && node.hasAttribute('data-input-predict-hint')) continue;
    if (node !== root && node.nodeType === 1 && node.matches(MENU_SELECTOR)) return true;
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue.trim() !== '') return true;
      } else if (child.nodeType === 1) {
        stack.push(child);
      }
    }
  }
  return false;
}

/** A strict structural end check; never compares clipboard and detect offsets.
 * Later empty paragraphs, BRs, and atomic chips count as content. The one BR
 * of a final empty paragraph is the sole permitted placeholder exception.
 */
export function isComposerEnd(editor, node, offset) {
  if (!node || !editor.contains(node) || !Number.isInteger(offset) || offset < 0) return false;
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (element?.closest('[contenteditable="false"]')) return false;
  if (node.nodeType === 3) {
    if (offset !== node.nodeValue.length) return false;
  } else if (node.nodeType === 1) {
    const children = node.childNodes;
    const placeholder = node.nodeName === 'P' && children.length === 1 && children[0].nodeName === 'BR';
    if (offset !== children.length && !(placeholder && offset === 0)) return false;
  } else return false;
  for (let cursor = node; cursor !== editor; cursor = cursor.parentNode) {
    if (!cursor.parentNode || cursor.nextSibling !== null) return false;
  }
  return true;
}

/** Observe a slot-owned anchor without global composer selection or key capture.
 * onChange is an invalidation signal, delivered synchronously for IME start.
 * The consumer must recapture snapshot() on the actual unmodified Tab event,
 * then call insertText(suffix, span); consume Tab only if insertion succeeds.
 */
export function createInputBridge({ anchor, sessionId, inputActions, onChange = () => {} }) {
  const document = anchor.ownerDocument;
  let disposed = false;
  let composing = false;
  let compositionUntil = 0;
  let timer;
  const ids = new WeakMap();
  let sequence = 0;
  const identity = node => { if (!ids.has(node)) ids.set(node, ++sequence); return ids.get(node); };
  const invalidate = () => { if (!disposed) onChange(); };
  const reject = (reason = 'mapping', detail = null) => ({ eligible: false, reason, detail, span: null, selectionKey: null, editor: null });
/** Structural identity only; never editor text or business attributes. */
function describe(node) {
  if (!node) return null;
  if (node.nodeType !== 1) return { nodeType: node.nodeType };
  return {
    tag: node.nodeName,
    slot: node.getAttribute('data-slot'),
    triggerMenu: node.hasAttribute('data-trigger-menu'),
    role: node.getAttribute('role'),
    ariaHidden: node.getAttribute('aria-hidden'),
    children: node.childNodes.length,
  };
}

  function mappedEditor() {
    if (disposed || !anchor.isConnected || !sessionId) return null;
    const seat = anchor.closest(SEAT);
    const content = anchor.closest(CONTENT);
    if (!seat || !content || seat.closest(CONTENT) !== content || content.getAttribute('data-conversation-session') !== sessionId) return null;
    const roots = seat.querySelectorAll(INPUT);
    if (roots.length !== 1) return null;
    const editor = roots[0];
    const card = editor.closest('[data-composer-card]');
    if (!card || card.closest(SEAT) !== seat || editor.closest(SEAT) !== seat || editor.closest(CONTENT) !== content) return null;
    return { editor, card, seat, content };
  }

  function snapshot() {
    try {
      const mapped = mappedEditor();
      if (!mapped) return reject();
      const { editor, seat, card } = mapped;
      if (!document.hasFocus() || document.activeElement !== editor) {
        return reject('focus', { documentFocused: document.hasFocus(), active: describe(document.activeElement) });
      }
      if (!editor.isConnected || editor.getAttribute('contenteditable') !== 'true'
        || editor.getAttribute('data-phase') !== 'plain' || editor.getAttribute('aria-disabled') === 'true') {
        return reject('locked', { phase: editor.getAttribute('data-phase'),
          disabled: editor.getAttribute('aria-disabled'), editable: editor.getAttribute('contenteditable') });
      }
      if (editor.closest(BLOCKED) || editor.getClientRects().length === 0) return reject('hidden');
      if (composing || Date.now() < compositionUntil || editor.hasAttribute('data-composer-composing')) return reject('composing');
      // The trigger menu stays focused in the editor even with no highlight.
      // Unknown overlay contributions are conservatively treated as menus too.
      // The seat also contains the Todo and Queue docks, whose own disclosures
      // use aria-expanded. Only the trigger menu's own marker, or menu semantics
      // inside this composer card, mean that the input menu is open.
      if (seat.querySelector('[data-trigger-menu]')
        || card.querySelector('[role="listbox"], [role="menu"]')) {
        return reject('menu', { seat: describe(seat) });
      }
      for (const overlay of card.querySelectorAll('[data-composer-overlay]')) {
        // Closed list slots keep empty display:contents wrappers and one empty
        // per-cell span. Those are scaffolding; rendered text, menu semantics,
        // or a crash face are actual overlay content.
        const blocked = overlayHasContent(overlay);
        if (blocked) return reject('overlay', {
          overlay: describe(overlay),
          children: Array.from(overlay.childNodes).slice(0, 4).map(describe),
          grandchildren: Array.from(overlay.childNodes).flatMap(node =>
            node.nodeType === 1 ? Array.from(node.childNodes).slice(0, 4).map(describe) : []),
        });
      }
      if (document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="menu"]').length > 0) return reject('dialog');
      const selection = document.getSelection();
      if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed
        || selection.anchorNode !== selection.focusNode || selection.anchorOffset !== selection.focusOffset
        || !isComposerEnd(editor, selection.focusNode, selection.focusOffset)) {
        return reject('selection', { collapsed: selection?.isCollapsed, ranges: selection?.rangeCount,
          focus: describe(selection?.focusNode), offset: selection?.focusOffset });
      }
      const span = inputActions.captureInsertion();
      if (!span || !Number.isSafeInteger(span.start) || span.start < 0 || span.start !== span.end
        || !Number.isSafeInteger(span.draftRev) || span.draftRev < 0) return reject('span');
      return { eligible: true, span, editor,
        selectionKey: `${identity(editor)}:${identity(selection.focusNode)}:${selection.focusOffset}:${span.start}:${span.draftRev}` };
    } catch { return reject('bridge-error'); }
  }

  const onCompositionStart = event => {
    const mapped = mappedEditor();
    if (mapped?.editor.contains(event.target)) {
      composing = true;
      clearTimeout(timer);
      invalidate();
    }
  };
  const onCompositionEnd = event => {
    const mapped = mappedEditor();
    if (composing || mapped?.editor.contains(event.target)) {
      composing = false;
      compositionUntil = Date.now() + 20;
      clearTimeout(timer);
      invalidate();
      timer = setTimeout(invalidate, 21);
    }
  };
  const listeners = [
    ['input', invalidate], ['beforeinput', invalidate], ['selectionchange', invalidate],
    ['focusin', invalidate], ['focusout', invalidate], ['pointerdown', invalidate],
    ['compositionstart', onCompositionStart], ['compositionend', onCompositionEnd],
  ];
  for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
  document.defaultView?.addEventListener('blur', invalidate);
  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(records => {
    // Suggestion UI belongs inside the slot anchor; its own React renders must
    // not cancel the suggestion or create a render/invalidation loop.
    if (records.some(record => !anchor.contains(record.target))) invalidate();
  }) : null;
  // The surrounding occurrence includes takeover state and the trigger menu.
  const observed = anchor.closest(CONTENT);
  if (observed) observer?.observe(observed, { subtree: true, childList: true, attributes: true, characterData: true });
  return {
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      observer?.disconnect();
      for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
      document.defaultView?.removeEventListener('blur', invalidate);
    },
  };
}
