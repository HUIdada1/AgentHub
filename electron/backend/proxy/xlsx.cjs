// 反代网关 · 最小 xlsx 写入器（纯 Node，复用 zip.createZip；无第三方依赖）。
// xlsx = OOXML 包：[Content_Types].xml + _rels/.rels + workbook + worksheet 五个 XML 部件。
// 单元格一律 inlineStr 文本（无公式 / 无样式依赖），Excel 与 WPS 直接打开；
// 数字单元格用 <v> 原生数值（Excel 可参与排序/求和），其余按文本。
// 使用方：proxy_oplog_export（操作日志导出 Excel）。
"use strict";
const zip = require("../zip.cjs");

/** XML 文本转义 + XML 1.0 不允许的控制字符剔除 */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]))
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/** 列号 → 字母（0→A, 25→Z, 26→AA） */
function colLetter(n) {
  let s = "";
  n = Math.floor(n);
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** 行列（0 起）→ 单元格引用（A1 形态） */
function cellRef(r, c) {
  return `${colLetter(c)}${r + 1}`;
}

/**
 * buildXlsx({ sheetName, headers, rows, widths }) → Buffer（.xlsx 文件字节）
 * headers: string[]；rows: (string|number|null|undefined)[][]；widths: number[]（可选列宽）
 */
function buildXlsx({ sheetName = "Sheet1", headers = [], rows = [], widths = [] } = {}) {
  const headXml = `<row r="1">${headers
    .map((h, c) => `<c r="${cellRef(0, c)}" t="inlineStr"><is><t>${esc(h)}</t></is></c>`)
    .join("")}</row>`;
  const bodyXml = rows
    .map((row, ri) => {
      const r = ri + 1;
      return `<row r="${r + 1}">${row
        .map((v, c) => {
          if (v == null || v === "") return "";
          if (typeof v === "number" && Number.isFinite(v)) return `<c r="${cellRef(r, c)}"><v>${v}</v></c>`;
          return `<c r="${cellRef(r, c)}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join("")}</row>`;
    })
    .join("");
  const colsXml = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${headXml}${bodyXml}</sheetData></worksheet>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  return zip.createZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
  ]);
}

module.exports = { buildXlsx };
