/**
 * SI-APS AutoFill — AutofillEngine (Motor de Barrido Total con Soporte de Plantillas por Módulo)
 *
 * Mejoras clave:
 *  1. Detección universal de desplegables personalizados:
 *     - Detecta <select> y cualquier contenedor (div, button, span, input readonly) cuyo texto
 *       comience por "Seleccione" o contenga chevrones/atributos combobox.
 *     - Secuencia de eventos reales (mousedown -> mouseup -> click) + espera por popovers en portal (body).
 *     - Pausa de 200 ms entre selecciones para evitar colisiones.
 *  2. Checkboxes y Radios estilizados:
 *     - Detecta inputs ocultos por CSS (opacity: 0, 0px) si su <label> o contenedor es visible.
 *     - Clic sobre el <label> visual para actualizar modelos reactivos.
 *     - Si un grupo tiene opción "No aplica" / "Ninguno", marca ÚNICAMENTE esa.
 *     - Preguntas condicionales ("¿Tiene otra...", "¿Desea agregar...") se dejan desmarcadas por defecto.
 *  3. Diferenciación estricta de textos:
 *     - "Ubicación", "Nombre tipo de ubicación", barrios/sectores reciben datos de dirección/barrio del Excel (ej. "CENTRO").
 *     - Textos largos de observaciones se reservan EXCLUSIVAMENTE para textareas o campos con "observacion", "detalle", etc.
 *     - Protección total contra edición de campos disabled / readonly (Geopunto, ID Vivienda, Hacinamiento).
 *  4. Sistema de Plantillas por Módulo:
 *     - Graba y replica respuestas asumidas por módulo (Información General, Entorno y Vivienda, Familia, Integrantes).
 *     - Prioriza datos del paciente activo del Excel sobre campos dinámicos.
 */

// eslint-disable-next-line no-unused-vars
class AutofillEngine {

  constructor() {
    this.settings = {
      overwrite: false,
      familiaUnipersonal: true,
      neutralOptions: [
        'No', 'Ninguno', 'Ninguna', 'No aplica', 'N/A', 'Normal',
        'Bueno', 'Buena', 'Adecuado', 'Sin novedad', 'No refiere',
        'Urbano', 'Propio', 'Si', 'No presenta', 'Negativo', 'Sano'
      ],
      defaultTexts: {
        short: 'No aplica.',
        long: 'No refiere novedades durante la caracterización.',
      },
    };

    this.templates = {}; // { [moduleName]: templateData }
  }

  /* ══════════════════════════════════════════════════════════════
     1. RECORRIDO RECURSIVO DEL DOM (Document, Shadow DOM, Iframes)
     ══════════════════════════════════════════════════════════════ */

  _collectAllElements(root = document, visited = new Set()) {
    if (!root || visited.has(root)) return [];
    visited.add(root);

    const elements = [];
    let nodeList = [];

    try {
      if (root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        nodeList = Array.from(root.querySelectorAll('*'));
      } else if (root.querySelectorAll) {
        nodeList = [root, ...Array.from(root.querySelectorAll('*'))];
      }
    } catch {
      return elements;
    }

    for (const el of nodeList) {
      // Excluir panel de la extensión
      if (el.id === 'siaps-autofill-host' || (el.closest && el.closest('#siaps-autofill-host'))) {
        continue;
      }

      elements.push(el);

      // Shadow DOM abierto
      if (el.shadowRoot && !visited.has(el.shadowRoot)) {
        elements.push(...this._collectAllElements(el.shadowRoot, visited));
      }

      // Iframes same-origin
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const frameDoc = el.contentDocument || el.contentWindow?.document;
          if (frameDoc && !visited.has(frameDoc)) {
            elements.push(...this._collectAllElements(frameDoc, visited));
          }
        } catch {
          // Cross-origin iframe
        }
      }
    }

    return elements;
  }

  _isBlockedOrReadonly(el) {
    if (!el) return true;
    if (el.disabled || el.readOnly) return true;
    if (el.hasAttribute('disabled') || el.hasAttribute('readonly')) return true;
    if (el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true') return true;

    // Verificar clases de bloqueo
    const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    if (cls.includes('disabled') || cls.includes('readonly') || cls.includes('bloqueado')) return true;

    // Verificar estilo computado
    try {
      const style = window.getComputedStyle(el);
      if (style.pointerEvents === 'none') return true;
      // Colores de fondo grises típicos de inputs deshabilitados (ej: geopunto, id vivienda)
      const bg = style.backgroundColor;
      if (bg === 'rgb(233, 236, 239)' || bg === 'rgb(238, 238, 238)' || bg === 'rgb(245, 245, 245)') {
        if (el.tagName === 'INPUT' && (el.readOnly || el.disabled || el.getAttribute('tabindex') === '-1')) {
          return true;
        }
      }
    } catch {
      // Ignorar
    }

    return false;
  }

  _isElementVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) {
      try {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
      } catch {
        // Ignorar
      }
      return true;
    }
    if (el.tagName === 'BODY') return true;
    try {
      const s = window.getComputedStyle(el);
      if (s.position === 'fixed' && s.display !== 'none' && s.visibility !== 'hidden') return true;
    } catch {
      // Ignorar
    }
    return false;
  }

  _isVisible(el) {
    if (!el) return false;

    // Para inputs de checkbox y radio estilizados:
    // Aunque el <input> tenga opacity: 0, position: absolute o tamaño 0, si su <label> o contenedor es visible, ¡ES VÁLIDO!
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase())) {
      const label = this._getAssociatedLabel(el);
      if (label && this._isElementVisible(label)) return true;
      const parent = el.parentElement;
      if (parent && this._isElementVisible(parent)) return true;
    }

    return this._isElementVisible(el);
  }

  _getAssociatedLabel(el) {
    if (!el) return null;
    const doc = el.ownerDocument || document;
    if (el.id) {
      try {
        const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl;
      } catch {
        // Ignorar
      }
    }
    return el.closest ? el.closest('label') : null;
  }

  /* ══════════════════════════════════════════════════════════════
     2. DETECCIÓN DE DESPLEGABLES PERSONALIZADOS ("Seleccione...")
     ══════════════════════════════════════════════════════════════ */

  _isCustomDropdownElement(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'SELECT') return false;
    if (el.id === 'siaps-autofill-host' || (el.closest && el.closest('#siaps-autofill-host'))) return false;
    if (this._isBlockedOrReadonly(el)) return false;

    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const ariaHasPopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';

    // Controles estándar de frameworks
    if (tag === 'mat-select' || tag === 'ng-select' || role === 'combobox' || ariaHasPopup === 'listbox' || ariaHasPopup === 'true') {
      return true;
    }
    if (cls.includes('select2-selection') || cls.includes('p-dropdown') || cls.includes('ant-select-selector')) {
      return true;
    }

    // Contenedores clicables (div, button, span, input readonly) dentro de formularios
    if (['div', 'button', 'span', 'input'].includes(tag)) {
      if (el.closest && el.closest('[role="listbox"], .dropdown-menu, .select-options, ul, ol')) {
        return false; // Es un elemento de la lista desplegada, no el trigger
      }

      // Si es un input pero no es readonly ni tiene clase de select, verificar si tiene placeholder de selección
      if (tag === 'input') {
        const ph = (el.placeholder || '').toLowerCase();
        if (!el.readOnly && !ph.includes('seleccione') && !ph.includes('seleccionar')) {
          return false;
        }
      }

      const text = (el.textContent || el.value || el.placeholder || '').trim();
      const normText = this._norm(text);

      // Si el texto visible comienza con "seleccione" o "seleccionar"
      if (normText.startsWith('seleccione') || normText.startsWith('seleccionar') ||
          normText.includes('seleccione tipo') || normText.includes('seleccione area') ||
          normText.includes('seleccione estrato')) {
        return true;
      }

      // Tiene flecha/chevron y está dentro de un contenedor de formulario
      const hasChevron = el.querySelector && el.querySelector('.fa-chevron-down, .fa-angle-down, .caret, [class*="arrow"], [class*="chevron"], svg');
      if (hasChevron && (el.closest('.form-group, .form-field, .col, .field, div') || cls.includes('select') || cls.includes('dropdown'))) {
        return true;
      }
    }

    return false;
  }

  async _openAndSelectCustomDropdown(triggerEl, targetValueOrRule) {
    if (!triggerEl) return null;

    // Verificar si ya tiene valor seleccionado (que no sea placeholder "Seleccione...")
    const currentText = (triggerEl.textContent || triggerEl.value || '').trim();
    const normCurrent = this._norm(currentText);
    const isPlaceholder = normCurrent.startsWith('seleccione') || normCurrent.startsWith('seleccionar') ||
                          normCurrent === '--' || normCurrent === '' || normCurrent.includes('seleccione');

    if (!isPlaceholder && !this.settings.overwrite) {
      return null;
    }

    // Despachar ráfaga de eventos de mouse para abrir el menú
    try {
      triggerEl.focus?.();
      triggerEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
      triggerEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, cancelable: true }));
      triggerEl.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      triggerEl.click?.();
    } catch {
      // Fallback
    }

    // Esperar hasta 500 ms (verificando cada 50 ms) a que aparezca el menú desplegado en el DOM
    const optionSelectors = [
      '[role="option"]', 'mat-option', '.ng-option',
      '.select2-results__option', '.p-dropdown-item', '.ant-select-item-option',
      '.dropdown-item', '.dropdown-menu li', '.dropdown-menu a', '.dropdown-menu div',
      'ul.select-options li', '.options-list li', '.menu-item'
    ];

    let options = [];
    const startTime = Date.now();
    const doc = triggerEl.ownerDocument || document;

    while (Date.now() - startTime < 500) {
      await this._sleep(50);
      const candidates = Array.from(doc.querySelectorAll(optionSelectors.join(', '))).filter(
        (opt) => this._isElementVisible(opt) && opt.getAttribute('aria-disabled') !== 'true'
      );

      if (candidates.length > 0) {
        options = candidates.filter((opt) => {
          const t = this._norm(opt.textContent || '');
          return !t.startsWith('seleccione') && !t.startsWith('seleccionar') && t !== '--' && t !== '';
        });
        if (options.length > 0) break;
      }
    }

    if (options.length === 0) return null;

    // Buscar la opción deseada
    let targetOpt = null;

    // 1. Coincidencia específica (si viene de plantilla o dato concreto)
    if (typeof targetValueOrRule === 'string' && targetValueOrRule.trim()) {
      const targetNorm = this._norm(targetValueOrRule);
      targetOpt = options.find((opt) => {
        const t = this._norm(opt.textContent || '');
        return t === targetNorm || t.includes(targetNorm) || targetNorm.includes(t);
      });
    }

    // 2. Coincidencia en lista neutra
    if (!targetOpt) {
      for (const pref of this.settings.neutralOptions) {
        const pNorm = this._norm(pref);
        targetOpt = options.find((opt) => {
          const t = this._norm(opt.textContent || '');
          return t === pNorm || t.includes(pNorm);
        });
        if (targetOpt) break;
      }
    }

    // 3. Regla de Oro: Primera opción válida disponible
    if (!targetOpt && options.length > 0) {
      targetOpt = options[0];
    }

    if (targetOpt) {
      const selectedText = targetOpt.textContent.trim();
      try {
        targetOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
        targetOpt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, cancelable: true }));
        targetOpt.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
        targetOpt.click?.();
      } catch {
        // Fallback
      }

      // Notificar al componente del cambio
      triggerEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      triggerEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

      // Pausa obligatoria de 200 ms para que no se pisen desplegables consecutivos
      await this._sleep(200);
      return selectedText;
    }

    return null;
  }

  /* ══════════════════════════════════════════════════════════════
     3. SETTERS NATIVOS Y CLICS SEGUROS (Checkboxes / Radios)
     ══════════════════════════════════════════════════════════════ */

  _setNativeValue(element, value) {
    if (this._isBlockedOrReadonly(element)) return;

    const strVal = value == null ? '' : String(value);
    const tag = element.tagName;
    let setter = null;

    if (tag === 'SELECT') {
      setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    } else if (tag === 'TEXTAREA') {
      setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    } else {
      setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    }

    if (setter) {
      setter.call(element, strVal);
    } else {
      element.value = strVal;
    }

    element.dispatchEvent(new Event('focus', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
  }

  _toggleStyledControl(element, targetChecked) {
    if (this._isBlockedOrReadonly(element)) return;

    const shouldCheck = Boolean(targetChecked);
    if (element.checked === shouldCheck) return;

    // 1. Hacer clic sobre el <label> asociado si existe (necesario para frameworks reactivos)
    const label = this._getAssociatedLabel(element);
    if (label && label !== element) {
      try {
        label.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      } catch {
        label.click?.();
      }
    }

    // 2. Si no cambió, hacer clic directo al input
    if (element.checked !== shouldCheck) {
      try {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      } catch {
        element.click?.();
      }
    }

    // 3. Forzar el setter nativo del prototipo si sigue sin cambiar
    if (element.checked !== shouldCheck) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      if (setter) {
        setter.call(element, shouldCheck);
      } else {
        element.checked = shouldCheck;
      }
    }

    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  _selectNativeOption(selectEl, valueOrText) {
    if (this._isBlockedOrReadonly(selectEl)) return false;

    const options = Array.from(selectEl.options);
    const target = options.find((o) => o.value === valueOrText || this._norm(o.textContent) === this._norm(valueOrText));

    if (target) {
      selectEl.selectedIndex = target.index;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(selectEl, target.value);
      else selectEl.value = target.value;

      selectEl.dispatchEvent(new Event('focus', { bubbles: true, composed: true }));
      selectEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      selectEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      selectEl.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
      return true;
    }
    return false;
  }

  /* ══════════════════════════════════════════════════════════════
     4. CONTEXTO Y HEURÍSTICAS DE TEXTO
     ══════════════════════════════════════════════════════════════ */

  _getFieldContext(field) {
    const ctx = {
      element: field,
      tag: (field.tagName || '').toLowerCase(),
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
    };

    // Label asociado
    const lbl = this._getAssociatedLabel(field);
    if (lbl) {
      const clone = lbl.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((e) => e.remove());
      ctx.label = clone.textContent.trim();
    }

    // aria-labelledby
    if (!ctx.label && field.getAttribute('aria-labelledby')) {
      const doc = field.ownerDocument || document;
      const lblIds = field.getAttribute('aria-labelledby').split(/\s+/);
      const textParts = [];
      for (const id of lblIds) {
        const lblEl = doc.getElementById(id);
        if (lblEl) textParts.push(lblEl.textContent.trim());
      }
      if (textParts.length > 0) ctx.label = textParts.join(' ');
    }

    // Texto de contenedor cercano / fieldset
    if (field.closest) {
      const fieldset = field.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) ctx.nearbyText += ' ' + legend.textContent.trim();
      }

      const parent = field.closest('.form-group, .form-field, .field, .col, .column, td, th, div');
      if (parent) {
        const textContent = [];
        for (const node of parent.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) textContent.push(node.textContent.trim());
          if (node.nodeType === Node.ELEMENT_NODE && ['LABEL', 'SPAN', 'P', 'STRONG', 'B'].includes(node.tagName)) {
            textContent.push(node.textContent.trim());
          }
        }
        ctx.nearbyText += ' ' + textContent.filter(Boolean).join(' ');
      }
    }

    // Opciones para <select> nativo
    if (ctx.tag === 'select') {
      ctx.options = Array.from(field.options || []).map((o) => ({
        value: o.value,
        text: o.textContent.trim(),
        disabled: o.disabled,
      }));
    }

    ctx.searchText = [
      ctx.label, ctx.placeholder, ctx.ariaLabel,
      ctx.name, ctx.id, ctx.nearbyText
    ].join(' ').toLowerCase();

    return ctx;
  }

  _norm(str) {
    return (str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  _matches(ctx, keywords) {
    const st = this._norm(ctx.searchText);
    return keywords.some((kw) => st.includes(this._norm(kw)));
  }

  _hasValue(field) {
    if (!field) return false;
    const tag = field.tagName.toLowerCase();

    if (tag === 'select') {
      const val = field.value;
      const text = field.options[field.selectedIndex]?.textContent?.trim() || '';
      return Boolean(
        val && val !== '' && val !== '0' && val !== '-1' &&
        !this._isPlaceholderOption({ value: val, text })
      );
    }

    if (field.type === 'checkbox' || field.type === 'radio') {
      return field.checked || field.getAttribute('aria-checked') === 'true';
    }

    // Custom dropdowns
    if (this._isCustomDropdownElement(field)) {
      const text = this._norm(field.textContent || field.value || '');
      if (text && !text.startsWith('seleccione') && !text.startsWith('seleccionar') && text !== '--') {
        return true;
      }
      return false;
    }

    return field.value != null && field.value.trim() !== '';
  }

  _isPlaceholderOption(opt) {
    const v = (opt.value || '').trim();
    const t = this._norm(opt.text);
    return (
      !v || v === '0' || v === '-1' || v === 'null' || v === 'undefined' ||
      t.startsWith('seleccione') || t.startsWith('seleccionar') ||
      ['--', '---', 'elegir', 'escoja', 'opcion', ''].includes(t) ||
      Boolean(opt.disabled)
    );
  }

  _findBestOption(ctx, preferredValues) {
    const validOpts = (ctx.options || []).filter((o) => !this._isPlaceholderOption(o));
    if (validOpts.length === 0) return null;

    for (const pref of preferredValues) {
      const np = this._norm(pref);
      const exact = validOpts.find(
        (o) => this._norm(o.text) === np || this._norm(o.value) === np
      );
      if (exact) return exact.value;
    }

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

  _getFirstValidOption(ctx) {
    const valid = (ctx.options || []).find((o) => !this._isPlaceholderOption(o));
    return valid ? valid.value : null;
  }

  /* ══════════════════════════════════════════════════════════════
     5. FASE 1: VALORES DEL PACIENTE (EXCEL) Y FAMILIA UNIPERSONAL
     ══════════════════════════════════════════════════════════════ */

  _determinePhase1Value(ctx, patient, opts) {
    const tag = ctx.tag;

    // Nombre completo
    if (this._matches(ctx, ['nombre completo', 'nombre del usuario', 'nombre usuario', 'full name', 'nombre_completo'])) {
      return patient.nombreCompleto || '';
    }

    // Primer nombre
    if (this._matches(ctx, ['primer nombre', 'first name', 'primer_nombre', 'name1'])) {
      if (this._matches(ctx, ['segundo', 'second', '2'])) return patient.segundoNombre || '';
      return patient.primerNombre || '';
    }

    // Segundo nombre
    if (this._matches(ctx, ['segundo nombre', 'second name', 'segundo_nombre', 'name2', 'otros nombres'])) {
      return patient.segundoNombre || '';
    }

    // Primer apellido
    if (this._matches(ctx, ['primer apellido', 'apellido paterno', 'last name', 'primer_apellido', 'apellido1'])) {
      return patient.primerApellido || '';
    }

    // Segundo apellido
    if (this._matches(ctx, ['segundo apellido', 'apellido materno', 'segundo_apellido', 'apellido2'])) {
      return patient.segundoApellido || '';
    }

    // Nombres (general)
    if (this._matches(ctx, ['nombres']) && !this._matches(ctx, ['apellido'])) {
      return [patient.primerNombre, patient.segundoNombre].filter(Boolean).join(' ') || patient.nombreCompleto || '';
    }

    // Apellidos (campo combinado)
    if (this._matches(ctx, ['apellidos', 'apellido']) && !this._matches(ctx, ['primer', 'segundo', '1', '2'])) {
      return [patient.primerApellido, patient.segundoApellido].filter(Boolean).join(' ');
    }

    // Tipo de documento
    if (this._matches(ctx, ['tipo de documento', 'tipo documento', 'tipo id', 'tipo_id', 'tipo_documento', 'tipo identificacion'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.tipoId, this._expandTipoId(patient.tipoId)]);
      }
      return patient.tipoId || '';
    }

    // Número de documento / cédula
    if (this._matches(ctx, [
      'numero de documento', 'numero documento', 'numero id', 'numero_id', 'cedula',
      'identificacion', 'nro documento', 'num documento', 'documento', 'numero_documento'
    ])) {
      return patient.numeroId || '';
    }

    // Dirección
    if (this._matches(ctx, ['direccion', 'address', 'dir.', 'domicilio', 'residencia'])) {
      return patient.direccion || 'Sin dirección registrada';
    }

    // Teléfono / Celular
    if (this._matches(ctx, ['telefono', 'celular', 'phone', 'tel.', 'movil', 'contacto'])) {
      return patient.telefono || '3000000000';
    }

    // Barrio / Vereda / Sector
    if (this._matches(ctx, ['barrio', 'vereda', 'localidad', 'sector', 'corregimiento'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.barrio]);
      }
      return patient.barrio || 'CENTRO';
    }

    // Departamento
    if (this._matches(ctx, ['departamento', 'dpto', 'department', 'estado', 'provincia'])) {
      if (tag === 'select') {
        return this._findBestOption(ctx, [patient.departamento]);
      }
      return patient.departamento || '';
    }

    // Municipio / Ciudad
    if (this._matches(ctx, ['municipio', 'ciudad', 'city', 'municipality'])) {
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
    if (this._matches(ctx, ['fecha', 'date', 'fch']) && !this._matches(ctx, ['visita', 'atencion'])) {
      return patient.fecha || this._todayISO();
    }

    // Familia Unipersonal
    if (opts.familiaUnipersonal) {
      if (this._matches(ctx, ['integrantes', 'personas', 'miembros', 'num personas', 'numero personas', 'total personas', 'total integrantes', 'miembros hogar', 'habitantes'])) {
        return '1';
      }
      if (this._matches(ctx, ['tipo de familia', 'tipo familia', 'composicion familiar', 'tipo_familia', 'tipologia familiar'])) {
        if (tag === 'select') return this._findBestOption(ctx, ['Unipersonal', 'Persona sola', 'Individual']);
        return 'Unipersonal';
      }
      if (this._matches(ctx, ['parentesco', 'relacion', 'parentesco familiar', 'vinculo', 'relacion familiar'])) {
        if (tag === 'select') return this._findBestOption(ctx, ['Jefe de hogar', 'Jefe del hogar', 'Jefe(a) de hogar', 'Jefe']);
        return 'Jefe de hogar';
      }
    }

    return null;
  }

  /* ══════════════════════════════════════════════════════════════
     6. FASE 2: BARRIDO UNIVERSAL DE CAMPOS ASUMIDOS
     ══════════════════════════════════════════════════════════════ */

  _determinePhase2Value(ctx, patient) {
    const tag = ctx.tag;
    const type = ctx.type;
    const normLabel = this._norm(ctx.label || ctx.name || ctx.placeholder || '');

    // 1. Select nativo (<select>)
    if (tag === 'select') {
      const best = this._findBestOption(ctx, this.settings.neutralOptions);
      if (best !== null) return best;
      return this._getFirstValidOption(ctx);
    }

    // 2. Input numérico
    if (type === 'number') {
      return this._getDefaultNumberWithHeuristics(ctx);
    }

    // 3. Fechas
    if (type === 'date' || type === 'datetime-local') {
      return patient.fecha || this._todayISO();
    }

    // 4. Inputs de texto y textareas
    if (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'url', 'email', 'tel', ''].includes(type))) {

      // A) Campos de ubicación / nombres cortos de lugar (NO poner observaciones largas)
      if (normLabel.includes('ubicacion') || normLabel.includes('barrio') ||
          normLabel.includes('vereda') || normLabel.includes('sector') ||
          normLabel.includes('corregimiento') || normLabel.includes('nombre tipo de ubicacion')) {
        return patient.barrio || patient.direccion || 'CENTRO';
      }

      // B) Correo
      if (type === 'email' || normLabel.includes('correo') || normLabel.includes('email')) {
        return 'notiene@correo.com';
      }

      // C) Teléfono / celular
      if (type === 'tel' || normLabel.includes('telefono') || normLabel.includes('celular') || normLabel.includes('movil')) {
        return patient.telefono || '3000000000';
      }

      // D) Patrón numérico
      if (ctx.pattern && (/^\^?\\d\+\$?/.test(ctx.pattern) || /^\^?\[0-9\]\+\$?/.test(ctx.pattern))) {
        const len = ctx.minlength > 0 ? ctx.minlength : (ctx.maxlength < 10 ? ctx.maxlength : 10);
        return '1234567890'.substring(0, len) || '1';
      }

      // E) Frase larga / Observaciones:
      // Reservada EXCLUSIVAMENTE para textareas o campos con "observacion", "detalle", "descripcion", etc.
      const isExplicitObservation = tag === 'textarea' ||
        normLabel.includes('observacion') || normLabel.includes('detalle') ||
        normLabel.includes('descripcion') || normLabel.includes('motivo') ||
        normLabel.includes('comentario') || normLabel.includes('nota') ||
        normLabel.includes('justificacion');

      if (isExplicitObservation) {
        return this._generateCompliantText(ctx);
      }

      // F) Input corto con minlength >= 10 pero NO de ubicación
      if (ctx.minlength >= 10) {
        return this._generateCompliantText(ctx);
      }

      // G) Campo de texto corto obligatorio
      if (ctx.required) {
        return this.settings.defaultTexts.short || 'No aplica.';
      }
    }

    return null;
  }

  _generateCompliantText(ctx) {
    const minLen = Math.max(ctx.minlength || 0, 10);
    const maxLen = ctx.maxlength === Infinity ? 500 : (ctx.maxlength || 500);

    let text = this.settings.defaultTexts.long || 'No refiere novedades durante la caracterización.';

    if (text.length < minLen) {
      const ext = ' Sin antecedentes ni novedades adicionales al momento de la visita.';
      while (text.length < minLen) text += ext;
    }

    if (text.length > maxLen) {
      text = text.substring(0, maxLen);
      if (text.length > 2) text = text.replace(/[,; ]$/, '') + '.';
    }

    return text;
  }

  _getDefaultNumberWithHeuristics(ctx) {
    const min = ctx.min !== '' ? parseFloat(ctx.min) : 0;
    const max = ctx.max !== '' ? parseFloat(ctx.max) : 999999;
    const step = parseFloat(ctx.step) || 1;

    let target = 1;

    if (this._matches(ctx, ['integrantes', 'personas', 'miembros', 'habitantes'])) target = 1;
    else if (this._matches(ctx, ['habitaciones', 'cuartos', 'piezas', 'alcobas'])) target = 2;
    else if (this._matches(ctx, ['edad', 'anos', 'anios', 'age'])) target = 30;
    else if (this._matches(ctx, ['peso', 'kg'])) target = 65;
    else if (this._matches(ctx, ['talla', 'estatura', 'altura', 'cm'])) target = 165;
    else if (min > 0) target = min;

    if (target < min) target = min;
    if (target > max) target = max;

    if (step > 0 && step !== 1) {
      target = Math.round(target / step) * step;
    }

    return String(target);
  }

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

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ══════════════════════════════════════════════════════════════
     7. BARRIDO ESPECIALIZADO: RADIOS, CHECKBOXES Y CUSTOM SELECTS
     ══════════════════════════════════════════════════════════════ */

  _getControlText(el) {
    const lbl = this._getAssociatedLabel(el);
    if (lbl) return lbl.textContent.trim();
    if (el.parentElement) {
      const clone = el.parentElement.cloneNode(true);
      clone.querySelectorAll('input').forEach((i) => i.remove());
      const t = clone.textContent.trim();
      if (t) return t;
    }
    return el.value || '';
  }

  _sweepRadioGroups(allFields, opts, results) {
    const radios = allFields.filter(
      (el) => (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'radio') || el.getAttribute('role') === 'radio'
    );

    const groups = new Map();
    for (const r of radios) {
      if (this._isBlockedOrReadonly(r)) continue;
      let groupKey = r.name;
      if (!groupKey) {
        const container = r.closest('fieldset, [role="radiogroup"], .radio-group, .form-group') || r.parentElement;
        groupKey = container;
      }
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(r);
    }

    for (const [, group] of groups) {
      const anyChecked = group.some((r) => r.checked || r.getAttribute('aria-checked') === 'true');
      if (anyChecked && !opts.overwrite) continue;

      let target = null;

      // 1. Opciones neutras
      for (const pref of this.settings.neutralOptions) {
        const np = this._norm(pref);
        target = group.find((r) => {
          const lbl = this._norm(this._getControlText(r));
          const val = this._norm(r.value);
          return lbl === np || val === np || lbl.includes(np);
        });
        if (target) break;
      }

      // 2. Primera opción habilitada
      if (!target && group.length > 0) {
        target = group.find((r) => !this._isBlockedOrReadonly(r)) || group[0];
      }

      if (target) {
        this._toggleStyledControl(target, true);
        this._highlightField(target, 'filled');
        results.filled.push({ field: target, value: target.value, phase: '2' });
      }
    }
  }

  _sweepCheckboxes(allFields, opts, results) {
    const checkboxes = allFields.filter(
      (el) => (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'checkbox') || el.getAttribute('role') === 'checkbox'
    );

    const groups = new Map();
    for (const cb of checkboxes) {
      if (this._isBlockedOrReadonly(cb)) continue;
      const container = cb.closest('fieldset, .checkbox-group, .form-group, div') || cb.parentElement;
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push(cb);
    }

    for (const [, group] of groups) {
      const anyChecked = group.some((cb) => cb.checked || cb.getAttribute('aria-checked') === 'true');
      if (anyChecked && !opts.overwrite) continue;

      // Descartar si es una pregunta condicional tipo "¿Tiene otra ubicación diferente?"
      const containerText = this._norm(group[0].closest('fieldset, .form-group, div')?.textContent || '');
      const isConditionalQuestion =
        containerText.includes('tiene otra') || containerText.includes('¿tiene otra') ||
        containerText.includes('desea agregar') || containerText.includes('¿desea agregar') ||
        containerText.includes('presenta otra') || containerText.includes('¿presenta otra') ||
        containerText.includes('otra ubicacion diferente');

      if (isConditionalQuestion) {
        // Dejar desmarcados todos los checkboxes condicionales por defecto
        for (const cb of group) {
          if (cb.checked) this._toggleStyledControl(cb, false);
        }
        continue;
      }

      if (group.length > 1) {
        // Buscar opción "No aplica", "Ninguno", "Ninguna" (ej: "4. No aplica")
        const negativeKeywords = ['no aplica', 'ninguno', 'ninguna', 'no refiere', 'sin novedad', 'ningun'];
        const negOption = group.find((cb) => {
          const lbl = this._norm(this._getControlText(cb));
          const val = this._norm(cb.value);
          return negativeKeywords.some((kw) => lbl.includes(kw) || val.includes(kw));
        });

        if (negOption) {
          // Marcar ÚNICAMENTE la opción negativa y desmarcar las demás
          for (const cb of group) {
            this._toggleStyledControl(cb, cb === negOption);
          }
          this._highlightField(negOption, 'filled');
          results.filled.push({ field: negOption, value: negOption.value, phase: '2' });
          continue;
        }

        // Si no tiene opción negativa, marcar la primera opción habilitada
        const first = group.find((cb) => !this._isBlockedOrReadonly(cb)) || group[0];
        if (first) {
          this._toggleStyledControl(first, true);
          this._highlightField(first, 'filled');
          results.filled.push({ field: first, value: first.value, phase: '2' });
        }
      } else {
        // Checkbox individual único
        const single = group[0];
        const ctx = this._getFieldContext(single);
        const singleLabel = this._norm(this._getControlText(single));

        if (singleLabel.includes('tiene otra') || singleLabel.includes('desea agregar') || singleLabel.includes('presenta otra')) {
          this._toggleStyledControl(single, false);
          continue;
        }

        if (ctx.required || this._matches(ctx, ['acepto', 'consentimiento', 'autorizo', 'confirmo', 'declaracion'])) {
          this._toggleStyledControl(single, true);
          this._highlightField(single, 'filled');
          results.filled.push({ field: single, value: single.value, phase: '2' });
        }
      }
    }
  }

  async _sweepCustomSelects(allFields, opts, results) {
    const customSelects = allFields.filter((el) => this._isCustomDropdownElement(el));

    for (const el of customSelects) {
      if (!opts.overwrite && this._hasValue(el)) continue;

      const ctx = this._getFieldContext(el);
      const chosenText = await this._openAndSelectCustomDropdown(el, null);

      if (chosenText) {
        this._highlightField(el, 'filled');
        results.filled.push({ field: el, context: ctx, value: chosenText, phase: '2' });
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════
     8. SISTEMA DE PLANTILLAS POR MÓDULO (Grabar y Replicar)
     ══════════════════════════════════════════════════════════════ */

  detectActiveModuleName() {
    const knownModules = [
      'Información General',
      'Entorno y Vivienda',
      'Familia',
      'Integrantes'
    ];

    const tabSelectors = [
      '.nav-tabs .active', '.nav-link.active', '.tab.active',
      '[role="tab"][aria-selected="true"]', 'mat-tab-label-active',
      '.breadcrumb .active', '.module-title', 'h1', 'h2'
    ];

    for (const sel of tabSelectors) {
      const elements = Array.from(document.querySelectorAll(sel));
      for (const el of elements) {
        const text = this._norm(el.textContent || '');
        for (const mod of knownModules) {
          if (text.includes(this._norm(mod))) {
            return mod;
          }
        }
      }
    }

    return 'Información General'; // Módulo por defecto
  }

  _isPersonalDataField(ctx) {
    const keywords = [
      'nombre', 'apellido', 'tipo documento', 'tipo id', 'numero documento',
      'cedula', 'identificacion', 'direccion', 'telefono', 'celular',
      'fecha', 'eps', 'aseguradora'
    ];
    return this._matches(ctx, keywords);
  }

  extractModuleSnapshot(moduleName) {
    const all = this._scanAllInteractiveFields();
    const fields = [];

    for (const el of all) {
      if (this._isBlockedOrReadonly(el)) continue;

      const ctx = this._getFieldContext(el);
      const label = ctx.label || ctx.name || ctx.id;
      if (!label) continue;

      const normLabel = this._norm(label);
      const isPersonal = this._isPersonalDataField(ctx);

      // 1. Select nativo
      if (ctx.tag === 'select') {
        const optText = el.options[el.selectedIndex]?.textContent?.trim() || '';
        const optVal = el.value || '';
        if (optVal && !this._isPlaceholderOption({ value: optVal, text: optText })) {
          fields.push({
            type: 'select',
            label,
            normLabel,
            value: optVal,
            text: optText,
            isPersonalData: isPersonal,
          });
        }
        continue;
      }

      // 2. Custom dropdown
      if (this._isCustomDropdownElement(el)) {
        const text = (el.textContent || el.value || '').trim();
        if (text && !this._norm(text).startsWith('seleccione') && text !== '--') {
          fields.push({
            type: 'custom-select',
            label,
            normLabel,
            text,
            isPersonalData: isPersonal,
          });
        }
        continue;
      }

      // 3. Radio
      if (ctx.type === 'radio' && el.checked) {
        fields.push({
          type: 'radio',
          groupName: el.name,
          label,
          normLabel,
          optionText: this._getControlText(el),
          value: el.value,
          isPersonalData: isPersonal,
        });
        continue;
      }

      // 4. Checkbox
      if (ctx.type === 'checkbox') {
        fields.push({
          type: 'checkbox',
          label,
          normLabel,
          optionText: this._getControlText(el),
          checked: el.checked,
          isPersonalData: isPersonal,
        });
        continue;
      }

      // 5. Input text / number / textarea
      if (['input', 'textarea'].includes(ctx.tag)) {
        const val = (el.value || '').trim();
        if (val) {
          fields.push({
            type: 'input',
            tag: ctx.tag,
            inputType: ctx.type,
            label,
            normLabel,
            value: val,
            isPersonalData: isPersonal,
          });
        }
      }
    }

    return {
      moduleName,
      savedAt: new Date().toISOString(),
      fieldCount: fields.length,
      fields,
    };
  }

  async applyModuleTemplate(template, patient, options = {}) {
    const opts = { ...this.settings, ...options };
    const results = { filled: [], unresolved: [], skipped: [] };
    const all = this._scanAllInteractiveFields();

    if (!template || !template.fields) {
      return this.fillForm(patient, options);
    }

    this._clearHighlights();

    // 1. Aplicar campos guardados de la plantilla
    for (const saved of template.fields) {
      // Buscar el elemento interactivo correspondiente en la pantalla por su label normalizado
      const el = all.find((field) => {
        if (this._isBlockedOrReadonly(field)) return false;
        const ctx = this._getFieldContext(field);
        return this._norm(ctx.label || ctx.name || ctx.id) === saved.normLabel;
      });

      if (!el) continue;
      const ctx = this._getFieldContext(el);

      // Si es dato personal del paciente, sobreescribir dinámicamente con los datos activos del Excel
      if (saved.isPersonalData) {
        const patientVal = this._determinePhase1Value(ctx, patient, opts);
        if (patientVal) {
          if (ctx.tag === 'select') {
            this._selectNativeOption(el, patientVal);
          } else if (this._isCustomDropdownElement(el)) {
            await this._openAndSelectCustomDropdown(el, patientVal);
          } else {
            this._setNativeValue(el, patientVal);
          }
          this._highlightField(el, 'filled');
          results.filled.push({ field: el, value: patientVal, source: 'patient-dynamic' });
        }
        continue;
      }

      // Aplicar valor estático asumido de la plantilla
      if (saved.type === 'select') {
        this._selectNativeOption(el, saved.text || saved.value);
        this._highlightField(el, 'filled');
        results.filled.push({ field: el, value: saved.text, source: 'template' });
      } else if (saved.type === 'custom-select') {
        const chosen = await this._openAndSelectCustomDropdown(el, saved.text);
        if (chosen) {
          this._highlightField(el, 'filled');
          results.filled.push({ field: el, value: chosen, source: 'template' });
        }
      } else if (saved.type === 'radio' && saved.optionText) {
        const doc = el.ownerDocument || document;
        const radios = Array.from(doc.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`));
        const match = radios.find((r) => this._norm(this._getControlText(r)) === this._norm(saved.optionText));
        if (match) {
          this._toggleStyledControl(match, true);
          this._highlightField(match, 'filled');
          results.filled.push({ field: match, value: saved.optionText, source: 'template' });
        }
      } else if (saved.type === 'checkbox') {
        this._toggleStyledControl(el, Boolean(saved.checked));
        if (saved.checked) this._highlightField(el, 'filled');
        results.filled.push({ field: el, value: saved.checked, source: 'template' });
      } else if (saved.type === 'input') {
        this._setNativeValue(el, saved.value);
        this._highlightField(el, 'filled');
        results.filled.push({ field: el, value: saved.value, source: 'template' });
      }
    }

    // 2. Correr Fase 1 (Excel) para asegurar que cualquier campo del paciente no mapeado en plantilla se complete
    for (const el of all) {
      if (this._isBlockedOrReadonly(el) || this._hasValue(el)) continue;
      const ctx = this._getFieldContext(el);
      const val1 = this._determinePhase1Value(ctx, patient, opts);
      if (val1) {
        if (ctx.tag === 'select') this._selectNativeOption(el, val1);
        else if (this._isCustomDropdownElement(el)) await this._openAndSelectCustomDropdown(el, val1);
        else this._setNativeValue(el, val1);
        this._highlightField(el, 'filled');
        results.filled.push({ field: el, value: val1, source: 'phase1' });
      }
    }

    // 3. Correr Fase 2 solo sobre campos que sigan vacíos tras aplicar la plantilla
    for (const el of all) {
      if (this._isBlockedOrReadonly(el) || this._hasValue(el)) continue;
      const ctx = this._getFieldContext(el);
      const val2 = this._determinePhase2Value(ctx, patient);
      if (val2) {
        if (ctx.tag === 'select') this._selectNativeOption(el, val2);
        else this._setNativeValue(el, val2);
        this._highlightField(el, 'filled');
        results.filled.push({ field: el, value: val2, source: 'phase2' });
      }
    }

    // 4. Barrido de radios, checkboxes y dropdowns restantes
    this._sweepRadioGroups(all, opts, results);
    this._sweepCheckboxes(all, opts, results);
    await this._sweepCustomSelects(all, opts, results);

    return results;
  }

  /* ══════════════════════════════════════════════════════════════
     9. EJECUCIÓN PRINCIPAL: MOTOR EN 2 FASES
     ══════════════════════════════════════════════════════════════ */

  _scanAllInteractiveFields() {
    const all = this._collectAllElements(document);
    return all.filter((el) => {
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      if (['select', 'textarea'].includes(tag)) return this._isVisible(el);
      if (tag === 'input') {
        const type = (el.type || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return false;
        return this._isVisible(el);
      }
      if (this._isCustomDropdownElement(el)) return this._isVisible(el);
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['radiogroup', 'radio', 'checkbox'].includes(role)) return this._isVisible(el);
      return false;
    });
  }

  async fillForm(patient, options = {}) {
    const opts = { ...this.settings, ...options };
    const results = { filled: [], unresolved: [], skipped: [] };

    this._clearHighlights();

    // ─────────────────────────────────────────────────────────────
    // FASE 1: DATOS DEL EXCEL Y FAMILIA UNIPERSONAL
    // ─────────────────────────────────────────────────────────────
    let allFields = this._scanAllInteractiveFields();

    for (const field of allFields) {
      if (this._isBlockedOrReadonly(field)) continue;

      const tag = field.tagName.toLowerCase();
      const type = (field.type || '').toLowerCase();

      if (type === 'radio' || type === 'checkbox' || this._isCustomDropdownElement(field)) {
        continue;
      }

      if (!opts.overwrite && this._hasValue(field)) {
        results.skipped.push({ field, reason: 'already-filled' });
        continue;
      }

      const ctx = this._getFieldContext(field);
      const val1 = this._determinePhase1Value(ctx, patient, opts);

      if (val1 !== null && val1 !== undefined && val1 !== '') {
        if (tag === 'select') {
          const ok = this._selectNativeOption(field, val1);
          if (!ok) {
            const fuzzy = this._findBestOption(ctx, [val1]);
            if (fuzzy) this._selectNativeOption(field, fuzzy);
          }
        } else {
          this._setNativeValue(field, val1);
        }
        field.setAttribute('data-siaps-phase', '1');
        this._highlightField(field, 'filled');
        results.filled.push({ field, context: ctx, value: val1, phase: '1' });
      }
    }

    // Espera asíncrona para cascadas (ej. Departamento -> Municipio)
    await this._sleep(350);

    allFields = this._scanAllInteractiveFields();
    for (const field of allFields) {
      if (this._isBlockedOrReadonly(field)) continue;
      if (field.tagName.toLowerCase() === 'select' && !this._hasValue(field)) {
        const ctx = this._getFieldContext(field);
        const val1 = this._determinePhase1Value(ctx, patient, opts);
        if (val1 !== null && val1 !== '') {
          this._selectNativeOption(field, val1);
          field.setAttribute('data-siaps-phase', '1');
          this._highlightField(field, 'filled');
          results.filled.push({ field, context: ctx, value: val1, phase: '1' });
          await this._sleep(250);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // FASE 2: BARRIDO UNIVERSAL DE CAMPOS ASUMIDOS
    // ─────────────────────────────────────────────────────────────
    allFields = this._scanAllInteractiveFields();

    // 1. Inputs nativos
    for (const field of allFields) {
      if (this._isBlockedOrReadonly(field)) continue;

      const tag = field.tagName.toLowerCase();
      const type = (field.type || '').toLowerCase();

      if (type === 'radio' || type === 'checkbox' || this._isCustomDropdownElement(field)) {
        continue;
      }

      if (!opts.overwrite && this._hasValue(field)) {
        continue;
      }

      const ctx = this._getFieldContext(field);
      const val2 = this._determinePhase2Value(ctx, patient);

      if (val2 !== null && val2 !== undefined && val2 !== '') {
        if (tag === 'select') {
          this._selectNativeOption(field, val2);
        } else {
          this._setNativeValue(field, val2);
        }
        field.setAttribute('data-siaps-phase', '2');
        this._highlightField(field, 'filled');
        results.filled.push({ field, context: ctx, value: val2, phase: '2' });
      } else if (ctx.required) {
        results.unresolved.push({ field, context: ctx });
        this._highlightField(field, 'unresolved');
      }
    }

    // 2. Radios
    this._sweepRadioGroups(allFields, opts, results);

    // 3. Checkboxes
    this._sweepCheckboxes(allFields, opts, results);

    // 4. Desplegables personalizados ("Seleccione...")
    await this._sweepCustomSelects(allFields, opts, results);

    return results;
  }

  /* ══════════════════════════════════════════════════════════════
     10. FEEDBACK VISUAL Y LIMPIEZA
     ══════════════════════════════════════════════════════════════ */

  _highlightField(field, type) {
    if (!field || !field.style) return;
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

    setTimeout(() => {
      field.style.boxShadow = '';
      field.style.borderColor = '';
      field.style.transition = prevTransition;
    }, 8000);
  }

  _clearHighlights() {
    const all = this._collectAllElements(document);
    for (const el of all) {
      if (el.hasAttribute && (el.hasAttribute('data-siaps-filled') || el.hasAttribute('data-siaps-unresolved'))) {
        el.style.boxShadow = '';
        el.style.borderColor = '';
        el.removeAttribute('data-siaps-filled');
        el.removeAttribute('data-siaps-unresolved');
        el.removeAttribute('data-siaps-phase');
      }
    }
  }

  exportFieldMap() {
    const all = this._scanAllInteractiveFields();

    return all.map((el) => {
      const ctx = this._getFieldContext(el);
      const isCustomDrop = this._isCustomDropdownElement(el);

      const meta = {
        tag: ctx.tag,
        type: ctx.type || undefined,
        id: ctx.id || undefined,
        name: ctx.name || undefined,
        label: ctx.label || undefined,
        placeholder: ctx.placeholder || undefined,
        isCustomDropdown: isCustomDrop || undefined,
        required: ctx.required || undefined,
        minlength: ctx.minlength > 0 ? ctx.minlength : undefined,
        maxlength: ctx.maxlength < Infinity ? ctx.maxlength : undefined,
      };

      if (ctx.tag === 'select') {
        meta.options = (ctx.options || []).map((o) => ({ value: o.value, text: o.text }));
      }

      Object.keys(meta).forEach((k) => {
        if (meta[k] === undefined) delete meta[k];
      });

      return meta;
    });
  }
}

console.log('[SI-APS] AutofillEngine (v3 con Plantillas y Desplegables Custom) cargado.');
