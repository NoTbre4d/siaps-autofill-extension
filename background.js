/**
 * SI-APS AutoFill — Service Worker (Background)
 * Manifest V3
 *
 * Responsabilidades:
 *  - Escuchar clicks en el ícono de la extensión (action) y comandos de teclado.
 *  - Enviar mensajes al content script de la pestaña activa.
 */

// Escuchar click en el ícono de la extensión
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'toggle-panel' });
  } catch (err) {
    console.warn('[SI-APS BG] No se pudo enviar mensaje a la pestaña:', err.message);
  }
});

// Escuchar atajos de teclado definidos en manifest.json commands
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;
  try {
    if (command === 'autofill-current') {
      await chrome.tabs.sendMessage(tab.id, { action: 'autofill' });
    } else if (command === 'toggle-panel') {
      await chrome.tabs.sendMessage(tab.id, { action: 'toggle-panel' });
    }
  } catch (err) {
    console.warn('[SI-APS BG] Error al enviar comando:', command, err.message);
  }
});

console.log('[SI-APS BG] Service worker cargado.');
