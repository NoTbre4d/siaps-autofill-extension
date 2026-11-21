/**
 * SI-APS AutoFill — ExcelParser
 *
 * Parsea archivos XLSX usando SheetJS (empaquetado localmente).
 * - Busca la hoja "Informe completo" o usa la primera disponible.
 * - Normaliza nombres, deduplica por NUMERO ID.
 * - Genera campos de nombre separados con heurísticas.
 *
 * API pública:
 *   ExcelParser.loadFile(file: File) -> Promise<{ patients, duplicatesRemoved, warnings }>
 */

// eslint-disable-next-line no-unused-vars
class ExcelParser {

  /* ───────── Columnas esperadas ───────── */
  static COLUMN_MAP = {
    'NOMBRE DEL USUARIO':   'nombreRaw',
    'TIPO ID':              'tipoId',
    'NUMERO ID':            'numeroId',
    'DIRECCION DEL USUARIO':'direccion',
    'TELEFONO DE USUARIO':  'telefono',
    'BARRIO/VEREDA':        'barrio',
    'DPTO':                 'departamento',
    'MUNICIPIO':            'municipio',
    'EPS':                  'eps',
    'FECHA':                'fecha',
    'Discapacidad':         'discapacidad',
    'Adulto mayor':         'adultoMayor',
  };

  /* ───────── Punto de entrada ───────── */
  static async loadFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const result = ExcelParser._processWorkbook(e.target.result);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      reader.readAsArrayBuffer(file);
    });
  }

  /* ───────── Procesamiento interno ───────── */
  static _processWorkbook(data) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) no está cargado. Revisa que libs/xlsx.full.min.js exista.');
    }

    const wb = XLSX.read(data, { type: 'array', cellDates: true });

    // Buscar la hoja "Informe completo" o usar la primera
    let sheetName = wb.SheetNames.find(
      (n) => n.trim().toLowerCase() === 'informe completo'
    );
    if (!sheetName) sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('El archivo Excel no tiene hojas.');

    const sheet = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rawRows.length === 0) {
      throw new Error(`La hoja "${sheetName}" está vacía.`);
    }

    // Mapear columnas (tolerante a espacios y mayúsculas)
    const headerMap = ExcelParser._buildHeaderMap(rawRows[0]);

    const warnings = [];
    const seen = new Map(); // NUMERO ID -> index
    const patients = [];
    let duplicatesRemoved = 0;

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const patient = ExcelParser._mapRow(raw, headerMap);

      if (!patient.numeroId && !patient.nombreRaw) continue; // fila vacía

      // Limpiar NUMERO ID: tratar como string sin decimales
      patient.numeroId = ExcelParser._cleanNumeroId(patient.numeroId);

      // Normalizar nombre
      patient.nombreRaw = (patient.nombreRaw || '').toString();
      const nameResult = ExcelParser._parseName(patient.nombreRaw);
      Object.assign(patient, nameResult);

      // Normalizar fecha
      patient.fecha = ExcelParser._normalizeDate(patient.fecha);

      // Limpiar strings
      for (const key of ['direccion', 'telefono', 'barrio', 'departamento',
                          'municipio', 'eps', 'discapacidad', 'adultoMayor', 'tipoId']) {
        if (patient[key] != null) {
          patient[key] = patient[key].toString().trim();
        }
      }

      // Deduplicar por NUMERO ID
      if (patient.numeroId && seen.has(patient.numeroId)) {
        duplicatesRemoved++;
        warnings.push(
          `Fila ${i + 2}: NUMERO ID "${patient.numeroId}" duplicado (ya en fila ${seen.get(patient.numeroId) + 2}). Se omitió.`
        );
        continue;
      }

      if (patient.numeroId) seen.set(patient.numeroId, i);

      patient._rowIndex = i + 2; // Fila Excel (1-indexed + header)
      patients.push(patient);
    }

    return { patients, duplicatesRemoved, warnings, sheetName };
  }

  /* ───────── Mapeo de headers tolerante ───────── */
  static _buildHeaderMap(sampleRow) {
    const normalize = (s) => s.toString().trim().replace(/\s+/g, ' ').toUpperCase();
    const keys = Object.keys(sampleRow);
    const map = {};

    for (const [expected, field] of Object.entries(ExcelParser.COLUMN_MAP)) {
      const normExpected = normalize(expected);
      const found = keys.find((k) => normalize(k) === normExpected);
      if (found) {
        map[field] = found; // key real del JSON
      } else {
        // Búsqueda parcial (contiene)
        const partial = keys.find((k) => normalize(k).includes(normExpected) || normExpected.includes(normalize(k)));
        if (partial) map[field] = partial;
      }
    }
    return map;
  }

  static _mapRow(raw, headerMap) {
    const result = {};
    for (const [field, excelKey] of Object.entries(headerMap)) {
      result[field] = raw[excelKey] ?? '';
    }
    return result;
  }

  /* ───────── Limpieza de NUMERO ID ───────── */
  static _cleanNumeroId(val) {
    if (val == null || val === '') return '';
    // Si es número, quitar decimales
    if (typeof val === 'number') {
      return Math.floor(val).toString();
    }
    // Si es string, quitar puntos/comas/decimales
    return val.toString().replace(/[.,]\d*$/, '').replace(/\s/g, '').trim();
  }

  /* ───────── Parseo inteligente de nombre ───────── */
  static _parseName(rawName) {
    // Detectar dobles espacios ANTES de normalizar (pista para separar)
    const hasDoubleSpace = /\s{2,}/.test(rawName);

    // Normalizar espacios
    const cleaned = rawName.replace(/\s+/g, ' ').trim();

    const result = {
      nombreCompleto: cleaned,
      primerNombre: '',
      segundoNombre: '',
      primerApellido: '',
      segundoApellido: '',
    };

    if (!cleaned) return result;

    // Si hay doble espacio, el formato podría ser "NOMBRES  APELLIDOS"
    if (hasDoubleSpace) {
      const parts = rawName.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);

      if (parts.length === 2) {
        // "YENIFER  CABALLERO" o "PAOLA ANDREA  CALLE LOBO"
        const nombres = parts[0].split(/\s+/);
        const apellidos = parts[1].split(/\s+/);

        result.primerNombre = nombres[0] || '';
        result.segundoNombre = nombres.slice(1).join(' ') || '';
        result.primerApellido = apellidos[0] || '';
        result.segundoApellido = apellidos.slice(1).join(' ') || '';
        return result;
      }
    }

    // Sin pista de doble espacio: heurística por número de palabras
    const words = cleaned.split(/\s+/);

    switch (words.length) {
      case 1:
        result.primerNombre = words[0];
        break;
      case 2:
        // Nombre Apellido
        result.primerNombre = words[0];
        result.primerApellido = words[1];
        break;
      case 3:
        // Nombre ApellidoP ApellidoM
        result.primerNombre = words[0];
        result.primerApellido = words[1];
        result.segundoApellido = words[2];
        break;
      case 4:
        // NombreP NombreS ApellidoP ApellidoM
        result.primerNombre = words[0];
        result.segundoNombre = words[1];
        result.primerApellido = words[2];
        result.segundoApellido = words[3];
        break;
      default:
        // 5+ palabras: primeros 2 nombres, resto apellidos
        result.primerNombre = words[0];
        result.segundoNombre = words[1];
        result.primerApellido = words[2];
        result.segundoApellido = words.slice(3).join(' ');
        break;
    }

    return result;
  }

  /* ───────── Normalización de fecha ───────── */
  static _normalizeDate(val) {
    if (!val) return '';
    // Si ya es Date (SheetJS cellDates: true)
    if (val instanceof Date) {
      return ExcelParser._formatDate(val);
    }
    // Si es número serial de Excel
    if (typeof val === 'number') {
      const date = new Date((val - 25569) * 86400 * 1000);
      return ExcelParser._formatDate(date);
    }
    // Si es string con formato DD/MM/YYYY o similar
    const str = val.toString().trim();
    const match = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
    if (match) {
      const day = match[1].padStart(2, '0');
      const month = match[2].padStart(2, '0');
      let year = match[3];
      if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
      return `${year}-${month}-${day}`;
    }
    // Si ya es YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
    return str;
  }

  static _formatDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

console.log('[SI-APS] ExcelParser cargado.');
