# 🏥 SI-APS AutoFill — Extensión de Chrome

Extensión de Chrome (Manifest V3) para **autocompletar masivamente** los formularios de caracterización de pacientes en la plataforma **SI-APS**.

> ⚠️ **Privacidad:** Todo el procesamiento del Excel se ejecuta 100% en el navegador del cliente. Ningún dato sale de tu computador. La librería SheetJS está empaquetada localmente dentro de la extensión.

---

## 📦 Instalación

### Requisitos
- Google Chrome (versión 88 o superior)
- Archivo Excel `.xlsx` con los datos de pacientes (ver formato más abajo)

### Pasos

1. **Descarga o clona** esta carpeta completa en tu computador.

2. Abre Chrome y navega a:
   ```
   chrome://extensions
   ```

3. Activa el **Modo de desarrollador** (switch en la esquina superior derecha).

4. Haz clic en **"Cargar descomprimida"** (o *"Load unpacked"*).

5. Selecciona la carpeta raíz de esta extensión (la que contiene `manifest.json`).

6. ¡Listo! Verás el ícono verde **"SI"** en la barra de extensiones de Chrome.

---

## 🚀 Uso

### 1. Cargar el Excel de pacientes

1. Inicia sesión en **SI-APS** y navega al módulo de caracterización deseado.
2. Haz clic en el ícono **SI** de la extensión (o presiona `Alt + Shift + P`) para abrir el panel lateral.
3. En el panel, haz clic en **"📂 Cargar Excel (.xlsx)"** y selecciona tu archivo.
4. El panel mostrará el número de pacientes cargados y posibles advertencias.

### 2. Autocompletar un formulario (Plantilla por Módulo o Barrido Total)

1. Navega al módulo de SI-APS que deseas diligenciar (`Información General`, `Entorno y Vivienda`, `Familia`, `Integrantes`).
2. Verifica en el panel que el **Módulo activo** coincida (puedes usar el botón 🔍 para detectarlo automáticamente).
3. Presiona **`Alt + Shift + F`** o el botón **"⚡ Llenar módulo (Plantilla + Excel)"**:
   - **🎯 Modo con Plantilla guardada:**
     - Si grabaste una plantilla para ese módulo, la extensión aplica exactamente las opciones guardadas (abriendo desplegables personalizados y marcando checkboxes/radios idénticos).
     - Sobreescribe dinámicamente los campos personales (`nombre`, `cédula`, `dirección`, `teléfono`, `fecha`) con los datos del paciente activo del Excel.
     - Aplica barrido solo sobre campos que sigan vacíos.
   - **⚡ Modo Automático (Sin plantilla):**
     - **🔹 Fase 1 (Excel y Familia Unipersonal):** Inyecta datos del paciente activo, fuerza 1 integrante, familia Unipersonal y Jefe de hogar.
     - **🔸 Fase 2 (Barrido Asumido Inteligente):**
       - **Desplegables personalizados:** Detecta cualquier control cuyo texto sea "Seleccione..." o tenga flechas/atributos combobox, lo abre, busca opciones en el portal del DOM y elige la respuesta neutral o la primera válida.
       - **Checkboxes estilizados:** Detecta inputs ocultos por CSS, hace clic en el `<label>`, marca únicamente "4. No aplica" en grupos de situación y deja desmarcadas preguntas condicionales como *"¿Tiene otra ubicación diferente?"*.
       - **Campos de ubicación vs observaciones:** Campos como `"Nombre Tipo de Ubicación"` y `"Ubicación"` reciben el barrio/dirección corta del Excel (o "CENTRO"). Las frases largas se reservan únicamente para `<textarea>` u observaciones.
       - **Protección readonly:** Respeta campos bloqueados como Geopunto GPS, ID Vivienda y Hacinamiento sin modificarlos.

### 3. Grabar y Administrar Plantillas por Módulo

- **Guardar plantilla:** Llena manualmente (o ajusta) una pantalla de SI-APS según el estándar de tu centro y haz clic en **"💾 Guardar plantilla"**. La extensión grabará las respuestas asumidas para ese módulo (excluyendo datos personales del paciente y campos bloqueados).
- **Borrar plantilla:** Haz clic en **"🗑️ Borrar"** si deseas reconfigurarla o volver al modo 100% automático para ese módulo.
- **Indicador:** El badge mostrará `🟢 Plantilla activa: Sí (X campos)` o `⚪ Sin plantilla (modo automático)`.

### 4. Marcar como completado y continuar

- Cuando termines con un paciente, haz clic en **"✅ Completado → Siguiente"**.
- El paciente se marca como completado y el panel avanza al siguiente pendiente.

### 4. Funciones adicionales

| Función | Descripción |
|---------|-------------|
| **Buscador** | Busca pacientes por nombre o número de documento |
| **Editar nombre** | Corrige el parseo automático de nombres/apellidos |
| **Sobrescribir** | Toggle para sobrescribir campos que ya tienen valor |
| **Familia Unipersonal** | Activa reglas específicas (1 integrante, Jefe de hogar, etc.) |
| **Config** | Personaliza las respuestas neutras y textos por defecto |
| **Exportar mapa** | Genera un JSON con la estructura del formulario actual |

---

## 📊 Formato del Excel

El archivo Excel (`.xlsx`) debe tener una hoja llamada **"Informe completo"** (o se usará la primera hoja disponible) con las siguientes columnas:

### Columnas principales (obligatorias)

| Columna | Descripción | Ejemplo |
|---------|-------------|---------|
| `NOMBRE DEL USUARIO` | Nombre completo | `YENIFER  CABALLERO` |
| `TIPO ID` | Tipo de documento | `CC`, `TI`, `RC` |
| `NUMERO ID` | Número de documento | `1234567890` |

### Columnas secundarias (opcionales)

| Columna | Descripción |
|---------|-------------|
| `DIRECCION DEL USUARIO` | Dirección de residencia |
| `TELEFONO DE USUARIO` | Teléfono o celular |
| `BARRIO/VEREDA` | Barrio o vereda |
| `DPTO` | Departamento |
| `MUNICIPIO` | Municipio |
| `EPS` | EPS o aseguradora |
| `FECHA` | Fecha de registro |
| `Discapacidad` | Tiene discapacidad (Sí/No) |
| `Adulto mayor` | Es adulto mayor (Sí/No) |

> 💡 Los nombres con **dobles espacios** (ej. `"PAOLA  CALLE LOBO"`) se interpretan como separador entre nombres y apellidos.

---

## ⌨️ Atajos de Teclado

| Atajo | Acción |
|-------|--------|
| `Alt + Shift + P` | Mostrar / ocultar el panel |
| `Alt + Shift + F` | Autocompletar el formulario actual |

---

## 🧪 Prueba local

Incluye un archivo de prueba `test-siaps-mock.html` que simula un formulario complejo de SI-APS con:
- Selects en cascada (Departamento → Municipio)
- Campos con `minlength`, `maxlength`
- Radio buttons y checkboxes
- Textareas con validación
- Campos de fecha, numéricos, etc.

Para probarlo:
1. Abre `test-siaps-mock.html` directamente en Chrome (doble clic o `Ctrl+O`).
2. Carga un Excel de prueba desde el panel.
3. Presiona `Alt + Shift + F` y verifica que todos los campos se llenen correctamente.

---

## 📁 Estructura del proyecto

```
siaps-autofill-extension/
├── manifest.json              # Configuración de la extensión (Manifest V3)
├── background.js              # Service worker (atajos, ícono)
├── content.js                 # Orquestador (inicializa módulos)
├── modules/
│   ├── excel-parser.js        # Parseo y limpieza del Excel
│   ├── autofill-engine.js     # Motor de autocompletado inteligente
│   ├── panel-ui.js            # Panel flotante con Shadow DOM
│   └── panel.css              # Estilos del panel
├── libs/
│   └── xlsx.full.min.js       # SheetJS (procesamiento de Excel, local)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── test-siaps-mock.html       # Formulario de prueba
└── README.md                  # Esta documentación
```

---

## ⚠️ Notas importantes

- La extensión **NUNCA** envía datos a servidores externos.
- La extensión **NUNCA** hace clic automático en botones de "Guardar" o "Enviar".
- Siempre **revisa los campos** antes de guardar manualmente.
- El progreso (pacientes cargados, completados, configuración) se guarda en el almacenamiento local del navegador y persiste entre recargas de página.
- Si necesitas limpiar todo el almacenamiento, usa el botón "🗑️ Limpiar toda la información" en la pestaña Config.

---

## 🔧 Personalización futura

Usa el botón **"🗺️ Exportar mapa de campos"** en cualquier formulario de SI-APS para obtener un JSON con la estructura exacta de los campos. Esto te permite afinar las reglas de autocompletado para pantallas específicas.

---

**Versión:** 1.0.0  
**Licencia:** Uso interno
