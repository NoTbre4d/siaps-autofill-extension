/**
 * SI-APS AutoFill — AutofillEngine
 *
 * Motor de autocompletado inteligente y framework-safe.
 * - Usa setters nativos del prototipo + dispatch de eventos.
 * - Detecta contexto de cada campo (label, placeholder, name, id, aria).
 * - Soporta selects en cascada con MutationObserver.
 * - Respeta minlength, maxlength, min, max, pattern.
 * - Nunca hace clic en botones de guardar/enviar.
 *
 * API pública:
 *   engine.fillForm(patientData, options) -> Promise<{ filled, unresolved, skipped }>
 *   engine.exportFieldMap() -> Array<fieldMeta>
 */

// eslint-disable-next-line no-unused-vars
class AutofillEngine {

  constructor() {
    // Reglas configurables (se sobreescriben desde el panel)
    this.settings = {
      overwrite: false,
      familiaUnipersonal: true,
      neutralOptions: [
        'No', 'Ninguno', 'No aplica', 'Normal', 'Bueno',
        'Adecuado', 'Sin novedad', 'No refiere', 'Ninguna',
        'No presenta', 'Negativo', 'Sano'
      ],
      defaultTexts: {
        short: 'No aplica.',
        long: 'Sin observaciones adicionales. No refiere novedades al momento de la valoración.',
      },
    };
  }

  /* ═══════════════════════════════════════════
     FRAMEWORK-SAFE VALUE SETTING
     ═══════════════════════════════════════════ */

  _getPrototypeSetter(element) {
    const tag = element.tagName;
    if (tag === 'SELECT') {
      return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    }
    if (tag === 'TEXTAREA') {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    }
    return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  }

  _setNativeValue(element, value) {
    const setter = this._getPrototypeSetter(element);
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
    // Despachar eventos en orden para frameworks reactivos
    element.dispatchEvent(new Event('focus', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  _setChecked(element, checked) {
    if (element.checked === checked) return;
    element.checked = checked;
    element.dispatchEvent(new Event('click', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  _selectOption(selectEl, value) {
    // Para <select> nativos
    const option = Array.from(selectEl.options).find(
      (o) => o.value === value || o.textContent.trim() === value
    );
    if (option) {
      selectEl.selectedIndex = option.index;
      this._setNativeValue(selectEl, option.value);
      return true;
    }
    return false;
  }

  /* ═══════════════════════════════════════════
     DETECCIÓN DE CONTEXTO DE CAMPO
     ═══════════════════════════════════════════ */

  _getFieldContext(field) {
    const ctx = {
      element: field,
      tag: field.tagName.toLowerCase(),
      type: (field.type || '').toLowerCase(),
      id: field.id || '',
      name: field.name || '',
      placeholder: field.placeholder || '',
      ariaLabel: field.getAttribute('aria-label') || '',
      minlength: parseInt(field.getAttribute('minlength')) || 0,
      maxlength: parseInt(field.getAttribute('maxlength')) || Infinity,
      min: field.getAttribute('min') || '',
      max: field.getAttribute('max') || '',
      step: field.getAttribute('step') || '',
      required: field.required || field.getAttribute('aria-required') === 'true',
      pattern: field.getAttribute('pattern') || '',
      label: '',
      nearbyText: '',
      options: [],
      role: field.getAttribute('role') || '',
      classList: Array.from(field.classList),
    };

    // Buscar label asociada
    if (field.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
      if (lbl) ctx.label = lbl.textContent.trim();
    }
    if (!ctx.label) {
      const parentLabel = field.closest('label');
      if (parentLabel) {
        // Texto del label sin el texto de los hijos que son inputs
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll('input, select, textarea').forEach((e) => e.remove());
        ctx.label = clone.textContent.trim();
      }
    }

    // aria-label y aria-labelledby
    if (!ctx.label && field.getAttribute('aria-labelledby')) {
      const lblId = field.getAttribute('aria-labelledby');
      const lblEl = document.getElementById(lblId);
      if (lblEl) ctx.label = lblEl.textContent.trim();
    }

    // Texto cercano (hermanos del padre)
    const parent = field.closest('.form-group, .form-field, .field, .col, .column, td, th, div');
    if (parent) {
      const textContent = [];
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) textContent.push(node.textContent.trim());
        if (node.nodeType === Node.ELEMENT_NODE && ['LABEL', 'SPAN', 'P', 'STRONG', 'B'].includes(node.tagName)) {
          textContent.push(node.textContent.trim());
        }
      }
      ctx.nearbyText = textContent.filter(Boolean).join(' ');
    }

    // Opciones de <select>
    if (ctx.tag === 'select') {
      ctx.options = Array.from(field.options).map((o) => ({
        value: o.value,
        text: o.textContent.trim(),
        disabled: o.disabled,
      }));
    }

    // Texto de búsqueda combinado
    ctx.searchText = [
      ctx.label, ctx.placeholder, ctx.ariaLabel,
      ctx.name, ctx.id, ctx.nearbyText
    ].join(' ').toLowerCase();

    return ctx;
  }

  /* ═══════════════════════════════════════════
     UTILIDADES DE MATCHING
     ═══════════════════════════════════════════ */

  _norm(str) {
    return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  _matches(ctx, keywords) {
    const st = this._norm(ctx.searchText);
    return keywords.some((kw) => st.includes(this._norm(kw)));
  }

  _hasValue(field) {
    if (field.tagName === 'SELECT') {
      const val = field.value;
      const text = field.options[field.selectedIndex]?.textContent?.trim() || '';
      return val && val !== '' && val !== '0' &&
        !['seleccione', 'seleccione...', '--', '---', 'seleccionar', '-- seleccione --']
          .includes(this._norm(text));
    }
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked;
    return field.value && field.value.trim() !== '';
  }

  _isPlaceholderOption(opt) {
    const v = (opt.value || '').trim();
    const t = this._norm(opt.text);
    return !v || v === '0' || v === '-1' || v === 'null' || v === 'undefined' ||
      ['seleccione', 'seleccione...', '--', '---', 'seleccionar', '-- seleccione --',
       'elegir', 'escoja', 'opcion', 'seleccionar...', ''].includes(t) ||
      opt.disabled;
  }

  _findBestOption(ctx, preferredValues) {
    const validOpts = ctx.options.filter((o) => !this._isPlaceholderOption(o));
    if (validOpts.length === 0) return null;

    // Buscar coincidencia exacta con valores preferidos
    for (const pref of preferredValues) {
      const np = this._norm(pref);
      const exact = validOpts.find(
        (o) => this._norm(o.text) === np || this._norm(o.value) === np
      );
      if (exact) return exact.value;
    }

    // Buscar coincidencia parcial (contiene)
    for (const pref of preferredValues) {
      const np = this._norm(pref);
      if (np.length < 2) continue;
      const partial = validOpts.find(
        (o) => this._norm(o.text).includes(np) || np.includes(this._norm(o.text))
      );
      if (partial) return partial.value;
    }

    return null;
  }

  /* ═══════════════════════════════════════════
     DETERMINACIÓN DE VALOR
     ═══════════════════════════════════════════ */

  _determineValue(ctx, patient, opts) {
    const tag = ctx.tag;
    const type = ctx.type;

    // ── 1. DATOS DEL PACIENTE (match por contexto) ──

    // Nombre completo
    if (this._matches(ctx, ['nombre completo', 'nombre del usuario', 'nombre usuario', 'full name', 'nombre_completo'])) {
      return patient.nombreCompleto || '';
    }

    // Primer nombre
    if (this._matches(ctx, ['primer nombre', 'first name', 'primer_nombre', 'nombres', 'name1'])) {
      if (this._matches(ctx, ['segundo', 'second', '2'])) {
        return patient.segundoNombre || '';
      }
      return patient.primerNombre || '';
    }

    // Segundo nombre
    if (this._matches(ctx, ['segundo nombre', 'second name', 'segundo_nombre', 'name2', 'otros nombres'])) {
      return patient.segundoNombre || '';
    }

    // Primer apellido
    if (this._matches(ctx, ['primer apellido', 'apellido paterno', 'last name', 'primer_apellido', 'apellido1', 'apellido 1'])) {
      return patient.primerApellido || '';
    }

    // Segundo apellido
    if (this._matches(ctx, ['segundo apellido', 'apellido materno', 'segundo_apellido', 'apellido2', 'apellido 2'])) {
      return patient.segundoApellido || '';
    }

    // Apellidos (campo combinado)
    if (this._matches(ctx, ['apellidos', 'apellido']) && !this._matches(ctx, ['primer', 'segundo', '1', '2'])) {
      return [patient.primerApellido, patient.segundoApellido].filter(Boolean).join(' ');
    }

    // Tipo de documento
    if (this._matches(ctx, ['tipo de documento', 'tipo documento', 'tipo id', 'tipo_id', 'tipo_documento', 'doc type', 'tipo identificacion'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.tipoId, this._expandTipoId(patient.tipoId)]);
      }
      return patient.tipoId || '';
    }

    // Número de documento / cédula
    if (this._matches(ctx, ['numero de documento', 'numero documento', 'numero id', 'numero_id', 'cedula', 'identificacion', 'nro documento',
                             'num documento', 'documento', 'doc number', 'numero_documento', 'no. documento', 'n documento', 'nro. identificacion'])) {
      return patient.numeroId || '';
    }

    // Dirección
    if (this._matches(ctx, ['direccion', 'address', 'dir.', 'domicilio', 'residencia'])) {
      return patient.direccion || 'Sin dirección registrada';
    }

    // Teléfono
    if (this._matches(ctx, ['telefono', 'celular', 'phone', 'tel.', 'movil', 'contacto'])) {
      return patient.telefono || '';
    }

    // Barrio / Vereda
    if (this._matches(ctx, ['barrio', 'vereda', 'neighborhood', 'localidad', 'sector', 'comuna'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.barrio]);
      }
      return patient.barrio || '';
    }

    // Departamento
    if (this._matches(ctx, ['departamento', 'dpto', 'department', 'estado', 'provincia'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.departamento]);
      }
      return patient.departamento || '';
    }

    // Municipio / Ciudad
    if (this._matches(ctx, ['municipio', 'ciudad', 'city', 'municipality', 'poblacion'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.municipio]);
      }
      return patient.municipio || '';
    }

    // EPS
    if (this._matches(ctx, ['eps', 'aseguradora', 'entidad', 'regimen', 'asegurador', 'eapb'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.eps]);
      }
      return patient.eps || '';
    }

    // Fecha
    if (this._matches(ctx, ['fecha', 'date', 'fch'])) {
      if (type === 'date') {
        return patient.fecha || this._todayISO();
      }
      return patient.fecha || this._todayISO();
    }

    // Discapacidad
    if (this._matches(ctx, ['discapacidad', 'disability', 'condicion discapacidad'])) {
      if (tag === 'select') {
        const val = patient.discapacidad || '';
        return this._findBestOption(ctx, [val, 'No', 'Ninguna', 'No aplica', 'Sin discapacidad']);
      }
      return patient.discapacidad || 'No';
    }

    // Adulto mayor
    if (this._matches(ctx, ['adulto mayor', 'persona mayor', 'tercera edad', 'senior'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.adultoMayor, 'No', 'No aplica']);
      }
      return patient.adultoMayor || 'No';
    }

    // ── 2. REGLAS FAMILIA UNIPERSONAL ──

    if (opts.familiaUnipersonal) {
      // Número de integrantes / personas / miembros
      if (this._matches(ctx, ['integrantes', 'personas', 'miembros', 'num personas', 'numero personas',
                               'total personas', 'total integrantes', 'miembros hogar', 'habitantes'])) {
        return '1';
      }

      // Tipo de familia
      if (this._matches(ctx, ['tipo de familia', 'tipo familia', 'composicion familiar', 'tipo_familia', 'tipologia familiar'])) {
        if (tag === 'select') {
          return this._findBestOption(ctx, ['Unipersonal', 'Persona sola', 'Individual']);
        }
        return 'Unipersonal';
      }

      // Parentesco
      if (this._matches(ctx, ['parentesco', 'relacion', 'parentesco familiar', 'vinculo', 'relacion familiar'])) {
        if (tag === 'select') {
          return this._findBestOption(ctx, ['Jefe de hogar', 'Jefe del hogar', 'Jefe(a) de hogar', 'Jefe', 'Cabeza de familia', 'Cabeza de hogar']);
        }
        return 'Jefe de hogar';
      }
    }

    // ── 3. CAMPOS ASUMIDOS (NO del Excel) ──

    if (tag === 'select') {
      return this._findBestOption(ctx, this.settings.neutralOptions) ||
        this._getFirstValidOption(ctx);
    }

    if (type === 'number') {
      return this._getDefaultNumber(ctx);
    }

    if (type === 'date') {
      return this._todayISO();
    }

    if (type === 'checkbox') {
      return null; // No marcar checkboxes desconocidos por defecto
    }

    if (type === 'radio') {
      return null; // Se manejan en grupo
    }

    if (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'url', 'email', ''].includes(type))) {
      if (ctx.minlength >= 10 || this._matches(ctx, ['observacion', 'descripcion', 'comentario', 'nota', 'detalle', 'justificacion', 'motivo'])) {
        return this._generateDefaultText(ctx);
      }
      // Campo de texto genérico corto
      if (ctx.required) {
        return this._generateDefaultText(ctx);
      }
      return null; // No llenar campos opcionales desconocidos
    }

    return null;
  }

  /* ═══════════════════════════════════════════
     HELPERS DE VALORES POR DEFECTO
     ═══════════════════════════════════════════ */

  _expandTipoId(code) {
    const map = {
      'CC': 'Cédula de Ciudadanía',
      'TI': 'Tarjeta de Identidad',
      'RC': 'Registro Civil',
      'CE': 'Cédula de Extranjería',
      'PA': 'Pasaporte',
      'PE': 'Permiso Especial de Permanencia',
      'MS': 'Menor sin identificación',
      'AS': 'Adulto sin identificación',
      'NV': 'Certificado de nacido vivo',
    };
    return map[(code || '').toUpperCase()] || code || '';
  }

  _todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _getFirstValidOption(ctx) {
    const valid = ctx.options.find((o) => !this._isPlaceholderOption(o));
    return valid ? valid.value : null;
  }

  _getDefaultNumber(ctx) {
    // Si es campo de integrantes/personas, poner 1
    if (this._matches(ctx, ['integrantes', 'personas', 'miembros', 'habitantes'])) return '1';

    const min = parseFloat(ctx.min) || 0;
    const max = parseFloat(ctx.max) || 999999;
    const step = parseFloat(ctx.step) || 1;

    // Usar el mínimo válido
    let val = Math.max(min, 0);
    if (val === 0 && min > 0) val = min;
    if (val > max) val = max;

    // Ajustar al step
    if (step > 0) {
      val = Math.ceil(val / step) * step;
      if (val > max) val = Math.floor(max / step) * step;
    }

    return val.toString();
  }

  _generateDefaultText(ctx) {
    const minLen = Math.max(ctx.minlength || 0, 1);
    const maxLen = ctx.maxlength === Infinity ? 500 : (ctx.maxlength || 500);

    const templates = [
      'Sin observaciones adicionales.',
      'No refiere novedades al momento.',
      'No aplica para este caso.',
      'Sin información adicional por reportar.',
      'Paciente sin novedades relevantes al momento de la valoración.',
    ];

    // Buscar una que encaje
    for (const t of templates) {
      if (t.length >= minLen && t.length <= maxLen) return t;
    }

    // Construir una que encaje
    let text = this.settings.defaultTexts.long;
    if (text.length < minLen) {
      while (text.length < minLen) {
        text += ' No refiere novedades adicionales.';
      }
    }
    if (text.length > maxLen) {
      text = text.substring(0, maxLen - 1) + '.';
    }
    return text;
  }

  /* ═══════════════════════════════════════════
     MANEJO DE RADIOS EN GRUPO
     ═══════════════════════════════════════════ */

  _handleRadioGroups(patient, opts) {
    const results = [];
    const processed = new Set();

    document.querySelectorAll('input[type="radio"]:not([disabled])').forEach((radio) => {
      if (processed.has(radio.name)) return;
      processed.add(radio.name);

      if (!opts.overwrite) {
        const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radio.name)}"]`);
        const anyChecked = Array.from(group).some((r) => r.checked);
        if (anyChecked) return;
      }

      const group = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radio.name)}"]`)
      );

      // Intentar determinar qué pide este grupo
      const ctx = this._getFieldContext(radio);

      // Buscar el radio con valor neutral/negativo
      let target = null;

      // Primero verificar si es un campo de datos del paciente
      if (this._matches(ctx, ['tipo de documento', 'tipo documento', 'tipo id'])) {
        target = group.find((r) => {
          const lbl = this._getRadioLabel(r);
          return this._norm(lbl).includes(this._norm(patient.tipoId)) ||
            this._norm(lbl).includes(this._norm(this._expandTipoId(patient.tipoId)));
        });
      }

      // Si es campo asumido, buscar opción neutral
      if (!target) {
        for (const pref of this.settings.neutralOptions) {
          target = group.find((r) => {
            const lbl = this._getRadioLabel(r);
            return this._norm(lbl) === this._norm(pref);
          });
          if (target) break;
        }
      }

      // Si no hay neutral, seleccionar la primera opción
      if (!target && group.length > 0) {
        target = group[0];
      }

      if (target) {
        this._setChecked(target, true);
        results.push({ field: target, context: ctx, value: target.value });
      }
    });

    return results;
  }

  _getRadioLabel(radio) {
    if (radio.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const parentLabel = radio.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input').forEach((e) => e.remove());
      return clone.textContent.trim();
    }
    return radio.value || '';
  }

  /* ═══════════════════════════════════════════
     SCAN DE CAMPOS VISIBLES
     ═══════════════════════════════════════════ */

  _scanVisibleFields() {
    const selectors = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([disabled]):not([readonly])',
      'textarea:not([disabled]):not([readonly])',
      'select:not([disabled])',
    ];

    const fields = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        // Verificar que sea visible
        if (this._isVisible(el)) {
          fields.push(el);
        }
      });
    }
    return fields;
  }

  _isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && getComputedStyle(el).position !== 'fixed') {
      return false;
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  /* ═══════════════════════════════════════════
     SELECTS EN CASCADA
     ═══════════════════════════════════════════ */

  async _handleCascadeSelects(patient, opts, results) {
    // Esperar a que selects hijos se pueblen tras cambiar padres
    await this._sleep(350);

    // Segunda pasada: buscar selects vacíos/con placeholder que ahora tengan opciones
    const selects = Array.from(document.querySelectorAll('select:not([disabled])')).filter(
      (s) => this._isVisible(s) && !this._hasValue(s)
    );

    for (const sel of selects) {
      // Verificar si tiene más opciones que antes (se pobló dinámicamente)
      if (sel.options.length <= 1) continue;

      const ctx = this._getFieldContext(sel);
      const value = this._determineValue(ctx, patient, opts);
      if (value !== null) {
        this._selectOption(sel, value);
        this._setNativeValue(sel, value);
        results.filled.push({ field: sel, context: ctx, value });
        this._highlightField(sel, 'filled');

        // Esperar por posibles sub-cascadas
        await this._sleep(300);
      }
    }

    // Tercera pasada (para sub-cascadas)
    await this._sleep(300);
    const finalSelects = Array.from(document.querySelectorAll('select:not([disabled])')).filter(
      (s) => this._isVisible(s) && !this._hasValue(s) && s.options.length > 1
    );

    for (const sel of finalSelects) {
      const ctx = this._getFieldContext(sel);
      const value = this._determineValue(ctx, patient, opts);
      if (value !== null) {
        this._selectOption(sel, value);
        this._setNativeValue(sel, value);
        results.filled.push({ field: sel, context: ctx, value });
        this._highlightField(sel, 'filled');
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ═══════════════════════════════════════════
     CUSTOM CONTROLS SUPPORT
     ═══════════════════════════════════════════ */

  _handleCustomControls(patient, opts, results) {
    // mat-select (Angular Material)
    document.querySelectorAll('mat-select, [role="combobox"], .ng-select, .select2-container').forEach((el) => {
      if (!this._isVisible(el)) return;

      const ctx = this._getFieldContext(el);
      const value = this._determineValue(ctx, patient, opts);
      if (value === null) return;

      // Intentar abrir el combobox clickeando
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      setTimeout(() => {
        // Buscar opciones visibles (panel de dropdown)
        const optionSelectors = [
          'mat-option', '[role="option"]', '.ng-option', '.select2-results__option'
        ];
        for (const sel of optionSelectors) {
          const opts = document.querySelectorAll(sel);
          for (const opt of opts) {
            if (this._norm(opt.textContent).includes(this._norm(value))) {
              opt.click();
              results.filled.push({ field: el, context: ctx, value });
              this._highlightField(el, 'filled');
              return;
            }
          }
        }
      }, 200);
    });
  }

  /* ═══════════════════════════════════════════
     FEEDBACK VISUAL
     ═══════════════════════════════════════════ */

  _highlightField(field, type) {
    const prevTransition = field.style.transition;
    field.style.transition = 'box-shadow 0.3s, border-color 0.3s';

    if (type === 'filled') {
      field.style.boxShadow = '0 0 0 2px rgba(76, 175, 80, 0.5)';
      field.style.borderColor = '#4CAF50';
      field.setAttribute('data-siaps-filled', 'true');
    } else if (type === 'unresolved') {
      field.style.boxShadow = '0 0 0 2px rgba(255, 193, 7, 0.5)';
      field.style.borderColor = '#FFC107';
      field.setAttribute('data-siaps-unresolved', 'true');
    }

    // Quitar highlight después de 8 segundos
    setTimeout(() => {
      field.style.boxShadow = '';
      field.style.borderColor = '';
      field.style.transition = prevTransition;
    }, 8000);
  }

  _clearHighlights() {
    document.querySelectorAll('[data-siaps-filled], [data-siaps-unresolved]').forEach((el) => {
      el.style.boxShadow = '';
      el.style.borderColor = '';
      el.removeAttribute('data-siaps-filled');
      el.removeAttribute('data-siaps-unresolved');
    });
  }

  /* ═══════════════════════════════════════════
     FUNCIÓN PRINCIPAL
     ═══════════════════════════════════════════ */

  async fillForm(patient, options = {}) {
    const opts = { ...this.settings, ...options };
    const results = { filled: [], unresolved: [], skipped: [] };

    this._clearHighlights();

    // 1. Campos estándar (inputs, textareas, selects)
    const fields = this._scanVisibleFields();

    for (const field of fields) {
      const ctx = this._getFieldContext(field);

      // Respetar overwrite
      if (!opts.overwrite && this._hasValue(field)) {
        results.skipped.push({ field, context: ctx, reason: 'already-filled' });
        continue;
      }

      const value = this._determineValue(ctx, patient, opts);

      if (value !== null && value !== undefined && value !== '') {
        if (ctx.tag === 'select') {
          const success = this._selectOption(field, value);
          if (!success) {
            // Intentar fuzzy
            const fuzzyVal = this._findBestOption(ctx, [value]);
            if (fuzzyVal) {
              this._selectOption(field, fuzzyVal);
              this._setNativeValue(field, fuzzyVal);
            }
          }
        } else {
          this._setNativeValue(field, value);
        }
        results.filled.push({ field, context: ctx, value });
        this._highlightField(field, 'filled');
      } else if (ctx.required) {
        results.unresolved.push({ field, context: ctx });
        this._highlightField(field, 'unresolved');
      }
    }

    // 2. Radio buttons en grupo
    const radioResults = this._handleRadioGroups(patient, opts);
    results.filled.push(...radioResults);

    // 3. Custom controls
    this._handleCustomControls(patient, opts, results);

    // 4. Selects en cascada (esperar y hacer pasadas adicionales)
    await this._handleCascadeSelects(patient, opts, results);

    return results;
  }

  /* ═══════════════════════════════════════════
     EXPORTAR MAPA DE CAMPOS (SIN DATOS PERSONALES)
     ═══════════════════════════════════════════ */

  exportFieldMap() {
    const allFields = [
      ...document.querySelectorAll('input, textarea, select'),
    ].filter((el) => this._isVisible(el));

    return allFields.map((el) => {
      const ctx = this._getFieldContext(el);
      const meta = {
        tag: ctx.tag,
        type: ctx.type || undefined,
        id: ctx.id || undefined,
        name: ctx.name || undefined,
        label: ctx.label || undefined,
        placeholder: ctx.placeholder || undefined,
        ariaLabel: ctx.ariaLabel || undefined,
        required: ctx.required || undefined,
        minlength: ctx.minlength > 0 ? ctx.minlength : undefined,
        maxlength: ctx.maxlength < Infinity ? ctx.maxlength : undefined,
        min: ctx.min || undefined,
        max: ctx.max || undefined,
        step: ctx.step || undefined,
        pattern: ctx.pattern || undefined,
        role: ctx.role || undefined,
      };

      // Opciones de select (sin valores personales)
      if (ctx.tag === 'select') {
        meta.options = ctx.options.map((o) => ({ value: o.value, text: o.text }));
      }

      // Radios del mismo grupo
      if (ctx.type === 'radio' && ctx.name) {
        const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(ctx.name)}"]`);
        meta.radioOptions = Array.from(radios).map((r) => ({
          value: r.value,
          label: this._getRadioLabel(r),
        }));
      }

      // Limpiar undefined
      Object.keys(meta).forEach((k) => { if (meta[k] === undefined) delete meta[k]; });

      return meta;
    });
  }
}

console.log('[SI-APS] AutofillEngine cargado.');
