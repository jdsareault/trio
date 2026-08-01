(() => {
  'use strict';
  const Trio = window.Trio = window.Trio || {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toast(message, timeout = 3500) {
    let host = document.getElementById('trio-toasts');
    if (!host) { host = document.createElement('div'); host.id = 'trio-toasts'; host.className = 'toast-wrap'; document.body.append(host); }
    const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; host.append(node);
    setTimeout(() => node.remove(), timeout);
  }
  function modal(title, body, submit) {
    let node = document.getElementById('trio-control-modal');
    if (!node) { node = document.createElement('dialog'); node.id = 'trio-control-modal'; document.body.append(node); }
    node.innerHTML = `<form method="dialog" class="control-modal"><button class="modal-close" value="cancel">×</button><h2>${esc(title)}</h2>${body}<footer><button value="cancel">Cancel</button><button value="default" class="primary">Save</button></footer></form>`;
    node.addEventListener('close', () => { if (node.returnValue === 'default') submit?.(node); }, { once: true }); node.showModal();
  }
  function confirmAction(message, action) {
    modal('Confirm', `<p>${esc(message)}</p>`, () => action?.());
  }
  function setLive(text) {
    let region = document.getElementById('trio-aria-live');
    if (!region) { region = document.createElement('div'); region.id = 'trio-aria-live'; region.setAttribute('aria-live', 'polite'); region.setAttribute('aria-atomic', 'true'); region.className = 'sr-only'; document.body.append(region); }
    region.textContent = text;
  }
  Trio.ui = { toast, modal, confirmAction, setLive };
})();
