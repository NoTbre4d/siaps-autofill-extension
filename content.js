/**
 * SI-APS AutoFill — Content Script (orquestador)
 *
 * Punto de entrada inyectado en cada página.
 * Inicializa los módulos y coordina mensajes del service worker.
 */

(function () {
  'use strict';

  // Evitar doble inicialización
  if (window.__siapsAutofillInitialized) return;
  window.__siapsAutofillInitialized = true;

  // ── Instancias globales ──
  const engine = new AutofillEngine();
  const panel = new PanelUI();

  // ── Inicializar panel ──
  panel.init(engine);

  // ── Escuchar mensajes del service worker (background.js) ──
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case 'toggle-panel':
        panel.toggle();
        sendResponse({ ok: true });
        break;

      case 'autofill':
        panel.triggerAutofill();
        sendResponse({ ok: true });
        break;

      case 'show-panel':
        panel.show();
        sendResponse({ ok: true });
        break;

      case 'hide-panel':
        panel.hide();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Acción desconocida' });
    }
    return true; // Mantener canal abierto para async
  });

  // ── Atajo de teclado como fallback (por si Commands API no captura) ──
  document.addEventListener('keydown', (e) => {
    // Alt + Shift + F → Autocompletar
    if (e.altKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      e.stopPropagation();
      panel.show();
      panel.triggerAutofill();
    }

    // Alt + Shift + P → Toggle panel
    if (e.altKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      e.stopPropagation();
      panel.toggle();
    }
  });

  console.log('[SI-APS] Content script inicializado. Alt+Shift+P para toggle, Alt+Shift+F para autocompletar.');
})();
