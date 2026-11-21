/**
 * SI-APS AutoFill — PanelUI
 *
 * Panel flotante lateral con Shadow DOM para no interferir con los estilos
 * de la página huésped. Gestiona:
 *   - Carga de Excel y cola de pacientes.
 *   - Búsqueda, navegación, marcado de completados.
 *   - Pestaña de configuración de valores por defecto.
 *   - Botón de exportar mapa de campos.
 *   - Persistencia en chrome.storage.local.
 *
 * API pública:
 *   PanelUI.init(autofillEngine) -> void
 *   PanelUI.show() / PanelUI.hide() / PanelUI.toggle()
 *   PanelUI.triggerAutofill()
 */

// eslint-disable-next-line no-unused-vars
class PanelUI {

  constructor() {
    this.engine = null;
    this.patients = [];
    this.currentIndex = 0;
    this.completed = new Set();
    this.host = null;
    this.shadow = null;
    this.visible = false;
    this.activeTab = 'queue'; // 'queue' | 'settings'
  }

  /* ═══════════════════════════════════════════
     INICIALIZACIÓN
     ═══════════════════════════════════════════ */

  async init(autofillEngine) {
    this.engine = autofillEngine;

    // Crear host Shadow DOM
    this.host = document.createElement('div');
    this.host.id = 'siaps-autofill-host';
    this.host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647; font-family: system-ui, sans-serif;';
    document.body.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'closed' });

    // Cargar CSS
    await this._loadCSS();

    // Renderizar panel
    this._render();

    // Restaurar estado persistido
    await this._loadState();

    // Eventos
    this._bindEvents();

    console.log('[SI-APS] PanelUI inicializado.');
  }

  async _loadCSS() {
    try {
      const cssUrl = chrome.runtime.getURL('modules/panel.css');
      const resp = await fetch(cssUrl);
      const cssText = await resp.text();
      const style = document.createElement('style');
      style.textContent = cssText;
      this.shadow.appendChild(style);
    } catch (err) {
      console.warn('[SI-APS] No se pudo cargar panel.css:', err);
    }
  }

  /* ═══════════════════════════════════════════
     RENDERIZADO
     ═══════════════════════════════════════════ */

  _render() {
    const container = document.createElement('div');
    container.id = 'siaps-panel';
    container.classList.add('collapsed');
    container.innerHTML = `
      <!-- Botón de toggle lateral -->
      <button id="siaps-toggle" title="SI-APS AutoFill (Alt+Shift+P)">
        <span class="toggle-icon">⚕</span>
        <span class="toggle-text">SI-APS</span>
      </button>

      <!-- Panel principal -->
      <div id="siaps-body">

        <!-- Header -->
        <div class="panel-header">
          <h3>🏥 SI-APS AutoFill</h3>
          <div class="header-actions">
            <button id="btn-minimize" title="Minimizar">─</button>
          </div>
        </div>

        <!-- Tabs -->
        <div class="tab-bar">
          <button class="tab active" data-tab="queue">📋 Cola</button>
          <button class="tab" data-tab="settings">⚙️ Config</button>
        </div>

        <!-- TAB: Cola de pacientes -->
        <div class="tab-content" id="tab-queue">

          <!-- Carga de archivo -->
          <div class="section" id="section-upload">
            <label class="file-upload-label" for="siaps-file-input">
              📂 Cargar Excel (.xlsx)
            </label>
            <input type="file" id="siaps-file-input" accept=".xlsx,.xls" />
            <div id="upload-status"></div>
          </div>

          <!-- Buscador -->
          <div class="section" id="section-search" style="display:none;">
            <input type="text" id="siaps-search" placeholder="🔍 Buscar por nombre o cédula..." />
          </div>

          <!-- Paciente actual -->
          <div class="section" id="section-patient" style="display:none;">
            <div class="patient-counter">
              Paciente <strong id="patient-idx">0</strong> de <strong id="patient-total">0</strong>
              <span id="patient-completed-badge" class="badge" style="display:none;">✅</span>
            </div>

            <div class="patient-card">
              <div class="patient-name" id="patient-name">—</div>
              <div class="patient-detail">
                <span class="label">Doc:</span>
                <span id="patient-doc">—</span>
              </div>

              <!-- Edición manual de nombre parseado -->
              <details class="name-edit">
                <summary>✏️ Editar nombre parseado</summary>
                <div class="name-fields">
                  <label>Primer nombre: <input id="edit-primerNombre" /></label>
                  <label>Segundo nombre: <input id="edit-segundoNombre" /></label>
                  <label>Primer apellido: <input id="edit-primerApellido" /></label>
                  <label>Segundo apellido: <input id="edit-segundoApellido" /></label>
                  <button id="btn-save-name" class="btn-sm">💾 Guardar</button>
                </div>
              </details>
            </div>

            <!-- Navegación -->
            <div class="nav-buttons">
              <button id="btn-prev" title="Anterior">◀ Anterior</button>
              <button id="btn-next" title="Siguiente">Siguiente ▶</button>
            </div>

            <!-- Acciones -->
            <div class="action-buttons">
              <button id="btn-autofill" class="btn-primary" title="Alt+Shift+F">
                ⚡ Autocompletar página
              </button>
              <button id="btn-complete" class="btn-success">
                ✅ Completado → Siguiente
              </button>
            </div>

            <!-- Toggle sobrescribir -->
            <label class="toggle-row">
              <input type="checkbox" id="chk-overwrite" />
              <span>Sobrescribir campos ya llenos</span>
            </label>

            <!-- Toggle familia unipersonal -->
            <label class="toggle-row">
              <input type="checkbox" id="chk-unipersonal" checked />
              <span>Modo Familia Unipersonal</span>
            </label>

            <!-- Resultado -->
            <div id="fill-result" class="result-box" style="display:none;"></div>
          </div>

          <!-- Exportar mapa de campos -->
          <div class="section" id="section-tools" style="display:none;">
            <button id="btn-export-map" class="btn-outline" title="Exportar metadatos del formulario actual">
              🗺️ Exportar mapa de campos (JSON)
            </button>
          </div>

          <!-- Lista de búsqueda -->
          <div id="search-results" style="display:none;"></div>

        </div>

        <!-- TAB: Configuración -->
        <div class="tab-content" id="tab-settings" style="display:none;">
          <div class="section">
            <h4>Opciones neutrales para selects/radios</h4>
            <p class="hint">Una por línea. Se prueban en orden de prioridad.</p>
            <textarea id="cfg-neutral-options" rows="8"></textarea>
          </div>
          <div class="section">
            <h4>Texto por defecto (corto, &lt;10 chars)</h4>
            <input type="text" id="cfg-text-short" />
          </div>
          <div class="section">
            <h4>Texto por defecto (largo, ≥10 chars)</h4>
            <textarea id="cfg-text-long" rows="3"></textarea>
          </div>
          <div class="section">
            <button id="btn-save-settings" class="btn-primary">💾 Guardar configuración</button>
            <button id="btn-reset-settings" class="btn-outline">🔄 Restaurar predeterminados</button>
          </div>
          <div class="section">
            <h4>Estado</h4>
            <button id="btn-clear-data" class="btn-danger">🗑️ Limpiar toda la información almacenada</button>
          </div>
        </div>

      </div>
    `;

    this.shadow.appendChild(container);
    this.panel = container;
  }

  /* ═══════════════════════════════════════════
     EVENTOS
     ═══════════════════════════════════════════ */

  _bindEvents() {
    const $ = (sel) => this.shadow.querySelector(sel);

    // Toggle panel
    $('#siaps-toggle').addEventListener('click', () => this.toggle());
    $('#btn-minimize').addEventListener('click', () => this.hide());

    // Tabs
    this.shadow.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    // Archivo
    $('#siaps-file-input').addEventListener('change', (e) => this._onFileSelect(e));

    // Navegación
    $('#btn-prev').addEventListener('click', () => this._navigate(-1));
    $('#btn-next').addEventListener('click', () => this._navigate(1));

    // Autocompletar
    $('#btn-autofill').addEventListener('click', () => this.triggerAutofill());

    // Completado
    $('#btn-complete').addEventListener('click', () => this._markCompleted());

    // Buscar
    $('#siaps-search').addEventListener('input', (e) => this._onSearch(e.target.value));

    // Exportar mapa
    $('#btn-export-map').addEventListener('click', () => this._exportFieldMap());

    // Guardar edición de nombre
    $('#btn-save-name').addEventListener('click', () => this._saveNameEdit());

    // Toggles
    $('#chk-overwrite').addEventListener('change', (e) => {
      this.engine.settings.overwrite = e.target.checked;
      this._saveState();
    });
    $('#chk-unipersonal').addEventListener('change', (e) => {
      this.engine.settings.familiaUnipersonal = e.target.checked;
      this._saveState();
    });

    // Configuración
    $('#btn-save-settings').addEventListener('click', () => this._saveSettings());
    $('#btn-reset-settings').addEventListener('click', () => this._resetSettings());
    $('#btn-clear-data').addEventListener('click', () => this._clearAllData());
  }

  /* ═══════════════════════════════════════════
     SHOW / HIDE / TOGGLE
     ═══════════════════════════════════════════ */

  show() {
    this.panel.classList.remove('collapsed');
    this.visible = true;
  }

  hide() {
    this.panel.classList.add('collapsed');
    this.visible = false;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  /* ═══════════════════════════════════════════
     TABS
     ═══════════════════════════════════════════ */

  _switchTab(tabId) {
    this.activeTab = tabId;
    this.shadow.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabId));
    this.shadow.querySelector('#tab-queue').style.display = tabId === 'queue' ? '' : 'none';
    this.shadow.querySelector('#tab-settings').style.display = tabId === 'settings' ? '' : 'none';

    if (tabId === 'settings') this._populateSettings();
  }

  /* ═══════════════════════════════════════════
     CARGA DE EXCEL
     ═══════════════════════════════════════════ */

  async _onFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const $ = (sel) => this.shadow.querySelector(sel);
    const statusEl = $('#upload-status');

    try {
      statusEl.innerHTML = '<span class="loading">⏳ Procesando archivo...</span>';

      const result = await ExcelParser.loadFile(file);
      this.patients = result.patients;
      this.currentIndex = 0;
      this.completed = new Set();

      let statusMsg = `✅ ${result.patients.length} paciente(s) cargados desde "${result.sheetName}".`;
      if (result.duplicatesRemoved > 0) {
        statusMsg += `<br>⚠️ ${result.duplicatesRemoved} duplicado(s) por NUMERO ID eliminados.`;
      }
      if (result.warnings.length > 0) {
        statusMsg += `<br><small>${result.warnings.slice(0, 5).join('<br>')}</small>`;
      }
      statusEl.innerHTML = `<span class="success">${statusMsg}</span>`;

      // Mostrar secciones
      $('#section-search').style.display = '';
      $('#section-patient').style.display = '';
      $('#section-tools').style.display = '';

      this._updatePatientDisplay();
      await this._saveState();

    } catch (err) {
      statusEl.innerHTML = `<span class="error">❌ Error: ${err.message}</span>`;
      console.error('[SI-APS] Error al cargar Excel:', err);
    }
  }

  /* ═══════════════════════════════════════════
     NAVEGACIÓN DE PACIENTES
     ═══════════════════════════════════════════ */

  _navigate(direction) {
    if (this.patients.length === 0) return;
    this.currentIndex = Math.max(0, Math.min(this.patients.length - 1, this.currentIndex + direction));
    this._updatePatientDisplay();
    this._saveState();
  }

  _goToPatient(index) {
    this.currentIndex = Math.max(0, Math.min(this.patients.length - 1, index));
    this._updatePatientDisplay();
    this._saveState();
  }

  _markCompleted() {
    if (this.patients.length === 0) return;
    const patient = this.patients[this.currentIndex];
    this.completed.add(patient.numeroId || this.currentIndex.toString());
    this._updatePatientDisplay();

    // Avanzar al siguiente no completado
    let next = this.currentIndex + 1;
    while (next < this.patients.length) {
      const p = this.patients[next];
      if (!this.completed.has(p.numeroId || next.toString())) break;
      next++;
    }
    if (next < this.patients.length) {
      this.currentIndex = next;
      this._updatePatientDisplay();
    }

    this._saveState();
  }

  _updatePatientDisplay() {
    const $ = (sel) => this.shadow.querySelector(sel);
    if (this.patients.length === 0) return;

    const patient = this.patients[this.currentIndex];
    const isCompleted = this.completed.has(patient.numeroId || this.currentIndex.toString());

    $('#patient-idx').textContent = this.currentIndex + 1;
    $('#patient-total').textContent = this.patients.length;
    $('#patient-name').textContent = patient.nombreCompleto || '(Sin nombre)';
    $('#patient-doc').textContent = `${patient.tipoId || '?'} ${patient.numeroId || '?'}`;
    $('#patient-completed-badge').style.display = isCompleted ? '' : 'none';

    // Edición de nombre
    $('#edit-primerNombre').value = patient.primerNombre || '';
    $('#edit-segundoNombre').value = patient.segundoNombre || '';
    $('#edit-primerApellido').value = patient.primerApellido || '';
    $('#edit-segundoApellido').value = patient.segundoApellido || '';

    // Estados de botones
    $('#btn-prev').disabled = this.currentIndex <= 0;
    $('#btn-next').disabled = this.currentIndex >= this.patients.length - 1;

    // Limpiar resultado anterior
    $('#fill-result').style.display = 'none';
  }

  /* ═══════════════════════════════════════════
     AUTOCOMPLETAR
     ═══════════════════════════════════════════ */

  async triggerAutofill() {
    if (this.patients.length === 0) {
      this._showResult('⚠️ No hay pacientes cargados. Sube un Excel primero.', 'warn');
      return;
    }

    const patient = this.patients[this.currentIndex];
    const $ = (sel) => this.shadow.querySelector(sel);

    const options = {
      overwrite: this.engine.settings.overwrite,
      familiaUnipersonal: $('#chk-unipersonal').checked,
    };

    this._showResult('⏳ Autocompletando...', 'loading');

    try {
      const result = await this.engine.fillForm(patient, options);

      let msg = `✅ <strong>${result.filled.length}</strong> campo(s) completado(s).`;
      if (result.skipped.length > 0) {
        msg += `<br>⏭️ ${result.skipped.length} ya tenían valor (no sobrescritos).`;
      }
      if (result.unresolved.length > 0) {
        msg += `<br>⚠️ ${result.unresolved.length} campo(s) obligatorio(s) no resuelto(s) (marcados en amarillo).`;
      }
      this._showResult(msg, result.unresolved.length > 0 ? 'warn' : 'success');
    } catch (err) {
      this._showResult(`❌ Error: ${err.message}`, 'error');
      console.error('[SI-APS] Error en autofill:', err);
    }
  }

  _showResult(html, type) {
    const el = this.shadow.querySelector('#fill-result');
    el.innerHTML = html;
    el.className = `result-box ${type}`;
    el.style.display = '';
  }

  /* ═══════════════════════════════════════════
     BÚSQUEDA
     ═══════════════════════════════════════════ */

  _onSearch(query) {
    const resultsEl = this.shadow.querySelector('#search-results');
    if (!query || query.length < 2) {
      resultsEl.style.display = 'none';
      return;
    }

    const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const matches = this.patients
      .map((p, i) => ({ patient: p, index: i }))
      .filter(({ patient }) => {
        const name = (patient.nombreCompleto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const doc = (patient.numeroId || '').toLowerCase();
        return name.includes(q) || doc.includes(q);
      })
      .slice(0, 10);

    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">Sin resultados</div>';
    } else {
      resultsEl.innerHTML = matches.map(({ patient, index }) => {
        const isCompleted = this.completed.has(patient.numeroId || index.toString());
        return `<div class="search-item ${isCompleted ? 'completed' : ''}" data-index="${index}">
          <span class="search-name">${patient.nombreCompleto || '?'}</span>
          <span class="search-doc">${patient.tipoId} ${patient.numeroId}</span>
          ${isCompleted ? '<span class="badge">✅</span>' : ''}
        </div>`;
      }).join('');

      // Click en resultado
      resultsEl.querySelectorAll('.search-item').forEach((item) => {
        item.addEventListener('click', () => {
          this._goToPatient(parseInt(item.dataset.index));
          resultsEl.style.display = 'none';
          this.shadow.querySelector('#siaps-search').value = '';
        });
      });
    }

    resultsEl.style.display = '';
  }

  /* ═══════════════════════════════════════════
     EDICIÓN MANUAL DE NOMBRE
     ═══════════════════════════════════════════ */

  _saveNameEdit() {
    if (this.patients.length === 0) return;
    const $ = (sel) => this.shadow.querySelector(sel);
    const patient = this.patients[this.currentIndex];

    patient.primerNombre = $('#edit-primerNombre').value.trim();
    patient.segundoNombre = $('#edit-segundoNombre').value.trim();
    patient.primerApellido = $('#edit-primerApellido').value.trim();
    patient.segundoApellido = $('#edit-segundoApellido').value.trim();
    patient.nombreCompleto = [patient.primerNombre, patient.segundoNombre, patient.primerApellido, patient.segundoApellido]
      .filter(Boolean).join(' ');

    this._updatePatientDisplay();
    this._saveState();
    this._showResult('✅ Nombre actualizado.', 'success');
  }

  /* ═══════════════════════════════════════════
     EXPORTAR MAPA DE CAMPOS
     ═══════════════════════════════════════════ */

  _exportFieldMap() {
    const map = this.engine.exportFieldMap();
    const json = JSON.stringify(map, null, 2);

    // Copiar al portapapeles
    navigator.clipboard.writeText(json).then(() => {
      this._showResult(`📋 Mapa de ${map.length} campo(s) copiado al portapapeles.`, 'success');
    }).catch(() => {
      // Fallback: descargar como archivo
      this._downloadJSON(map, 'siaps-field-map.json');
      this._showResult(`📥 Mapa de ${map.length} campo(s) descargado.`, 'success');
    });
  }

  _downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ═══════════════════════════════════════════
     CONFIGURACIÓN
     ═══════════════════════════════════════════ */

  _populateSettings() {
    const $ = (sel) => this.shadow.querySelector(sel);
    $('#cfg-neutral-options').value = this.engine.settings.neutralOptions.join('\n');
    $('#cfg-text-short').value = this.engine.settings.defaultTexts.short;
    $('#cfg-text-long').value = this.engine.settings.defaultTexts.long;
  }

  _saveSettings() {
    const $ = (sel) => this.shadow.querySelector(sel);
    this.engine.settings.neutralOptions = $('#cfg-neutral-options').value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    this.engine.settings.defaultTexts.short = $('#cfg-text-short').value.trim();
    this.engine.settings.defaultTexts.long = $('#cfg-text-long').value.trim();
    this._saveState();
    this._showResult('✅ Configuración guardada.', 'success');
    this._switchTab('queue');
  }

  _resetSettings() {
    this.engine.settings.neutralOptions = [
      'No', 'Ninguno', 'No aplica', 'Normal', 'Bueno',
      'Adecuado', 'Sin novedad', 'No refiere', 'Ninguna',
      'No presenta', 'Negativo', 'Sano'
    ];
    this.engine.settings.defaultTexts = {
      short: 'No aplica.',
      long: 'Sin observaciones adicionales. No refiere novedades al momento de la valoración.',
    };
    this._populateSettings();
    this._saveState();
  }

  async _clearAllData() {
    if (!confirm('¿Estás seguro de que deseas eliminar toda la información almacenada (pacientes, progreso, configuración)?')) return;
    this.patients = [];
    this.currentIndex = 0;
    this.completed = new Set();
    await chrome.storage.local.remove('siaps_state');

    const $ = (sel) => this.shadow.querySelector(sel);
    $('#section-search').style.display = 'none';
    $('#section-patient').style.display = 'none';
    $('#section-tools').style.display = 'none';
    $('#upload-status').innerHTML = '<span class="success">🗑️ Datos eliminados.</span>';
    $('#siaps-file-input').value = '';
  }

  /* ═══════════════════════════════════════════
     PERSISTENCIA (chrome.storage.local)
     ═══════════════════════════════════════════ */

  async _saveState() {
    try {
      const state = {
        patients: this.patients,
        currentIndex: this.currentIndex,
        completed: Array.from(this.completed),
        settings: {
          overwrite: this.engine.settings.overwrite,
          familiaUnipersonal: this.engine.settings.familiaUnipersonal,
          neutralOptions: this.engine.settings.neutralOptions,
          defaultTexts: this.engine.settings.defaultTexts,
        },
      };
      await chrome.storage.local.set({ siaps_state: state });
    } catch (err) {
      console.warn('[SI-APS] Error al guardar estado:', err);
    }
  }

  async _loadState() {
    try {
      const { siaps_state } = await chrome.storage.local.get('siaps_state');
      if (!siaps_state) return;

      if (siaps_state.patients && siaps_state.patients.length > 0) {
        this.patients = siaps_state.patients;
        this.currentIndex = siaps_state.currentIndex || 0;
        this.completed = new Set(siaps_state.completed || []);

        // Restaurar settings del motor
        if (siaps_state.settings) {
          Object.assign(this.engine.settings, siaps_state.settings);
        }

        // Mostrar secciones
        const $ = (sel) => this.shadow.querySelector(sel);
        $('#section-search').style.display = '';
        $('#section-patient').style.display = '';
        $('#section-tools').style.display = '';
        $('#upload-status').innerHTML = `<span class="success">♻️ ${this.patients.length} paciente(s) restaurados de sesión anterior.</span>`;
        $('#chk-overwrite').checked = this.engine.settings.overwrite;
        $('#chk-unipersonal').checked = this.engine.settings.familiaUnipersonal;

        this._updatePatientDisplay();
      }
    } catch (err) {
      console.warn('[SI-APS] Error al restaurar estado:', err);
    }
  }
}

console.log('[SI-APS] PanelUI cargado.');
