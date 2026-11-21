/**
 * SI-APS AutoFill — PanelUI
 *
 * Panel flotante lateral con Shadow DOM.
 * Gestiona:
 *   - Carga de Excel y cola de pacientes.
 *   - Búsqueda, navegación, marcado de completados.
 *   - Módulo activo y Sistema de Plantillas por Módulo (Grabar / Replicar / Borrar).
 *   - Botón principal de autocompletado (Plantilla + Excel / Automático).
 *   - Pestaña de configuración de valores asumidos.
 *   - Exportar mapa de campos sin datos personales.
 *   - Persistencia completa en chrome.storage.local.
 */

// eslint-disable-next-line no-unused-vars
class PanelUI {

  constructor() {
    this.engine = null;
    this.patients = [];
    this.currentIndex = 0;
    this.completed = new Set();
    this.templates = {}; // { [moduleName]: templateObject }
    this.activeModule = 'Información General';
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

    // Crear host Shadow DOM aislado
    this.host = document.createElement('div');
    this.host.id = 'siaps-autofill-host';
    this.host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647; font-family: system-ui, sans-serif;';
    document.body.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'closed' });

    // Cargar CSS
    await this._loadCSS();

    // Renderizar panel
    this._render();

    // Restaurar estado persistido y plantillas
    await this._loadState();

    // Detectar módulo inicial
    this._autoDetectModule();

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

          <!-- Sección: Módulo y Plantilla -->
          <div class="section module-section">
            <div class="module-header-row">
              <label class="module-title-label">📂 Módulo:</label>
              <select id="sel-active-module" class="module-select">
                <option value="Información General">Información General</option>
                <option value="Entorno y Vivienda">Entorno y Vivienda</option>
                <option value="Familia">Familia</option>
                <option value="Integrantes">Integrantes</option>
              </select>
              <button id="btn-detect-module" title="Detectar pestaña actual de SI-APS">🔍</button>
            </div>

            <div class="template-status-row">
              <span id="template-badge" class="badge-template none">⚪ Sin plantilla (modo automático)</span>
            </div>

            <div class="template-btn-row">
              <button id="btn-save-template" class="btn-sm btn-outline" title="Guarda las respuestas de esta pantalla como plantilla para este módulo">
                💾 Guardar plantilla
              </button>
              <button id="btn-delete-template" class="btn-sm btn-danger-sm" style="display:none;" title="Borrar la plantilla guardada para este módulo">
                🗑️ Borrar
              </button>
            </div>
          </div>

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
                ⚡ Llenar módulo (Plantilla + Excel)
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

    // Módulo activo
    $('#sel-active-module').addEventListener('change', (e) => {
      this.activeModule = e.target.value;
      this._updateTemplateBadge();
    });

    $('#btn-detect-module').addEventListener('click', () => {
      this._autoDetectModule();
    });

    // Guardar / Borrar plantilla
    $('#btn-save-template').addEventListener('click', () => this._saveCurrentModuleTemplate());
    $('#btn-delete-template').addEventListener('click', () => this._deleteCurrentModuleTemplate());

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
     SISTEMA DE PLANTILLAS POR MÓDULO
     ═══════════════════════════════════════════ */

  _autoDetectModule() {
    const detected = this.engine.detectActiveModuleName();
    if (detected) {
      this.activeModule = detected;
      const select = this.shadow.querySelector('#sel-active-module');
      if (select) select.value = detected;
      this._updateTemplateBadge();
    }
  }

  _updateTemplateBadge() {
    const badge = this.shadow.querySelector('#template-badge');
    const deleteBtn = this.shadow.querySelector('#btn-delete-template');
    const autofillBtn = this.shadow.querySelector('#btn-autofill');

    const template = this.templates[this.activeModule];

    if (template && template.fields && template.fields.length > 0) {
      badge.textContent = `🟢 Plantilla activa: Sí (${template.fields.length} campos)`;
      badge.className = 'badge-template active';
      deleteBtn.style.display = '';
      if (autofillBtn) autofillBtn.textContent = '⚡ Llenar módulo (Plantilla + Excel)';
    } else {
      badge.textContent = '⚪ Sin plantilla (modo automático)';
      badge.className = 'badge-template none';
      deleteBtn.style.display = 'none';
      if (autofillBtn) autofillBtn.textContent = '⚡ Autocompletar módulo (Automático)';
    }
  }

  async _saveCurrentModuleTemplate() {
    try {
      const snapshot = this.engine.extractModuleSnapshot(this.activeModule);
      if (snapshot.fields.length === 0) {
        this._showResult('⚠️ No se detectaron campos con valor en pantalla para guardar.', 'warn');
        return;
      }

      this.templates[this.activeModule] = snapshot;
      await chrome.storage.local.set({ siaps_templates: this.templates });

      this._updateTemplateBadge();
      this._showResult(`💾 Plantilla guardada para <strong>${this.activeModule}</strong> con ${snapshot.fields.length} campos.`, 'success');
    } catch (err) {
      this._showResult(`❌ Error al guardar plantilla: ${err.message}`, 'error');
    }
  }

  async _deleteCurrentModuleTemplate() {
    if (!confirm(`¿Eliminar la plantilla guardada para el módulo "${this.activeModule}"?`)) return;

    delete this.templates[this.activeModule];
    await chrome.storage.local.set({ siaps_templates: this.templates });

    this._updateTemplateBadge();
    this._showResult(`🗑️ Plantilla eliminada para "${this.activeModule}".`, 'success');
  }

  /* ═══════════════════════════════════════════
     SHOW / HIDE / TOGGLE
     ═══════════════════════════════════════════ */

  show() {
    this.panel.classList.remove('collapsed');
    this.visible = true;
    this._autoDetectModule();
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

    $('#edit-primerNombre').value = patient.primerNombre || '';
    $('#edit-segundoNombre').value = patient.segundoNombre || '';
    $('#edit-primerApellido').value = patient.primerApellido || '';
    $('#edit-segundoApellido').value = patient.segundoApellido || '';

    $('#btn-prev').disabled = this.currentIndex <= 0;
    $('#btn-next').disabled = this.currentIndex >= this.patients.length - 1;

    $('#fill-result').style.display = 'none';
  }

  /* ═══════════════════════════════════════════
     AUTOCOMPLETAR (Plantilla o Barrido Automático)
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

    const hasTemplate = Boolean(this.templates[this.activeModule]);
    this._showResult(`⏳ Diligenciando módulo "${this.activeModule}" (${hasTemplate ? 'con Plantilla' : 'modo automático'})...`, 'loading');

    try {
      let result;
      if (hasTemplate) {
        result = await this.engine.applyModuleTemplate(this.templates[this.activeModule], patient, options);
      } else {
        result = await this.engine.fillForm(patient, options);
      }

      const total = result.filled.length;
      let msg = `✅ <strong>${total}</strong> campo(s) diligenciado(s) en <strong>${this.activeModule}</strong>.`;

      if (hasTemplate) {
        msg += `<br><small style="color:#2E7D32;">🎯 Aplicada plantilla guardada + datos del paciente activo.</small>`;
      } else {
        const f1 = result.filled.filter((f) => f.phase === '1').length;
        const f2 = result.filled.filter((f) => f.phase === '2').length;
        msg += `<br><small style="color:#2E7D32;">🔹 Fase 1 (Excel): ${f1} | 🔸 Fase 2 (Asumidos): ${f2}</small>`;
      }

      if (result.skipped && result.skipped.length > 0) {
        msg += `<br>⏭️ ${result.skipped.length} campos ya tenían valor (no sobrescritos).`;
      }
      if (result.unresolved && result.unresolved.length > 0) {
        msg += `<br>⚠️ ${result.unresolved.length} campos obligatorios sin resolver (marcados en amarillo).`;
      }

      this._showResult(msg, (result.unresolved && result.unresolved.length > 0) ? 'warn' : 'success');
    } catch (err) {
      this._showResult(`❌ Error en autocompletado: ${err.message}`, 'error');
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
     EXPORTAR MAPA DE CAMPOS (JSON)
     ═══════════════════════════════════════════ */

  _exportFieldMap() {
    const map = this.engine.exportFieldMap();
    const json = JSON.stringify(map, null, 2);

    navigator.clipboard.writeText(json).then(() => {
      this._showResult(`📋 Mapa de ${map.length} campo(s) copiado al portapapeles.`, 'success');
    }).catch(() => {
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
      'No', 'Ninguno', 'Ninguna', 'No aplica', 'N/A', 'Normal',
      'Bueno', 'Buena', 'Adecuado', 'Sin novedad', 'No refiere',
      'Urbano', 'Propio', 'Si', 'No presenta', 'Negativo', 'Sano'
    ];
    this.engine.settings.defaultTexts = {
      short: 'No aplica.',
      long: 'No refiere novedades durante la caracterización.',
    };
    this._populateSettings();
    this._saveState();
  }

  async _clearAllData() {
    if (!confirm('¿Estás seguro de que deseas eliminar toda la información almacenada (pacientes, plantillas, configuración)?')) return;
    this.patients = [];
    this.currentIndex = 0;
    this.completed = new Set();
    this.templates = {};
    await chrome.storage.local.remove(['siaps_state', 'siaps_templates']);

    const $ = (sel) => this.shadow.querySelector(sel);
    $('#section-search').style.display = 'none';
    $('#section-patient').style.display = 'none';
    $('#section-tools').style.display = 'none';
    $('#upload-status').innerHTML = '<span class="success">🗑️ Datos eliminados.</span>';
    $('#siaps-file-input').value = '';
    this._updateTemplateBadge();
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
      // 1. Cargar estado de pacientes y configuración
      const { siaps_state, siaps_templates } = await chrome.storage.local.get(['siaps_state', 'siaps_templates']);

      if (siaps_templates) {
        this.templates = siaps_templates;
        this.engine.templates = siaps_templates;
      }

      if (siaps_state) {
        if (siaps_state.patients && siaps_state.patients.length > 0) {
          this.patients = siaps_state.patients;
          this.currentIndex = siaps_state.currentIndex || 0;
          this.completed = new Set(siaps_state.completed || []);

          if (siaps_state.settings) {
            Object.assign(this.engine.settings, siaps_state.settings);
          }

          const $ = (sel) => this.shadow.querySelector(sel);
          $('#section-search').style.display = '';
          $('#section-patient').style.display = '';
          $('#section-tools').style.display = '';
          $('#upload-status').innerHTML = `<span class="success">♻️ ${this.patients.length} paciente(s) restaurados de sesión anterior.</span>`;
          $('#chk-overwrite').checked = this.engine.settings.overwrite;
          $('#chk-unipersonal').checked = this.engine.settings.familiaUnipersonal;

          this._updatePatientDisplay();
        }
      }

      this._updateTemplateBadge();
    } catch (err) {
      console.warn('[SI-APS] Error al restaurar estado:', err);
    }
  }
}

console.log('[SI-APS] PanelUI cargado.');
