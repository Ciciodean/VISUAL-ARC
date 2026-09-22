/**
 * AAMVA PDF417 payload builder + parser
 * --------------------------------------
 * Builds spec-compliant AAMVA DL/ID barcode payloads per the AAMVA
 * Card Design Standard (versions 02-10, i.e. 2003-2020), and parses
 * them back for round-trip verification.
 *
 * Payload structure:
 *   "@" LF RS CR "ANSI " IIN(6) AAMVAver(2) JurVer(2) NumEntries(2)
 *   [Designator(2) Offset(4) Length(4)] x NumEntries
 *   Subfile1: Designator + Element LF Element LF ... CR
 *   Subfile2: ...
 *
 * Offsets are 0-based from the "@". Lengths include the designator
 * prefix and the trailing CR.
 */
(function (global) {
  'use strict';

  var LF = '\n';
  var RS = '\x1e';
  var CR = '\r';
  var HEADER_MAGIC = '@' + LF + RS + CR + 'ANSI ';

  // AAMVA barcode version indicator -> Card Design Standard year
  var AAMVA_VERSIONS = {
    '01': 2000,
    '02': 2003,
    '03': 2005,
    '04': 2009,
    '05': 2010,
    '06': 2011,
    '07': 2012,
    '08': 2013,
    '09': 2016,
    '10': 2020
  };

  // Human-readable labels for the standard (non-jurisdiction) elements
  var ELEMENT_LABELS = {
    DAA: 'Full Name (legacy v1)',
    DAB: 'Family Name (legacy v1)',
    DAC: 'Given Name',
    DAD: 'Middle Name(s)',
    DAK: 'Postal Code',
    DAQ: 'DL/ID Number',
    DAU: 'Height',
    DAW: 'Weight (lbs)',
    DAY: 'Eye Color',
    DAZ: 'Hair Color',
    DAG: 'Street Address',
    DAH: 'Street Address 2',
    DAI: 'City',
    DAJ: 'Address State',
    DCA: 'Vehicle Classification',
    DCB: 'Restriction Codes',
    DCD: 'Endorsement Codes',
    DCS: 'Family Name',
    DCT: 'Customer Given Names (v3)',
    DCU: 'Name Suffix',
    DDB: 'Card Revision Date',
    DCF: 'Document Discriminator',
    DCG: 'Issuing Country',
    DCK: 'Inventory Control Number',
    DBA: 'Expiration Date',
    DBB: 'Date of Birth',
    DBC: 'Sex',
    DBD: 'Issue Date',
    DDE: 'Family Name Truncation',
    DDF: 'Given Name Truncation',
    DDG: 'Middle Name Truncation',
    DCI: 'Place of Birth',
    DCJ: 'Audit Information'
  };

  // Elements expected on a well-formed DL/ID subfile (v02+).
  // Each inner array is a group: at least ONE member must be present.
  var MANDATORY_GROUPS = [
    ['DCS', 'DAA', 'DAB'],   // family name
    ['DAC', 'DCT', 'DAA'],   // given name
    ['DBA'],                 // expiration
    ['DBB'],                 // date of birth
    ['DBC'],                 // sex
    ['DAU'],                 // height
    ['DAY'],                 // eye color
    ['DAG'],                 // street address
    ['DAI'],                 // city
    ['DAJ'],                 // state
    ['DAK'],                 // postal code
    ['DAQ'],                 // DL/ID number
    ['DCF'],                 // document discriminator
    ['DCG']                  // country
  ];

  // Maximum field lengths per the standard (defensive truncation)
  var MAX_LEN = {
    DCS: 40, DAC: 40, DAD: 40, DCT: 40,
    DCU: 5, DCA: 6, DCB: 12, DCD: 5,
    DAG: 35, DAH: 35, DAI: 20, DAJ: 2,
    DAQ: 25, DCF: 25, DCK: 25,
    DAY: 3, DAZ: 3, DCG: 3
  };

  /** Uppercase, strip control characters, collapse whitespace. */
  function clean(value, maxLen) {
    var s = String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[\u0000-\u001f\u007f]/g, ' ')  // LF/CR/RS etc. must never enter a field
      .replace(/\s+/g, ' ')
      .trim();
    if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
    return s;
  }

  /**
   * Accepts 'YYYY-MM-DD', 'MM/DD/YYYY', 'MMDDYYYY', or 'YYYYMMDD'.
   * Pure string handling: no Date object, so no timezone off-by-one.
   * Returns 'MMDDYYYY' (8 digits).
   */
  function fmtAAMVADate(iso) {
    if (!iso) return '';
    var s = String(iso).trim();
    var cleanDigits = s.replace(/\D/g, '');
    if (cleanDigits.length === 8) {
      if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(cleanDigits)) {
        return cleanDigits.substring(4, 6) + cleanDigits.substring(6, 8) + cleanDigits.substring(0, 4);
      }
      return cleanDigits;
    }
    var m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (m1) {
      var mm1 = m1[2].length === 1 ? '0' + m1[2] : m1[2];
      var dd1 = m1[3].length === 1 ? '0' + m1[3] : m1[3];
      return mm1 + dd1 + m1[1];
    }
    var m2 = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m2) {
      var mm2 = m2[1].length === 1 ? '0' + m2[1] : m2[1];
      var dd2 = m2[2].length === 1 ? '0' + m2[2] : m2[2];
      return mm2 + dd2 + m2[3];
    }
    return '';
  }

  /** Random numeric document discriminator (synthetic, 20 digits). */
  function randomDD() {
    var s = '';
    for (var i = 0; i < 20; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  /**
   * Build an AAMVA payload.
   *
   * opts = {
   *   iin:                   '636001'           (6-digit Issuer Identification Number)
   *   aamvaVersion:          '02'..'10'
   *   jurisdictionVersion:   '00'..'99'         (default '01')
   *   docType:               'DL' | 'ID'        (subfile designator)
   *   lastName, firstName, middleName, suffix,  (names)
   *   dob, issueDate, expirationDate,           ('YYYY-MM-DD')
   *   sex:                   '1' | '2' | '9'
   *   heightInches:          48..96
   *   weightLbs:             optional
   *   eyeColor:              'BRO' etc.
   *   hairColor:             optional
   *   street1, street2, city, state, zip,       (zip = 5 or 9 digits)
   *   licenseNumber, vehicleClass, restrictions, endorsements,
   *   documentDiscriminator: optional (auto-generated if omitted)
   * }
   *
   * Returns { raw, header, subfiles, elementCount, totalLength, warnings }.
   */
  function buildAAMVA(opts) {
    var warnings = [];
    opts = opts || {};

    var iin = String(opts.iin || '').replace(/\D/g, '');
    if (iin.length !== 6) throw new Error('Issuer ID (IIN) must be exactly 6 digits.');
    if (!/^\d{2}$/.test(opts.aamvaVersion || '')) throw new Error('AAMVA version must be 2 digits.');
    var aamvaVersion = opts.aamvaVersion;
    if (!AAMVA_VERSIONS[aamvaVersion] || aamvaVersion === '01') {
      throw new Error('Unsupported AAMVA version: ' + aamvaVersion + ' (use 02-10).');
    }

    var jurisdictionVersion = (String(opts.jurisdictionVersion || '01').replace(/\D/g, '') || '01');
    jurisdictionVersion = jurisdictionVersion.length === 1 ? '0' + jurisdictionVersion : jurisdictionVersion.substring(0, 2);

    var docType = opts.docType === 'ID' ? 'ID' : 'DL';

    // v02/v03 encode given names in DCT (first + middle combined);
    // v04+ split them into DAC + DAD with truncation indicators (DDE/DDF/DDG).
    var legacyNames = (aamvaVersion === '02' || aamvaVersion === '03');

    // ---- element helpers -------------------------------------------------
    function element(id, value) {
      var v = clean(value, MAX_LEN[id]);
      return v ? id + v : null;
    }

    var dcsRaw = clean(opts.lastName, 0);
    var dacRaw = clean(opts.firstName, 0);
    var dadRaw = clean(opts.middleName, 0);
    var dcs = clean(opts.lastName, MAX_LEN.DCS);
    var dad = clean(opts.middleName, MAX_LEN.DAD);

    var els = [];
    function push(id, value) { var e = element(id, value); if (e) els.push(e); }

    push('DAQ', opts.licenseNumber);

    if (dcs) {
      els.push('DCS' + dcs);
      if (!legacyNames) els.push('DDE' + (dcsRaw.length > MAX_LEN.DCS ? 'T' : 'N'));
    }
    if (legacyNames) {
      // DCT = "Customer Given Names": first + middle together
      var dct = clean([opts.firstName, opts.middleName].filter(Boolean).join(' '), MAX_LEN.DCT);
      if (dct) els.push('DCT' + dct);
    } else {
      if (dacRaw) {
        els.push('DAC' + clean(opts.firstName, MAX_LEN.DAC));
        els.push('DDF' + (dacRaw.length > MAX_LEN.DAC ? 'T' : 'N'));
      }
      if (dad) {
        els.push('DAD' + dad);
        els.push('DDG' + (dadRaw.length > MAX_LEN.DAD ? 'T' : 'N'));
      }
    }
    push('DCU', opts.suffix);
    push('DCA', opts.vehicleClass);
    push('DCB', opts.restrictions);
    push('DCD', opts.endorsements);
    push('DBD', fmtAAMVADate(opts.issueDate));
    push('DBB', fmtAAMVADate(opts.dob));
    push('DBA', fmtAAMVADate(opts.expirationDate));

    var sex = String(opts.sex || '');
    if (['1', '2', '9'].indexOf(sex) === -1) {
      warnings.push('Sex "' + sex + '" is not a valid code (1, 2 or 9) - element omitted.');
    } else {
      els.push('DBC' + sex);
    }

    var heightInches = parseInt(opts.heightInches, 10);
    if (!isNaN(heightInches) && heightInches > 0) {
      var h = String(Math.min(96, heightInches));
      while (h.length < 3) h = '0' + h;
      els.push('DAU' + h + ' in');
    } else {
      warnings.push('Height missing or invalid - DAU omitted.');
    }

    var weightLbs = parseInt(opts.weightLbs, 10);
    if (!isNaN(weightLbs) && weightLbs > 0) {
      els.push('DAW' + weightLbs + ' lb');
    }

    push('DAY', opts.eyeColor);
    push('DAZ', opts.hairColor);
    push('DAG', opts.street1 || opts.address1);
    push('DAH', opts.street2 || opts.address2);
    push('DAI', opts.city);
    push('DAJ', opts.state);
    if (opts.zip) {
      var zip = String(opts.zip).replace(/\D/g, '');
      if (zip.length === 5 || zip.length === 9) {
        els.push('DAK' + zip);
      } else {
        warnings.push('ZIP must be 5 or 9 digits (got ' + zip.length + ') - DAK omitted.');
      }
    } else {
      warnings.push('ZIP missing - DAK omitted.');
    }
    push('DCF', opts.documentDiscriminator || randomDD());
    els.push('DCG' + (opts.country || 'USA'));
    push('DDA', opts.realId || 'F');

    // ---- assemble subfile ------------------------------------------------
    // Subfile = designator + element LF element LF ... + CR
    var subfileData = docType + els.join(LF) + CR;

    // ---- assemble header -------------------------------------------------
    var numEntries = '01';
    var offset1 = HEADER_MAGIC.length + 6 + 2 + 2 + 2 + (10 * 1); // = 31
    var length1 = subfileData.length;
    var header =
      HEADER_MAGIC +
      iin +
      aamvaVersion +
      jurisdictionVersion +
      numEntries +
      docType + pad4(offset1) + pad4(length1);

    var raw = header + subfileData;

    return {
      raw: raw,
      header: {
        magic: HEADER_MAGIC,
        iin: iin,
        aamvaVersion: aamvaVersion,
        aamvaYear: AAMVA_VERSIONS[aamvaVersion],
        jurisdictionVersion: jurisdictionVersion,
        numberOfEntries: 1,
        designators: [{ designator: docType, offset: offset1, length: length1 }]
      },
      subfiles: [{
        designator: docType,
        offset: offset1,
        length: length1,
        elements: els.map(function (e) { return { id: e.substring(0, 3), value: e.substring(3) }; })
      }],
      elementCount: els.length,
      totalLength: raw.length,
      warnings: warnings
    };
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  /**
   * Parse an AAMVA payload back into its structure.
   * Returns { valid, errors[], header, subfiles, elementCount, totalLength }.
   */
  function parseAAMVA(raw, opts) {
    var lenient = !!(opts && opts.lenient);
    var errors = [];
    var warnings = [];
    raw = String(raw == null ? '' : raw);

    if (raw.substring(0, 9) !== HEADER_MAGIC) {
      errors.push('Header magic "@LF RS CR ANSI " not found at byte 0.');
      return { valid: false, errors: errors, warnings: warnings, header: null, subfiles: [], elementCount: 0, totalLength: raw.length };
    }

    var pos = HEADER_MAGIC.length; // 9
    var iin = raw.substring(pos, pos + 6); pos += 6;
    var aamvaVersion = raw.substring(pos, pos + 2); pos += 2;
    var jurisdictionVersion = raw.substring(pos, pos + 2); pos += 2;
    var numEntries = parseInt(raw.substring(pos, pos + 2), 10); pos += 2;

    if (!/^\d{6}$/.test(iin)) errors.push('IIN is not 6 digits: "' + iin + '"');
    if (isNaN(numEntries) || numEntries < 1 || numEntries > 9) errors.push('Number of entries invalid: "' + numEntries + '"');
    if (aamvaVersion === '01') errors.push('Version 01 payloads use a legacy element set and are not fully parsed.');

    var designators = [];
    for (var i = 0; i < numEntries; i++) {
      var d = raw.substring(pos, pos + 2);
      var off = parseInt(raw.substring(pos + 2, pos + 6), 10);
      var len = parseInt(raw.substring(pos + 6, pos + 10), 10);
      pos += 10;
      designators.push({ designator: d, offset: off, length: len });
      if (isNaN(off) || isNaN(len)) errors.push('Subfile ' + (i + 1) + ' (' + d + '): offset/length are not numeric.');
    }

    var subfiles = [];
    var elementCount = 0;
    for (var j = 0; j < designators.length; j++) {
      var des = designators[j];
      if (isNaN(des.offset) || isNaN(des.length)) continue;
      var chunk = raw.substring(des.offset, des.offset + des.length);
      if (chunk.length !== des.length) {
        errors.push('Subfile ' + des.designator + ': declared length ' + des.length + ' exceeds payload.');
      }
      if (chunk.substring(0, 2) !== des.designator) {
        errors.push('Subfile at offset ' + des.offset + ' does not start with designator "' + des.designator + '".');
      }
      if (chunk.charAt(chunk.length - 1) !== CR) {
        var msg = 'Subfile ' + des.designator + ' is not terminated by CR.';
        if (lenient) { warnings.push(msg); } else { errors.push(msg); }
      }
      var body = chunk.charAt(chunk.length - 1) === CR
        ? chunk.substring(2, chunk.length - 1)
        : chunk.substring(2);
      var parts = body.split(LF);
      var elements = [];
      for (var k = 0; k < parts.length; k++) {
        if (!parts[k]) continue;
        var id = parts[k].substring(0, 3);
        var val = parts[k].substring(3);
        if (!/^[A-Z]{3}$/.test(id)) {
          errors.push('Invalid element ID "' + id + '" in subfile ' + des.designator + '.');
        }
        elements.push({ id: id, value: val });
      }
      elementCount += elements.length;
      subfiles.push({ designator: des.designator, offset: des.offset, length: des.length, elements: elements });
    }

    // Cross-check: subfiles should tile the payload without gaps
    var covered = 0;
    for (var c = 0; c < subfiles.length; c++) covered += subfiles[c].length;
    if (pos + covered !== raw.length) {
      errors.push('Offset/length table does not cover the payload exactly (header ' + pos +
        ' + subfiles ' + covered + ' != total ' + raw.length + ').');
    }

    // Mandatory element coverage (at least one member per group)
    var present = {};
    subfiles.forEach(function (s) {
      s.elements.forEach(function (e) { present[e.id] = true; });
    });
    var missing = [];
    MANDATORY_GROUPS.forEach(function (group) {
      if (!group.some(function (id) { return present[id]; })) missing.push(group[0]);
    });
    if (missing.length) errors.push('Missing mandatory elements: ' + missing.join(', ') + '.');

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      header: {
        iin: iin,
        aamvaVersion: aamvaVersion,
        aamvaYear: AAMVA_VERSIONS[aamvaVersion] || null,
        jurisdictionVersion: jurisdictionVersion,
        numberOfEntries: numEntries,
        designators: designators
      },
      subfiles: subfiles,
      elementCount: elementCount,
      totalLength: raw.length
    };
  }

  /** Raw payload with visible control characters (for the raw-data view). */
  function prettyRaw(raw) {
    return String(raw)
      .replace(/\x1e/g, '\u241e')  // RS
      .replace(/\r/g, '\u240d')    // CR
      .replace(/\n/g, '\n\u240a'); // LF -> newline + visible symbol
  }

  /** Raw payload with control chars escaped as text (\n, \r, \x1e). */
  function escapedRaw(raw) {
    return String(raw)
      .replace(/\x1e/g, '\\x1e')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }

  var api = {
    buildAAMVA: buildAAMVA,
    parseAAMVA: parseAAMVA,
    prettyRaw: prettyRaw,
    escapedRaw: escapedRaw,
    randomDD: randomDD,
    fmtAAMVADate: fmtAAMVADate,
    AAMVA_VERSIONS: AAMVA_VERSIONS,
    ELEMENT_LABELS: ELEMENT_LABELS,
    MANDATORY_GROUPS: MANDATORY_GROUPS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.AAMVA = api;
})(typeof window !== 'undefined' ? window : globalThis);
